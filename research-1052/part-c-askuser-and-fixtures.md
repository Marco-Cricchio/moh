# Baseline — `pty-layout`, i quattro test ask-user e i fixture (ticket #1055)

Fonte: ricognizione sul repo a `develop`. Trascrizione, non sintesi.

## 0. Inventario

| file | describe (verbatim) | test | timeout bun | righe |
|---|---|---|---|---|
| `pty-layout.test.ts` | `describe.skipIf(!hasPython)("PTY layout (issues #64/#65)", …)` | **6** | `30000` ciascuno | 169 |
| `ask-user-invalid-then-valid.pty.test.ts` | `describe.skipIf(!hasPython)("ask_user invalid-then-valid (PTY regression)", …)` | **1** | `70_000` | 84 |
| `ask-user-large-turn.pty.test.ts` | `describe.skipIf(!hasPython)("ask_user modal with a large open turn (PTY regression)", …)` | **1** | `70_000` | 75 |
| `ask-user-oversized.pty.test.ts` | `describe.skipIf(!hasPython)("ask_user box taller than the viewport (PTY regression #622)", …)` | **1** | `70_000` | 82 |
| `long-session-ask.pty.test.ts` | `describe.skipIf(!hasPython)("long-session ask_user gate (PTY regression #874)", …)` | **1** | `90_000` | 79 |

Totale: **10 test** su 5 file. `hasPython = Bun.which("python3") !== null` (`pty-runner.ts:37-39`); ogni test è saltato senza `python3`.

Fixture in `packages/tui/test/pty/`: `fake-openai.ts` (usato da `ask-user-large-turn`), `fake-openai-invalid-ask.ts`, `fake-openai-oversized-ask.ts`, `fake-openai-long-session-ask.ts`. Harness: `harness.py` (680 righe) guidato da `pty-runner.ts`.

## 1. Vocabolario del harness — campi accettati dal runner/harness

**Campi dello spec (`PtySpec`)**

| campo | tipo | significato (note verbatim) | usato dai 10 test |
|---|---|---|---|
| `cols` | number | larghezza iniziale del pty | sì (tutti) |
| `rows` | number | altezza iniziale | sì (tutti) |
| `resize` | `{cols, rows, until?, untilWait?}` | "Optional mid-run resize; `until` names a readiness needle the post-resize repaint must reach before the harness stops pumping (#538 mid-frame flake)." `untilWait` default `10.0`. | solo `pty-layout` test 6 |
| `config` | `Record<string, unknown>` | "Optional user config written to the temp home's ~/.moh/config." | i 4 ask-user |
| `meta` | boolean | "When true, reports {lines, exited, exitCode} instead of bare lines." — **solo documentazione**: `runPtyRaw` manda sempre `{...spec, meta:true}` e il harness emette sempre l'oggetto completo | sempre forzato true |
| `project` | `Record<string, unknown>` | "Optional project moh.json written to the temp cwd." Fuso sul default `{"handoff":{"transport":"none"}}`. | large-turn, oversized, long-session |
| `rawDump` | string | "Optional path to dump the raw PTY byte stream." | i 4 ask-user |
| `env` | `Record<string, string>` | "Extra environment variables for the child (#490 image-preview detection: TERM_PROGRAM, KITTY_WINDOW_ID, …)" | nessuno |
| `files` | `Record<string, string>` | "Files written into the child's cwd (base64 name → content)" | nessuno |
| `seedSessions` | number | "#1023: number of seeded existing sessions in the temp project's session directory, so the Home list has rows." | nessuno |
| `steps` | `ReadonlyArray<Step>` | script di input | tutti |
| `tail` | number | "lines of stripped output to report" — ultime `tail` righe dello schermo fisico, sia per `lines` finale sia per `snapshot()` (default `rows`) | tutti |

**Campi di uno step (tutto il vocabolario accettato, `pty-runner.ts:32`)**

`{ wait?: number; send?: string; until?: string; untilOnScreen?: boolean; untilFromBuffer?: boolean; checkpoint?: string; mark?: boolean; markEnd?: boolean }`

Semantica per step (harness 577-603):

- con `until` → `pump_until(step.wait ?? 5.0, needle, since=len(buf), on_screen=untilOnScreen, entry_buffer=untilFromBuffer)`; uno step con **`until` e `send` insieme è rifiutato**: `raise ValueError("pty step: 'until' and 'send' are mutually exclusive")`. Il `wait` è il **budget**, non un sonno.
- senza `until` → `send(base64.b64decode(send))` (se presente) poi `pump(wait ?? 0.3)`.
- `mark: true` → `screen._close_frame(); screen.mark = len(screen.windows)` ("the frame being painted right now counts for the window that is closing, not for the one that opens here").
- `markEnd: true` → `screen._close_frame(); screen.markEnd = len(screen.windows)`.
- `checkpoint: "<name>"` → `checkpoints[name] = snapshot()` = `{lines: [{lead,width,text}], scrollback: [...]}` per le ultime `tail` righe.

Chiavi di protocollo solo-harness non nel tipo TS: `rawDump` e `resize.untilWait`. Manopole d'ambiente: `MOH_PTY_DUMP` (scrive i checkpoint in JSON), `MOH_SYNC_DEBUG`.

Altri utenti del vocabolario raro (fuori da questa baseline): `untilFromBuffer` → `markdown-live-continuity.pty.test.ts:47`; `mark`/`markEnd` → `streaming-persistence.pty.test.ts:145,147`; `checkpoint` → `typewriter-reveal`, `natural-scrollback:62`, `streaming-persistence` (369,374,431,536,690).

**Payload `meta` riportato** (harness 656-676):

```
{"lines": out, "scrollback": screen.scrollback_view, "checkpoints": checkpoints,
 "exited": proc.poll() is not None, "exitCode": proc.returncode, "aliveAtEnd": alive_at_end,
 "maxFrameRows": …, "frames": len(screen.frames), "fullscreenFrames": …,
 "framesAfterMark": len(window), "maxFrameRowsAfterMark": …, "fullscreenAfterMark": …}
```
`window = screen.windows[mark:end]`, `end = markEnd ?? len(windows)`; un repaint fullscreen è registrato come `(0, True)` e contato in `fullscreenFrames`, mai come altezza.

## 2. `pty-runner.ts` — ruolo, guardie e comportamenti su cui i test contano

**Ruolo.** Unico ponte dai test Bun a `harness.py`: lancia `python3 <harness.py> '{"…spec…","meta":true}'` e parsa **un oggetto JSON da stdout**. `runPty(spec)` → `(await runPtyRaw(spec)).lines`; `runPtyRaw(spec)` → `PtyMeta` intero.

**Guardie** (nessuna asserzione in senso bun-test; ogni consumatore le eredita):

| riga | guardia | effetto |
|---|---|---|
| 82 | `if (!python3) throw new Error("python3 not found on PATH")` | fallimento duro (i test normalmente saltano via `hasPython`) |
| 94 | `setTimeout(() => { timedOut = true; proc.kill("SIGKILL") }, 45_000)` | **budget del runner: 45 s** dallo spawn, copre boot + step + shutdown |
| 101 | `if (timedOut) throw new Error("pty harness timed out after 45000ms")` | uno step il cui budget divora quello del runner non produce payload |
| 102-104 | `if (exitCode !== 0) throw new Error(\`pty harness failed (${exitCode}): ${stderr}\`)` | i `RuntimeError` del harness (scadenza needle, crash, protocollo) emergono qui con lo stderr |
| 105 | `JSON.parse(stdout) as PtyMeta` | il contratto JSON |

**Comportamenti su cui i test contano.**

- **L'asincronia è portante** (`#236`): `Bun.spawn` + `await` (mai `spawnSync`) perché il loop del padre continui a servire i server SSE finti in-process; un'attesa bloccante affama il `fetch` del figlio ("model_call_start, then an infinite spinner; fake call count stays zero").
- **Nessun retry, nessun retry per step**, nessun log: uno spawn per chiamata (quindi `pty-layout` test 2 lancia la CLI due volte: baseline + settings).
- **Codifica**: `send` è base64 di byte grezzi, il contenuto di `files` è base64; stdout/stderr letti fino in fondo.
- **Marker**: `mark`/`markEnd` toccano solo i contatori della finestra di frame; nessuno di questi test li usa.
- **`untilFromBuffer` / `untilOnScreen`**: opt-in per accettare una needle **già vera all'ingresso** dello step (`buf.find(target) != -1 or visible()`); un `until` semplice richiede un match **dopo** `since = len(buf)` registrato all'ingresso. `visible()` guarda schermo fisico **e** scrollback.
- **Timeout interni**: budget `until` con uscita anticipata (default `5.0` se assente), `pump(2.5)` di boot, resize `pump(2.0)` + `untilWait` (default `10.0`), e una readiness scaduta che ora **solleva** `RuntimeError("pty readiness wait expired after {seconds}s: needle {needle!r} never appeared\n--- buffer tail ---…")`.
- **Shutdown**: `alive_at_end` campionato **prima** di SIGINT, poi `sleep(0.3)`, `terminate()`, `wait(2)`, `kill()`, `wait(1)`. Codici accettati: `0, None, -SIGINT, -SIGTERM, -9, -15`; altro → `RuntimeError("moh TUI crashed under the PTY harness (exit …)")` con gli ultimi 4000 char senza ANSI.
- Esporta `python3`/`hasPython` e `DEV_CONFIG`, `VIBE_CONFIG` (i quattro ask-user scrivono la stessa forma inline invece di importare `DEV_CONFIG`).

## 3. `pty-layout.test.ts` — 6 test

**Ruolo** (header verbatim): *"Headless Ink renders cannot validate viewport geometry, cursor windowing or resize behavior — these tests drive the actual CLI inside a pseudo terminal (see harness.py) at multiple sizes, including one compact size, covering home, chat, settings navigation and panel scrolling, plus a mid-session resize."* Importa `COMPOSER_COMPACT, COMPOSER_READY` da `../helpers` — **`COMPOSER_COMPACT` è importato e mai usato** (import morto).

Helper: `const B = (s: string) => btoa(s);` `const DOWN = B("\x1b[B");` e

```ts
// Standard preamble: skip onboarding, skip the workflow offer → home.
// Generous waits: a keystroke that lands after a screen transition can
// hit the wrong handler (e.g. "s" on home opens settings).
const PREAMBLE = [
  { wait: 1.0, send: B("s") },
  { wait: 1.0, send: B("n") },
];
```

### 3.1 `wide terminal: session is a frameless full-width scrollback column (#183)`
- `runPty({cols: 160, rows: 45, …, tail: 45})`.
- Script: `[...PREAMBLE, {wait:0.5}, {wait:0.3, send:"hello"}, {wait:0.2, send:"\r"}, {wait:1.0}, {wait:10.0, until: COMPOSER_READY}]`.
- Asserzioni: (1) `input` definito (`find` su `COMPOSER_READY`); (2) `gutter = input.text.indexOf("›") ≤ 3` (prompt a filo); (3) nessuna riga contiene `"Wayfinder"`; (4) qualche riga contiene `"model"`; (5) qualche riga `trim() === "› you"`; (6) per ogni riga del transcript (`hello` | `› you` | `◆ moh`) `not.toMatch(/[┌┐└┘╭╮╰╯]/)` (niente bordi); (7) per ogni riga `width ≤ 160` (45 iterazioni).
- Proprietà: transcript senza cornici, a tutta larghezza, in colonna di scrollback nativa.

### 3.2 `wide terminal: settings floats transparently without moving the live chat`
- `enterChat = [...PREAMBLE, {wait:0.5, send:"n"}, {wait:0.8}]`; due run a `cols:160, rows:45, tail:45`: A) `baseline = runPty({... enterChat})`; B) `steps: [...enterChat, {wait:0.8, send:"\x13"}, {wait:10.0, until:"Answer language", untilOnScreen:true}]` (`\x13` = ctrl+s).
- Asserzioni: (1)-(2) baseline ha riga composer e riga chip; (3) `inputRow(lines) === inputRow(baseline)`; (4) `chipsRow(lines) === chipsRow(baseline)`; (5) `title` definito (`"settings"`); (6)-(7) `top = findIndex(/╭─{97}╮/)` esiste ed è `< lines.length`; (8) `bottom = findIndex(text.indexOf("╰") >= 28)` è `> top`; (9) `dialogTitleRow === top + 1`; (10) `bottom < lines.length - 1`; (11) `|top - (lines.length - 1 - bottom)| ≤ 5` (centratura verticale ±5); (12)-(13) `border.width - dialogStart` (con `dialogStart = indexOf("╰")`) fra 97 e 101; (14) almeno 8 delle voci `["Mode","Theme","Icons","File preview","Answer language","Telemetry","Default permission mode","Provider"]` a schermo.
- Proprietà: l'overlay non sposta riga di input e chip (indici di riga uguali).

### 3.3 `short terminal: settings cursor stays visible at the bottom, no bleed`
- `cols: 80, rows: 20, tail: 20`; script `[...PREAMBLE, {wait:0.5}, {wait:0.8, send:"\x13"}, {wait:0.6, send: DOWN.repeat(9)}]`.
- Asserzioni: qualche riga contiene `"Remove provider"` (ultima voce raggiungibile); ogni riga `width ≤ 80` (20 iterazioni).

### 3.4 `compact width: settings dialog goes full width, rows never split`
- `cols: 50, rows: 20, tail: 20`; stesso script di 3.3.
- Asserzioni: `top` (riga con `"╭"`) definito; `top.width - top.lead ≥ 46` (dialogo ≥46 di 50 col); `/Default permission mode\s+normal/` su **una** riga; ogni riga `width ≤ 50`.

### 3.5 `short terminal: commands panel scrolls, every group reachable`
- `cols: 80, rows: 18, tail: 18`; script `[...PREAMBLE, {wait:0.5}, {wait:0.8, send:"?"}, {wait:0.8, send: DOWN.repeat(60)}]`.
- Asserzioni: qualche riga contiene `"Modals"`; qualche riga contiene `"↑ "`; ogni riga `width ≤ 80`.

### 3.6 `resize mid-session: live input and bottom bar reflow; printed scrollback remains native (#183)`
- `cols: 120, rows: 35`, **`resize: {cols: 80, rows: 24, until: COMPOSER_READY}`** (quindi `untilWait` 10 s), `tail: 24`.
- Script: `[...PREAMBLE, {wait:0.5}, {wait:0.3, send:"resize probe"}, {wait:0.2, send:"\r"}, {wait:1.5}]`. Poi il harness: `TIOCSWINSZ(80,24)` + `SIGWINCH`, nuovo `Screen(80,24)` che **conserva lo scrollback precedente**, `pump(2.0)`, `pump_until(10.0, COMPOSER_READY, since=len(buf))`.
- Asserzioni (commento: "The cumulative pty buffer still contains pre-resize frames: assert on the final frame only (from the last input line on)."): (1) `inputIdx ≥ 0` (reduce su `COMPOSER_READY`, seed `-1`); (2) `input.lead ≤ 2`; (3) `input.width ≤ 80`; (4) ogni riga da `inputIdx` in poi `width ≤ 80` (l'area viva post-resize; le righe statiche sopra restano alla vecchia larghezza); (5) fra quelle righe ce n'è una con `"model"` (la barra inferiore si è riflowata).
- Proprietà: l'input vivo riflowa, lo scrollback stampato resta nativo.

## 4. I quattro test ask_user

Forma comune: `runPtyRaw`, `try { … } finally { server.stop(true); }`, `config = { onboarded, workflowOffered, mode:"dev", provider:"fake", endpoints:[{name:"fake", type:"openai-compat", baseUrl:url, apiKey:"test-key", defaultModel:"fake-model"}] }`.

### 4.1 `ask-user-invalid-then-valid.pty.test.ts` — `arrows and typing stay responsive after a failed ask_user retry`
- Header (verbatim): *"Regression from session 20260902T020857899Z: navigation froze after an invalid ask_user was retried. The historical case used an oversized header; headers are now normalized, so this fixture uses one option (still invalid) followed by a valid two-question set."*
- `cols: 120, rows: 40`, `tail: 40`, `rawDump: "/tmp/moh-pty-ask-invalid-raw.bin"`, **nessun `project`**.
- Script (verbatim, con i commenti): `{wait:2.0}`, `{wait:0.3, send: <messaggio italiano lungo>}`, `{wait:0.4, send:"\r"}`, `{wait:30.0, until:"Q1 — which way?", untilOnScreen:true}`, poi una raffica: ↑, ↓, ↑, ↓, ↑↑, ↓↓, `x`, `y`, TAB, ↑, ↓, ↓↓, `z` (0.1–0.3 s fra l'uno, gli ultimi due a 2.0 s). Commento CI: *"The CI PTY batch runs two full TUI processes on a 2-vCPU runner. Leave enough wall time for the fake-provider retry to reach this readiness signal under that contention."* In totale: **13 step di send, 18 pressioni** (8 frecce, 1 tab, 3 char).
- Asserzioni:

| # | matcher | misura | proprietà |
|---|---|---|---|
| 1 | `validationError()).toContain("invalid arguments for ask_user:")` | richiesta registrata dal fixture (messaggio `role:"tool"`, `tool_call_id:"call_1_0"` visto alla chiamata 2) | il core ha rifiutato la domanda con 1 opzione e il modello ha ricevuto l'errore |
| 2 | `…toContain("questions.0.options")` | idem | il dettaglio zod nomina il percorso (`options` min 2) |
| 3 | `meta.aliveAtEnd === true` | `aliveAtEnd` | il figlio è sopravvissuto allo scenario di freeze |
| 4 | `raw.toContain("Q1 — which way?")` | dump | la prima domanda **valida** è arrivata a schermo dopo il retry |
| 5 | `raw.toContain("Q2 — how fast?")` | dump | la seconda domanda del set è stata dipinta |
| 6 | `lines.join("\n").toContain("z")` | schermo (ultime 40 righe) | un tasto inviato **dopo** la raffica è arrivato a schermo ("freeze = nulla cambia") |

- Invarianza non-PTY: il contratto di validazione (`askUserQuestionSchema.options` `.min(2).max(4)`) e il loop di retry.
- Pty necessario? Il freeze è una proprietà di **pipeline** (tasti in raw mode accodati dietro i render).

### 4.2 `ask-user-large-turn.pty.test.ts` — `arrows move the selection promptly and the process survives`
- Header (verbatim): *"Regression (session 20260825T062108113Z): with a large open turn, every 90ms spinner tick re-rendered the whole live transcript (unmemoized), so modal arrow keypresses queued behind renders (selection frozen) and memory climbed until macOS killed the process ("killed", SIGKILL/OOM). Assertions are on the RAW pty byte stream: the harness's Screen model is unreliable on huge repaint streams."*
- `cols: 120, rows: 40`, `tail: 40`, `rawDump: "/tmp/moh-pty-regression-raw.bin"`, `project: {permissions:{overrides:{tools:{bash:"allow"}}}}`.
- Script: `{wait:2.0}`, `{wait:0.3, send:"hello"}`, `{wait:0.4, send:"\r"}`, `{wait:45.0, until:"Q1 — which way?"}`, `{wait:0.3, send: DOWN}`, `{wait:1.5, send: DOWN}`, `{wait:1.5, send: DOWN}`, `{wait:4.0}`. Commento: *"45s: 'up to', not a fixed sleep — slow CI hosts (containerized runners with 2 vCPU) have been observed needing >15s (#630)."*
- Asserzioni: (1) `meta.aliveAtEnd === true` (commento: *"the real crash: SIGKILL ('killed') — meaningful because sampled pre-kill (#236)"*); (2) throw esplicito se `raw` non contiene `"Q1 — which way?"`, con diagnostica `aliveAtEnd/exited/exitCode` e coda del dump; (3) `raw.toContain("Other")` — le tre ↓ hanno raggiunto la riga sempre-ultima `… Other` (selezione mossa).
- Invarianza non-PTY: la selezione avanza di una riga per ↓ fino a `Other`, e il processo non muore per crescita di memoria.
- Pty necessario? La pressione di render reale e la memoria reale; il dump serve perché il modello Screen è inaffidabile su stream enormi.

### 4.3 `ask-user-oversized.pty.test.ts` — `oversized box renders stably — no clearTerminal churn while idle`
- Header (verbatim): *"Regression (#622): an ask_user box TALLER than the terminal viewport made the whole TUI flicker rapidly — Ink's fullscreen path (output >= rows) emits clearTerminal + fullStaticOutput + output on EVERY render, and a steady re-render trickle (typewriter reveal tick, composer cursor blink) kept frames flowing while the user was just reading the question. At ~20Hz the screen wiped and repainted too fast to read or scroll. The fix gates the reveal tick (it no longer runs while the input is blocked) and pauses the composer cursor blink while disabled, so the blocked state produces NO steady frame churn. The regression asserts that after the oversized box opens, an idle window emits only the bounded gate-open transition clears (not a continuous stream)."*
- `cols: 100, rows: 20` (commento: *"small viewport: the box below exceeds it"*), `tail: 20`, `rawDump: "/tmp/moh-pty-622-raw.bin"`, `project` con bash allow.
- Script: `{wait:2.0}`, `{wait:0.3, send:"hello"}`, `{wait:0.4, send:"\r"}`, `{wait:45.0, until:"tall box question", untilOnScreen:true}`, `{wait:8.0}` (finestra inattiva senza tasti).
- Asserzioni: (1) `aliveAtEnd === true`; (2) throw se `raw` non contiene `"tall box question"`; (3) `afterOpen = raw.slice(raw.indexOf("tall box question"))`, `churn = afterOpen.split("\x1b[2J\x1b[3J\x1b[H").length - 1` → `≤ 4` (la transizione di apertura del gate: pittura, flip dell'etichetta di fase, un render trailing throttled; lo stato stabile non ne emette).
- Invarianza non-PTY: **scheduling dei frame** — un TUI bloccato e inattivo non deve emettere repaint continui (il tick della reveal è gated, il blink è in pausa).
- Pty necessario? Il conteggio dipende dalla *decisione* di Ink fra log-update e fullscreen, derivata da `outputHeight >= stdout.rows`.

### 4.4 `long-session-ask.pty.test.ts` — `tall gate over a long transcript renders stably — no clearTerminal churn while idle`
- Header (verbatim): *"Regression (#874): with a LONG session, opening the inline ask_user gate still produced whole-viewport flicker even after the #622 timer fixes. Mechanism: Ink's fullscreen path — when the rendered output is at least the terminal height, every frame is clearTerminal + fullStaticOutput + output. #874 caps the sources: the ask block windows its option list, the subagent peek rides the volatile row budget, and idle-frame polls no-op or defer, so a blocked, idle TUI emits no churn even when the transcript alone is taller than the screen. Standard is the same as the #622 test: the bounded gate-open transition may clear a handful of times; the idle window must emit none."*
- `cols: 100, rows: 20` (commento: *"small viewport: the transcript alone exceeds it"*), `tail: 20`, `rawDump: "/tmp/moh-pty-874-raw.bin"`, `project` con bash allow.
- Script: `{wait:2.0}`, `{wait:0.3, send:"hi"}`, `{wait:0.4, send:"\r"}`, `{wait:8.0, until:"eiusmod tempor"}`, `{wait:12.0, until:"tall box question", untilOnScreen:true}`, `{wait:10.0}`. Commento: *"#1045: the old needle ('paragraph 5') never existed in the fixture — the wait burned its budget silently and the test only passed because the ask-gate step below re-checks on screen. Wait for a needle the fixture actually paints."*
- Asserzioni: (1) `aliveAtEnd === true`; (2) throw se manca `"tall box question"`; (3) `churn ≤ 4` dopo l'apertura, attraverso la transizione **e** i 10 s inattivi.

## 5. I fixture — cosa emette ciascuno, cadenza, hold, sequenza di retry

Tutti e quattro sono server `Bun.serve` openai-compat SSE in-process su `http://127.0.0.1:${port}/v1`. **Nessun timer, nessun `await sleep`, nessun hold**: ogni handler costruisce l'array di chunk e lo accoda in un solo burst dentro `ReadableStream.start()`, poi `data: [DONE]` e `close()`. La cadenza è quindi **quanto il trasporto consente**, una risposta HTTP per chiamata; tutto il ritmo visto dai test viene dagli step del harness e dai timer della reveal, non dai fixture. Ogni chunk è `data: ${JSON.stringify(chunk)}\n\n` con `object: "chat.completion.chunk"`, `id: "c${call}"`; gli id dei tool_call sono `call_${call}_${i}`. `finish_reason: "tool_calls"` quando emettono tool, altrimenti `"stop"`; solo `fake-openai.ts` e `fake-openai-invalid-ask.ts` aggiungono un chunk `"all set"` alla chiamata di stop.

| fixture | sequenza | payload per chiamata |
|---|---|---|
| `fake-openai.ts` (`startFakeOpenAi(port = 0)`) | `CHAIN = 15` (*"tool-chain length (< default 50 iteration cap)"*); `call ≤ 15` → `bash {command:"ls"}` + **20 chunk** di `LONG_TEXT = "Lorem ipsum … aliqua. ".repeat(40)`; `call === 16` → **quattro** `ask_user` in un blocco con `REAL_ASK` (*"the shape of the real failing session 20260825T062108113Z"*); `call ≥ 17` → `"all set"` + `stop` | 15 chiamate concatenate con ~20 × 5.3 KB di lorem, poi un blocco di 4 domande parallele |
| `fake-openai-invalid-ask.ts` (`startFakeOpenAi` + `validationError()`) | call 1 → `ask_user` con `INVALID_ASK` (**una sola opzione**, sotto `options.min(2)`); call 2 → **legge il body della richiesta**, cerca il messaggio `role:"tool"`, `tool_call_id:"call_1_0"` e **pretende** che contenga `"invalid arguments for ask_user:"` e `"questions.0.options"`; se no risponde **HTTP 400** `"Expected the first ask_user validation error before retry"`; se sì registra `validationError = result.content` ed emette `VALID_ASK` (`Q1 — which way?` / header `Route` / alpha·beta·gamma / `suggested:"alpha"`; `Q2 — how fast?` / header `Speed` / slow·fast / `suggested:"slow"`); call ≥ 3 → `"all set"` + `stop` | invalid → retry valido; il test non risponde mai |
| `fake-openai-oversized-ask.ts` (`startFakeOpenAiOversizedAsk`) | call 1 → `ask_user` con `TALL_ASK`: domanda `"tall box question — pick one route among many; this box is intentionally very tall so its rendered height must exceed the terminal viewport:"`, header `Route`, **4 opzioni** (route-0…route-3, ciascuna `description` = 12 righe unite di prosa) ; call ≥ 2 → `stop` senza tool | un solo gate sovradimensionato |
| `fake-openai-long-session-ask.ts` (`startFakeOpenAiLongSessionAsk`) | `CHAIN = 8`; `call ≤ 8` → `bash {command:"ls"}` + **8 chunk** di `LONG_TEXT` (*"Long prose per chain step: the settled transcript exceeds the viewport."*); `call === 9` → lo **stesso `TALL_ASK`**; `call ≥ 10` → `stop`, **senza** `"all set"` | 8 chiamate che costruiscono il transcript lungo, poi il gate alto |

`fake-openai.ts` e `fake-openai-invalid-ask.ts` hanno un blocco `import.meta.main` che avvia il server su 8787/8788 con `setInterval(() => {}, 1000)` per l'uso manuale; gli altri due no.

## 6. Dipendenza dal tempo (quantificata)

Costi fissi per `runPty`/`runPtyRaw`: **`pump(2.5)` di boot**, il `wait` di ogni step, shutdown `0.3 s` + fino a `2 s` + `1 s`, SIGKILL del runner a **45 000 ms** dallo spawn.

| test | somma dei wait fissi dopo il boot | budget di readiness | caso peggiore vs budget |
|---|---|---|---|
| pty-layout 3.1 | 1.0+1.0+0.5+0.3+0.2+1.0 = 4.0 s | `10.0` | ~2.5+4.0+10 = 16.5 s; **il timeout bun (30 s)** vince sul runner |
| pty-layout 3.2 | ~2.5 + 3.3 + 0.8 = 6.6 s | `10.0` | due figli; ~16.6 s per il run B |
| pty-layout 3.3 / 3.4 / 3.5 | 3.9 s | nessuno | ~6.4 s |
| pty-layout 3.6 | 4.5 s | resize `pump(2.0)` + `untilWait 10.0` | ~19 s |
| invalid-then-valid | 5.2 s (+6.3 dopo la readiness) | `30.0` | ≈41.5 s + shutdown ≈ **45 s, esattamente** il budget del runner |
| large-turn | 5.2 s (+7.3 dopo) | `45.0` | ≈**57.5 s > 45 s**: il harness muore prima di stampare → `pty harness timed out after 45000ms` |
| oversized | 13.2 s | `45.0` | ≈58.2 s, stesso eccesso |
| long-session | 35.2 s | `8.0` poi `12.0` | ≈38.5 s contro 45 s del runner e 90 s di bun |

Meccanismi temporali aggiuntivi:

1. **L'accounting dei frame dipende dai render completati.** `pump` campiona con `select(…, 0.05)` (≤20 Hz) e legge fino a 65 536 byte per volta; un frame è delimitato dai marker DECSET-2026 o da ED/EL(2) quando mancano. `frames`, `maxFrameRows`, `fullscreenFrames`, `framesAfterMark`, `fullscreenAfterMark`, `maxFrameRowsAfterMark` dipendono da quanti repaint ha completato l'host — ma **nessuno dei 10 test di questa baseline ne asserisce alcuno**.
2. **Regola di staleness di `lines()`**: se un sync block resta aperto >`2.0 s`, lo schermo riportato ricade da `sync_grid` alla grid viva. Rende `meta.lines`, `snapshot()` e `visible()` lievemente tempo-dipendenti.
3. **`until` è offset-based**: `since = len(buf)` all'ingresso, quindi la needle è soddisfatta solo da un'occorrenza **nuova** salvo opt-in; `pump_until` pompa `0.2 s` in più al match.
4. **Il budget di churn è una finestra temporale**: 8.0 s (oversized) / 10.0 s (long-session) devono produrre ≤4 occorrenze — una **asserzione di frequenza** mascherata (≈0.5 clear/s in transizione, 0 a regime; il comportamento pre-fix è documentato come *"~20 clearTerminal repaints/second"*).
5. **`aliveAtEnd` è un campione pre-kill**: un figlio che muore durante lo shutdown riporta comunque `true`.
6. **I tempi di `pty-layout` sono sonni puri** tranne le wait di readiness/SIGWINCH; i tasti sono separati da 0.1–1.0 s (commento: *"a keystroke that lands after a screen transition can hit the wrong handler (e.g. "s" on home opens settings)"*).

## 7. Invarianza non-PTY, per test (quotata)

| test | proprietà non-terminale |
|---|---|
| pty-layout 3.1 | *"session is a frameless full-width scrollback column (#183)"* — il contratto di layout del transcript (niente bordi, echo `› you`, righe `◆ moh`) |
| pty-layout 3.2 | *"settings floats transparently without moving the live chat"* — l'overlay non deve spostare composer e chip (uguaglianza di indici di riga) |
| pty-layout 3.3 | l'ultima riga della lista settings (`Remove provider`) è raggiungibile scorrendo |
| pty-layout 3.4 | `/Default permission mode\s+normal/` rende etichetta e valore su **una** riga |
| pty-layout 3.5 | il gruppo `Modals` e il marker `↑ ` sono raggiungibili dopo 60 ↓ |
| pty-layout 3.6 | le righe pre-resize sono storia immutabile |
| invalid-then-valid | *"invalid arguments for ask_user:"* + *"questions.0.options"* — il rifiuto dello schema e il retry che lo consuma |
| large-turn | la selezione avanza fino alla riga `Other` sempre-ultima; nessun OOM |
| oversized | un TUI bloccato e inattivo non emette churn di frame |
| long-session | la stessa invariante, più "il transcript da solo supera il viewport" |

## 8. Perché un pty vero può servire (una riga per test)

| test | cosa un fake tty in-process non potrebbe osservare |
|---|---|
| pty-layout 3.1 | la promozione delle righe di transcript nello scrollback nativo (#183) e la geometria reale dell'avvio CLI |
| pty-layout 3.2 | due avvii CLI reali confrontati riga per riga, incluso il ctrl+s in raw mode |
| pty-layout 3.3 | il viewport reale 80×20 + ctrl+s + nove frecce in una sola write |
| pty-layout 3.4 | il wrapping reale a 50 col e la garanzia "le righe non si spezzano" |
| pty-layout 3.5 | 60 frecce in una sola write grezza sul pannello dei comandi |
| pty-layout 3.6 | **SIGWINCH + TIOCSWINSZ mid-session**, e la rivendicazione che le righe pre-resize restano nello scrollback (il harness conserva esplicitamente lo scrollback attraverso il resize) |
| invalid-then-valid | avvio CLI/config/session assembly reali, la `fetch` cross-process verso il server finto, e la consegna reale delle frecce/TAB a un renderer che si blocca e si riprende |
| large-turn | pressione di memoria reale e SIGKILL reale su una catena di 15 chiamate con quattro domande parallele |
| oversized | l'altezza reale del viewport che guida la scelta di Ink, più il modo di fallire reale "budget bruciato → il runner uccide il harness" |
| long-session | il viewport reale a 20 righe con un transcript più alto dello schermo e una finestra inattiva reale di 10 s |
| `pty-runner.ts`/`pty-layout.test.ts` | l'header di `pty-layout` lo dice: *"Headless Ink renders cannot validate viewport geometry, cursor windowing or resize behavior."* — e `harness.py` esiste perché *"node-pty does not load under Bun"* |
