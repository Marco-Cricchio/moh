# Baseline — `streaming-persistence.pty.test.ts` (15 test) · ticket #1055

Fonte: ricognizione sul repo a `develop`. Trascrizione, non sintesi.

**File:** `packages/tui/test/pty/streaming-persistence.pty.test.ts` (1148 righe), `describe.skipIf(!hasPython)("streaming blocks persist on screen", …)` (riga 50), 15 `test` con timeout esplicito.
**Import:** `runPty`, `runPtyRaw`, `hasPython` da `./pty-runner`; `COMPOSER_READY = "for everything you need"` da `../helpers`.

## 0. Semantica delle letture (necessaria per leggere le asserzioni)

- `runPtyRaw(spec)` → `PtyMeta = { lines, scrollback, checkpoints, exited, exitCode, aliveAtEnd, maxFrameRows, frames, fullscreenFrames, framesAfterMark, maxFrameRowsAfterMark, fullscreenAfterMark }`. `runPty(spec)` = `(await runPtyRaw(spec)).lines`.
- `lines` = **`screen.lines()[-spec.tail ?? rows:]`** → solo le ultime `tail` righe dello schermo fisico; `scrollback` = scrollback nativo accumulato.
- `checkpoint: "name"` salva `{ lines, scrollback }` **nell'istante dello step**.
- Step con `until`: `pump_until(wait ?? 5.0, needle, since=len(buf))` — il `wait` è un **budget**, non una pausa; il needle è cercato nei byte scritti **dopo** l'inizio dello step. Un budget scaduto **solleva** `RuntimeError`: nessun test prosegue con un needle mai dipinto.
- Step senza `until`: `pump(wait ?? 0.3)`. Boot fisso `pump(2.5)` prima degli step.
- `mark: true` chiude il frame corrente e fissa `mark`; `markEnd: true` fissa `markEnd`. Poi `framesAfterMark`, `fullscreenAfterMark`, `maxFrameRowsAfterMark` (altezza massima dei frame **non** fullscreen nel window).
- Un frame = blocco `eraseLines + frame + cursor suffix` in un sync block DECSET-2026, o delimitato da `eraseLines` — quindi **il conteggio dipende da quante repaint Ink completa sull'host**.
- A fine step l'harness manda **SIGINT**, poi `sleep(0.3)`, `terminate()`, `wait(2)`, `kill()`: `lines`/`scrollback` finali sono lo stato **all'istante di fine step**, quindi le asserzioni "mid-stream" leggono davvero il frame prerisposta.
- Kill duro del runner a **45_000 ms**: i test con timeout `45_000` hanno budget pari a quello del runner.
- `meta.aliveAtEnd` = il client era vivo al SIGINT → un **crash detector**, non un'affermazione di stato.

Tag di dipendenza: **[W]** orologio reale · **[C]** cadenza/conteggio delta della fixture · **[R]** numero/contenuto delle repaint dell'host · **[—]** nessuna dipendenza temporale.

## 1. `a promoted paragraph remains visible while the following tail streams` (riga 51, timeout 15_000)

- `cols: 120`, `rows: 40`, `tail: 40`, **nessun `rawDump`**, `runPty`. `config`: dev + provider `fake`; nessun `project`.
- **Fixture `startSlowStream()` (default `withTool = false`)**: 1 chunk `role`; **1 solo chunk** `content: "FIRST-PARAGRAPH\n\n"`; `sleep(350)`; **1 chunk** `"SECOND-STREAMING-TAIL"`; `sleep(600)`; `stop`; `[DONE]`.
- **Steps:** `{wait:0.2, send:"stream"}`, `{wait:0.2, send:"\r"}`, `{wait:4.0, until:"SECOND-STREAMING-TAIL"}`.
- **Asserzioni:**
  1. `frame.toContain("FIRST-PARAGRAPH")` — schermo fisico (ultime 40 righe), istante di fine step. Proprietà: il paragrafo promosso resta **visibile** mentre la coda streama. **[W] [R]**; nota: **non** legge `meta.scrollback`, quindi non copre l'assenza di duplicati.
  2. `frame.toContain("SECOND-STREAMING-TAIL")` — stesso read. **[W] [R]**.

## 2. `a completed action remains visible while the next model call streams` (riga 86, timeout 15_000)

- `cols: 120`, `rows: 40`, `tail: 40`, `runPty`, nessun `rawDump`.
- **Fixture `startSlowStream(true)`**: call 1 → `tool_calls glob` (`{pattern:"*.md"}`) + `finish_reason: "tool_calls"`; call 2 → `content: "AFTER-TOOL-STREAMING-TAIL"`, `sleep(350)`, **chunk vuoto**, `sleep(600)`, `stop`. Il `glob` gira davvero nella project root del PTY.
- **Steps:** `{wait:0.2, send:"stream action"}`, `{wait:0.2, send:"\r"}`, `{wait:4.0, until:"AFTER-TOOL-STREAMING-TAIL"}`.
- **Asserzioni:** 1) `frame.toContain("✓ glob")` (l'azione completata resta visibile mentre la chiamata successiva streama) **[W] [R]**; 2) `frame.toContain("AFTER-TOOL-STREAMING-TAIL")` **[W] [R]**.

## 3. `a multi-row steering draft during a reasoning stream never clears the screen (#1022)` (riga 115, timeout 40_000)

- `cols: 120`, `rows: 14`, `tail: 14`, `rawDump: "/tmp/moh-steering-draft-raw.bin"`, `runPtyRaw`. `showReasoning: true`, endpoint con `capabilities.thinking.levels: ["low"]`.
- **Fixture `startLongReasoningStream()` (righe 928-964)**: 222 delta `reasoning_content` a `sleep(8)` (`FIRST-LIVE-REASONING`, `thought-0…219`, `LAST-LIVE-REASONING`); **hold di 3_000 ms esattamente su `thought-20`**; **hold di 2_500 ms dopo il loop**; poi `content: "REASONING-ENDED"` + `stop`. Totale ≈ 7.3 s.
- **Steps:** `{wait:0.2, send:"long reasoning"}`, `{wait:0.2, send:"\r"}`, `{wait:8.0, until:"thought-20"}`, `{wait:0.2, send: "draftword "×80}`, `{wait:2.0, mark:true}`, `{wait:12.0, until:"LAST-LIVE-REASONING"}`, `{wait:0.5, markEnd:true}`.
- **Asserzioni:**
  1. `meta.aliveAtEnd === true` **[—]**.
  2. `meta.framesAfterMark > 10` — sanità: la finestra non è vuota. **[R]**: >10 frame distinti in ~2.0-2.5 s di stream vivo (~250-310 delta), quindi coalescenza ammessa ma non totale.
  3. `meta.fullscreenAfterMark === 0` — zero frame che hanno preso il path `clearTerminal + reprint + wipe scrollback`. **[R]**.
  4. `meta.maxFrameRowsAfterMark ≤ 14` (== `rows`) — il frame volatile non supera il terminale; con una bozza di 800 byte il cap del composer deve **scrollare** invece di allargare. **[R]**, quantificato.
  5. `rawDump.split("\x1b[2J\x1b[3J\x1b[H").length - 1 ≤ 4` — clear fullscreen nell'intera run (incluso il ramp Home→chat). **[R] [W]**.
  6. `rawDump.toContain("draftword")` — proprietà **non terminale**: i tasti restano dell'utente (il cap scrolla, non scarta). **[W] [R]**.

## 4. `a long unbroken reasoning paragraph grows scrollback before reasoning_end` (riga 177, timeout 20_000)

- `cols: 120`, `rows: 24`, `tail: 24`, `rawDump: "/tmp/moh-streaming-long-reasoning-raw.bin"`, `runPtyRaw`; stesso config del test 3.
- **Fixture:** `startLongReasoningStream()` (identica).
- **Steps:** `{wait:0.2, send:"long reasoning"}`, `{wait:0.2, send:"\r"}`, `{wait:12.0, until:"LAST-LIVE-REASONING"}`, `{wait:1.5}`.
- **Asserzioni:**
  1. `meta.aliveAtEnd === true` **[—]**.
  2. `raw.not.toContain("REASONING-ENDED")` — il dump è pre-fine-reasoning. **[W], margine stretto**: la fixture dipinge `REASONING-ENDED` **2.5 s** dopo il needle mentre lo snapshot arriva a `pump(1.5)` + SIGINT → margine ≈ **1.0 s**.
  3. `meta.scrollback.some(line => line.includes("FIRST-LIVE-REASONING"))` — **la testa del reasoning è stata promossa** in scrollback prima di `reasoning_end`. **[W] [R] [C]** (commento #1045: il ritardo di promozione supera 0.4 s su runner carichi).
  4. `raw.slice(floor(len/2))` non contiene `FIRST-LIVE-REASONING` — dopo la promozione il testo non è più ristampato nella metà finale dei byte. **[R] [W]**.
  5. `readFileSync(rawDump).byteLength < 750_000` — volume di output **limitato**. **[W] [R]**.

## 5. `a dense unbroken prose paragraph never pushes Ink onto the fullscreen path (#950)` (riga 218, timeout 25_000)

- `cols: 100`, `rows: 24`, `tail: 24`, `rawDump: "/tmp/moh-dense-paragraph-raw.bin"`, `runPtyRaw`; `showReasoning: false`, thinking `["low","medium","high"]`.
- **Fixture `startDenseParagraphStream()`**: 120 delta di reasoning `DENSE-THINK-${i} checking the promotion boundary\n` a `sleep(8)` (~0.96 s, non mostrati); body costruito fino a 8000+ char (~8.075) + `" DENSE-DONE"`, spezzato in chunk da 900 char → **9 chunk** a `sleep(350)` ≈ 3.15 s; `stop`. Totale ≈ 4.1 s.
- **Steps:** `{wait:0.2, send:"dense"}`, `{wait:0.2, send:"\r"}`, `{wait:15.0, until:"DENSE-DONE"}`, `{wait:0.4}`.
- **Asserzioni:**
  1. `meta.aliveAtEnd === true` **[—]**.
  2. `raw.split("\x1b[2J\x1b[3J\x1b[H").length - 1 === 0` — **zero** clear fullscreen per tutta la run. **[R]**.
  3. `raw.not.toContain("\x1b[3J")` — nessun erase di scrollback in assoluto (più forte del precedente). **[R]**, **[—]** sul tempo.
  4. `raw.split("DENSE-DONE").length - 1 ≥ 1` — la risposta assestata è sopravvissuta nel transcript. **[C] [W]**.
  5. `byteLength < 750_000` **[W] [R]**.

## 6. `reasoning past the display cap repaints once, not per frame (#950)` (riga 260, timeout 30_000)

- `cols: 120`, `rows: 24`, `tail: 24`, `rawDump: "/tmp/moh-cap-rollover-raw.bin"`, `runPtyRaw`; `showReasoning: true`, thinking `["low","medium","high"]`.
- **Fixture `startCapRolloverStream()`**: `while (bytes < 70 * 1024)` → delta di reasoning da ~1.103 byte (`"reasoning through the window boundary. ".repeat(28) + "PIECE-" + String(++piece).padStart(4,"0") + "\n"`) a `sleep(12)` → **≈65 pezzi** (`PIECE-0001…PIECE-0065`, ~0.78 s); `sleep(300)`; reply parola-per-parola `"CAP-REPLY-DONE the capped reasoning turn has settled"` a `sleep(8)`; `stop`.
- **Steps:** `{wait:0.2, send:"cap rollover"}`, `{wait:0.2, send:"\r"}`, `{wait:15.0, until:"CAP-REPLY-DONE"}`, `{wait:0.4}`.
- **Asserzioni:**
  1. `meta.aliveAtEnd === true` **[—]**.
  2. `raw.split("CAP-THINK-0000").length - 1 ≤ 2` — ⚠️ **ASSERZIONE VACUA**: la fixture **non emette mai** `CAP-THINK-0000` (i suoi marker sono `PIECE-0001…NN`; `CAP-THINK` compare nel file solo dentro il test, righe 288-289). Il conteggio è sempre **0** e l'assert passa senza misurare il "reprint once, not per frame" che il nome promette. Inoltre `PIECE-0000` non esiste: `++piece` è pre-incremento. **[—]**.
  3. `raw.split("\x1b[2J\x1b[3J\x1b[H").length - 1 === 0` — zero clear fullscreen nell'intero turn. **[R]**.
  4. `byteLength < 1_500_000` **[W] [R]**.

## 7. `visible reasoning, a tool, and a long Markdown reply grow scrollback before done` (riga 300, timeout 20_000)

- `cols: 120`, `rows: 24`, `tail: 24`, `rawDump: "/tmp/moh-streaming-realistic-raw.bin"`, `runPtyRaw`; `showReasoning: true`, thinking `["low"]`; `project.permissions.overrides.tools.glob: "allow"`.
- **Fixture `startRealisticReasoningStream()`**: call 1 → reasoning `REALISTIC-REASONING inspect the manual before answering` + `tool_calls glob {pattern:"docs/manual/*.md"}`; call 2 → **due parti di reasoning dello stesso call**, poi 5 sezioni Markdown (`FIRST-MARKDOWN-SECTION`, `Architecture`, `PLAIN-PROSE-PARAGRAPH`, `Workflow`, `LAST-MARKDOWN-SECTION`) parola-per-parola a `sleep(8)` (~133 parole ≈ 1.06 s); `sleep(600)`; `content: "REALISTIC-FINISHED"`; `stop`.
- **Steps:** `{wait:0.2, send:"realistic stream"}`, `{wait:0.2, send:"\r"}`, `{wait:15.0, until:"LAST-MARKDOWN-SECTION"}`, `{wait:0.4}`.
- **Asserzioni:**
  1. `meta.aliveAtEnd === true` **[—]**.
  2. `raw.toContain("REALISTIC-REASONING")` **[C] [R]**.
  3. `raw.toContain("LAST-MARKDOWN-SECTION")` **[C] [R]**.
  4. `raw.not.toContain("REALISTIC-FINISHED")` — dump pre-settle. **[W], margine ≈ 0.3 s** (il marker arriva ~0.72 s dopo il needle, lo snapshot a ~0.40 s): **l'asserzione più stretta del file**.
  5. `raw.matchAll(/REALISTIC-REASONING compose/g).length === 1` — il testo di reasoning **non si duplica** (Static chunk **e** blocco assestato = sintomo di fine stream). **[R] [C]**.
  6. `raw.indexOf("FIRST-MARKDOWN-SECTION") ≥ 0` **[R] [W]**.
  7. `composePositions[0] < firstSectionAt` — proprietà **#326**: l'ordine stampato deve combaciare con quello canonico (reasoning sopra reply), altrimenti lo Static forward-only ri-emette gli item riordinati a `done`. **[R] [W]**.
  8. `byteLength < 1_500_000` — la reply resta **bounded** mentre è trattenuta. **[W] [R]**.
  9. `screen.some(line => line.includes("LAST-MARKDOWN-SECTION"))` — schermo fisico. **[R] [W]**.
  10. `[...history, ...screen].some(line => line.includes("glob"))` — storia terminale (scrollback ∪ schermo): il tool è rintracciabile. **[C] [R]**.
  11. `input = screen.findIndex(l => l.includes(COMPOSER_READY)); input ≥ floor(screen.length / 2)` — geometria del dock: composer nella metà inferiore (≥12 su 24). **[R] [W]**.

## 8. `completed lines enter terminal scrollback once while a long response is still streaming` (riga 356, timeout 45_000 = kill del runner)

- `cols: 120`, `rows: 20`, `tail: 20`, `rawDump: "/tmp/moh-streaming-lines-raw.bin"`, `runPtyRaw`.
- **Fixture `startLineStream()`**: 24 righe `content: "${marker} ${"x".repeat(120)}\n"` (marker: `FIRST-COMPLETED-LINE` a i=0, `MIDDLE-LINE-i`, `LAST-LIVE-LINE` a i=23) a `sleep(20)` (~0.48 s; ogni riga ~140 char → wrap su **2 righe** a 120 col); **`sleep(8_000)`**; `content: "STREAM-FINISHED"`; `stop`.
- **Steps:** `{wait:0.2, send:"line stream"}`, `{wait:0.2, send:"\r", checkpoint:"turnStart"}`, `{wait:5.0, until:"MIDDLE-LINE-5"}`, `{wait:1.0, checkpoint:"midStream"}`.
- **Asserzioni:**
  1. `meta.aliveAtEnd === true` **[—]**.
  2. `meta.checkpoints.midStream` definito **[—]**.
  3. `midText = [...scrollback, ...lines]` non contiene `STREAM-FINISHED` — il provider sta ancora trattenendo. **[W]**: margine ≈ 7 s (hold di 8 s vs snapshot ~1 s dopo il needle).
  4. `midText.toContain("MIDDLE-LINE-")` — la reply è avanzata oltre le righe iniziali. **[C] [R] [W]**.
  5. `midText.not.toContain("LAST-LIVE-LINE")` — la riga 24 non è ancora dipinta. **[C] [W]**.
  6. `input = lines.findIndex(COMPOSER_READY) ≥ floor(20/2) - 2 = 8` — geometria del dock, con **2 righe di tolleranza** (safety row del tail volatile #950 + toast one-shot del reasoning). **[R] [W]**.
  7. `|startInput - input| ≤ 2` fra `turnStart` e `midStream` — il dock può respirare di una riga ma resta pinnato al fondo. **[R] [W]**.
  8. `byteLength < 500_000` — output **bounded**, nessun flood O(n²). **[W] [R]**.

## 9. `final settlement does not reprint a prose prefix already in scrollback` (riga 412, timeout 45_000)

- `cols: 120`, `rows: 20`, `tail: 20`, `rawDump: "/tmp/moh-streaming-lines-settled-raw.bin"`, `runPtyRaw`; stesso config del test 8.
- **Fixture:** `startLineStream()` (identica).
- **Steps:** `{wait:0.2, send:"settled line stream"}`, `{wait:0.2, send:"\r"}`, `{wait:15.0, until:"✓ done"}`, `{wait:2.0, checkpoint:"settled"}`.
- **Asserzioni:**
  1. `transcript = [...settled.scrollback, ...settled.lines]` — checkpoint post-settle, **una sola concatenazione** (le ripetizioni dei byte di repaint non sono storia del terminale).
  2. `meta.aliveAtEnd === true` **[—]**.
  3. `transcript.toContain("✓ done")` — il turno è chiuso e lo stato è dipinto. **[W]** (margine ~6 s: 0.48 s di stream + 8 s di hold).
  4. Per ognuno di `["◆ moh", "FIRST-COMPLETED-LINE", "MIDDLE-LINE-15", "LAST-LIVE-LINE", "STREAM-FINISHED"]`: `transcript.split(marker).length - 1 === 1` — **5 asserzioni di conteggio esatto 1**: ogni marker è stampato **una volta sola** (nessun reprint di promozione). **[R] [W]**.

## 10. `an unbroken oversized prose stream stays output-bounded (#203)` (riga 451, timeout 15_000)

- `cols: 120`, `rows: 40`, `tail: 40`, `rawDump: "/tmp/moh-streaming-tail-raw.bin"`, `runPtyRaw`.
- **Fixture `startUnbrokenStream()`**: 120 chunk `content: "${"x".repeat(120)} TAIL-${i} "` (~130 char, **nessun newline**) a `sleep(10)` (~1.2 s); `stop`.
- **Steps:** `{wait:0.2, send:"long stream"}`, `{wait:0.2, send:"\r"}`, `{wait:15.0, until:"✓ done"}`, `{wait:1.0}`.
- **Asserzioni:**
  1. `lines.join("\n").toContain("TAIL-119")` — l'ultimo chunk è stampato. **[C] [W] [R]**.
  2. `byteLength < 1_500_000` — **la #203 in persona**: senza il clip a blocco singolo Ink riscriverebbe ogni riga accumulata per ognuno dei 120 chunk (output quadratico); il bound cattura la regressione. **[C] [R] [W]**.

## 11. `a session-style prose+list reply prints each bullet exactly once` (riga 485, timeout 30_000)

- `cols: 149`, `rows: 40`, `tail: 40`, **nessun rawDump**, `runPtyRaw`; `mode: "vibe"`, niente reasoning.
- **Fixture `startSessionReplyStream()`**: 8 sezioni di prosa italiana (testo della sessione 43cc494c) **parola per parola** a `sleep(25)` (~167 parole ≈ 4.2 s); `stop`. Marker: `Come funziona`, `Architettura`, `Stato del lavoro`, `Issue aperte`, `Cosa ti incuriosisce?`.
- **Steps:** `{wait:0.2, send:"parliamo di moh"}`, `{wait:0.2, send:"\r"}`, `{wait:15.0, until:"Cosa ti incuriosisce?"}`, `{wait:1.0}`.
- **Asserzioni:**
  1. `meta.aliveAtEnd === true` **[—]**.
  2. Per ognuno dei 5 marker: `history.split(marker).length - 1 === 1` (storia = scrollback ∪ schermo) — ogni item compare **esattamente una volta** (il bug del report 666.mov era il raddoppio della lista). **[C] [R] [W]**.

## 12. `a long tool cycle sequence prints each intermediate text exactly once` (riga 518, timeout 30_000)

- `cols: 120`, `rows: 24`, `tail: 24`, `rawDump: "/tmp/moh-streaming-toolcycles-raw.bin"`, `runPtyRaw`; `showReasoning: true`, thinking `["low"]`; `project.permissions...glob: "allow"`.
- **Fixture `startToolCycleStream()`**: `calls 1..8` = cicli, `> 8` = finale. Per ciclo: sezione Markdown parola-per-parola a `sleep(5)` (ciclo 0 con 3 sezioni lunghe ≈470 token ≈ 2.35 s; cicli 1-7 una sezione breve ≈20 token); **`sleep(2_500)` nel solo ciclo 0**; `sleep(150)`; un delta di reasoning `CYCLE-THINKING-${calls-1}`; poi **3 `tool_calls` `glob` paralleli**. Finale: `FINAL-REPLY-MARKER …` parola-per-parola a `sleep(8)`; `stop`.
- **Steps:** `{wait:0.2, send:"run the cycles"}`, `{wait:0.2, send:"\r"}`, `{wait:5.0, until:"CYCLE-LIVE-TAIL-0", checkpoint:"midStream"}`, `{wait:10.0, until:"FINAL-REPLY-MARKER"}`, `{wait:0.8}`.
- **Asserzioni:**
  1. `meta.aliveAtEnd === true` **[—]**.
  2. `meta.checkpoints.midStream` definito **[—]**.
  3. `mid.scrollback.some(l => l.includes("CYCLE-STATIC-0"))` — **proprietà #526**: le sezioni chiuse sono entrate nello **scrollback nativo** prima che arrivi la reasoning tardiva. **[W] [R]**.
  4. `raw.toContain("FINAL-REPLY-MARKER")` **[C] [R] [W]**.
  5. `CYCLE-TEXT-1…7` nella storia: **7 asserzioni di conteggio esatto 1** **[R] [W]**.
  6. `history.split("CYCLE-STATIC-0").length - 1 === 1` **[R] [W]**.
  7. `history.split("FINAL-REPLY-MARKER").length - 1 === 1` **[C] [R] [W]**.
  (Nessuna asserzione sulla dimensione del dump, benché `rawDump` sia dichiarato.)

## 13. `open Markdown tool cycles enter terminal history exactly once` (riga 574, timeout 35_000)

- `cols: 52`, `rows: 18`, `tail: 18`, **nessun rawDump**, `runPtyRaw`; `showReasoning: true`, thinking `["low"]`; `glob: "allow"`.
- **Fixture `startOpenMarkdownToolCycleStream()`**: `calls > 6` = finale; altrimenti reply `"\n## Cycle ${cycle}\n\n…\n- MD-${cycle}-ALPHA\n- MD-${cycle}-BETA\n\n"` parola-per-parola a `sleep(4)`; **poi** (ordine GLM di produzione) reasoning `MD-THINK-${cycle}` in **un delta**; poi 1 `tool_calls glob`. Finale: `MARKDOWN-CYCLES-DONE …` a `sleep(6)`; `stop`.
- **Steps:** `{wait:0.2, send:"run markdown cycles"}`, `{wait:0.2, send:"\r"}`, `{wait:12.0, until:"MARKDOWN-CYCLES-DONE"}`, `{wait:1.0}`.
- **Asserzioni:** 1) `meta.aliveAtEnd === true` **[—]**; 2) doppio ciclo su 6 cicli × `{MD-n-ALPHA, MD-n-BETA, MD-n-THINK}` → **18 asserzioni di conteggio esatto 1** — un segmento Markdown **aperto** non entra nell'albero volatile e atterra una volta sola quando il confine della chiamata si assesta in Static (bug della sessione cca11370: bullet in scrollback due volte). **[C] [R] [W]**; 3) `MARKDOWN-CYCLES-DONE` esatto 1 **[C] [R] [W]**.

## 14. `mode toggle repaints one coherent grammar (no stale vibe/dev mixing)` (riga 624, timeout 45_000 = kill del runner)

- `cols: 120`, `rows: 24`, `tail: 24`, **nessun rawDump**, `runPtyRaw`; `mode: "vibe"`, `showReasoning: true`, thinking `["low"]`; `glob: "allow"`.
- **Fixture:** `startToolCycleStream()` (identica al test 12).
- **Steps:** `{wait:0.2, send:"run the cycles"}`, `{wait:0.2, send:"\r"}`, `{wait:3.0, send:"\x0f"}`, `{wait:1.0, send:"\x0f"}`, `{wait:10.0, until:"FINAL-REPLY-MARKER"}`, `{wait:0.5, send:"\x0f"}`, `{wait:1.2, send:"\x0f"}`, `{wait:1.2, send:"\x0f"}`, `{wait:1.2}`. (`\x0f` = Ctrl-O: **5 toggle**, 2 mid-stream + 3 post-settle; il modo finale è `dev`.)
- **Asserzioni:**
  1. `meta.aliveAtEnd === true` **[—]**.
  2. `finalFrame.not.toContain("looked for files")` — nessuna traccia della grammatica `vibe` sopravvive all'ultimo repaint. **[R] [W]**.
  3. `finalFrame.toContain("FINAL-REPLY-MARKER")` **[C] [W] [R]**.
  4. `CYCLE-TEXT-1..3` nella storia: **3 asserzioni di conteggio esatto 1** nonostante 5 repaint complete. **[R] [W]**.
  5. `FINAL-REPLY-MARKER` esatto 1 **[C] [R] [W]**.

## 15. `multi-part late reasoning per call prints each thinking block exactly once` (riga 673, timeout 40_000)

- `cols: 120`, `rows: 24`, `tail: 24`, `rawDump: "/tmp/moh-multipart-raw.bin"`, `runPtyRaw`; `showReasoning: true`, thinking `["low"]`; `glob: "allow"`.
- **Fixture `startMultiPartReasoningStream()`**: `calls > 4` = finale (`FINAL-REPLY-MARKER …` a `sleep(8)`); altrimenti per ciclo: (a) reasoning lungo su **una riga senza newline** (`PART-THINK-${cycle} ` + 22×"thinking through the tool result carefully before answering. ") parola-per-parola a `sleep(4)`; (b) reply Markdown parola-per-parola a `sleep(4)`; (c) **`sleep(120)`**, poi **una seconda parte di reasoning per lo STESSO call** (12×"final check of the cycle result before the tool runs. " + `TAILPART-${cycle}`) in un solo delta; (d) 2 `tool_calls glob`.
- **Steps:** `{wait:0.2, send:"think through the cycles"}`, `{wait:0.2, send:"\r"}`, `{wait:4.0, checkpoint:"afterCycle1"}`, `{wait:12.0, until:"FINAL-REPLY-MARKER"}`, `{wait:0.8}`.
- **Asserzioni:**
  1. `meta.aliveAtEnd === true` **[—]**.
  2. `meta.checkpoints.afterCycle1` assegnato e **mai usato** (checkpoint morto: costa uno snapshot).
  3. Storia = scrollback ∪ schermo.
  4. `PART-THINK-0..3`: **4 asserzioni di conteggio esatto 1** — il blocco di thinking di ogni call è **una sola emissione fisica**, mai duplicato dall'handover live→log né dalla proiezione assestata. **[C] [R] [W]**.
  5. `PART-REPLY-0..3`: **4 asserzioni di conteggio esatto 1** **[C] [R] [W]**.
  6. `FINAL-REPLY-MARKER` esatto 1 **[C] [R] [W]**.

## Tabella per fixture (cadenza / hold)

| Fixture | Usata da | Delta e cadenza | Hold | Durata tipica |
|---|---|---|---|---|
| `startSlowStream(false)` | 1 | 1 chunk `role`; 2 delta di contenuto | `sleep(350)` fra i delta; `sleep(600)` prima di `stop` | ~0.95 s |
| `startSlowStream(true)` | 2 | call 1: `glob` + `finish tool_calls`; call 2: tail + chunk vuoto | `sleep(350)`, `sleep(600)` | ~0.95 s + `glob` reale |
| `startLongReasoningStream()` | 3 (`rows 14`), 4 (`rows 24`) | 222 delta reasoning @ **8 ms** | **`sleep(3_000)` su `thought-20`** + **`sleep(2_500)`** dopo il loop | ~7.3 s |
| `startDenseParagraphStream()` | 5 | 120 reasoning @8 ms + 9 chunk da 900 char @ **350 ms** | nessuno | ~4.1 s |
| `startCapRolloverStream()` | 6 | ~65 pezzi da ~1.103 byte (`PIECE-0001…0065`) @ **12 ms** | `sleep(300)` | ~1.15 s |
| `startRealisticReasoningStream()` | 7 | call 1: reasoning + `glob`; call 2: 2 parti di reasoning, 5 sezioni @ **8 ms** | `sleep(600)`; nessun hold interno | ~1.7 s |
| `startLineStream()` | 8, 9 | 24 righe da ~140 char @ **20 ms** | **`sleep(8_000)`** | ~8.5 s |
| `startUnbrokenStream()` | 10 | 120 chunk da ~130 char @ **10 ms** | nessuno | ~1.2 s |
| `startSessionReplyStream()` | 11 | 8 sezioni italiane parola-per-parola @ **25 ms** | nessuno | ~4.2 s |
| `startToolCycleStream()` | 12, 14 | 8 cicli @ **5 ms**; reasoning tardiva in 1 delta; 3 `glob` paralleli; finale @8 ms | **`sleep(2_500)`** nel ciclo 0 + `sleep(150)` per ciclo | ~8-11 s (24 `glob` reali) |
| `startOpenMarkdownToolCycleStream()` | 13 | 6 cicli @ **4 ms**, reasoning GLM in 1 delta, `glob`; finale @6 ms | nessuno | ~2-3 s + 6 `glob` |
| `startMultiPartReasoningStream()` | 15 | 4 cicli: reasoning @**4 ms**, reply @**4 ms**, 2ª parte in 1 delta; finale @8 ms | **`sleep(120)`** | ~6 s + 8 `glob` |

## Anomalie rilevate (sola lettura, nessuna modifica)

1. **Asserzione vacua** (test 6, righe 288-289): `raw.split("CAP-THINK-0000")` — la stringa non è mai emessa dalla fixture; `CAP-THINK` compare nel file **solo** nel test. L'assert è sempre 0 e non misura il "reprint once, not per frame" del nome. Inoltre `PIECE-0000` non esiste (pre-incremento).
2. **Test 12**: dichiara `rawDump` e non usa mai il dump (nessun bound di byte).
3. **Test 15**: `afterCycle1` assegnato e mai usato — checkpoint morto.
4. **Test 1 e 2**: leggono solo lo schermo fisico, mai `meta.scrollback`, e non hanno `rawDump`: la proprietà è verificata come "la stringa è ancora nelle ultime 40 righe all'istante dello snapshot", non come assenza di duplicazione.
5. **Accoppiamenti wall-clock più stretti**: test 7 assert 4 (margine ≈ **0.3 s**) e test 4 assert 2 (margine ≈ **1.0 s**).
6. **Timeout pari al budget del runner**: test 8, 9 e 14 hanno timeout `45_000`, identico al SIGKILL del runner: nessun margine fra "test in timeout" e "kill dell'harness".
