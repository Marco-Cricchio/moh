# Baseline — harness, `pty-runner` e famiglia layout/immagini/colore (ticket #1055)

Fonte: ricognizione sul repo a `develop`. Trascrizione, non sintesi. Ogni numero è quello del test.

## 0. Il harness che tutti i file guidano

**Runner** (`pty-runner.ts`)
- `runPty(spec)` → `PtyLine[]`; `runPtyRaw(spec)` → `PtyMeta`. Entrambi lanciano `python3 harness.py '<json spec + meta:true>'` via `Bun.spawn` (asincrono di proposito: i server SSE finti vivono nel processo di test padre).
- **Uccisione dura: `setTimeout(() => proc.kill("SIGKILL"), 45_000)`** → `"pty harness timed out after 45000ms"`. Exit non-zero del harness → `"pty harness failed (code): stderr"`.
- `PtySpec`: `cols`, `rows`, `resize?{cols,rows,until?,untilWait?}`, `config?` (**user** config → `~/.moh/config` di un home temporaneo), `meta?`, `project?` (**project** `moh.json`), `rawDump?`, `env?`, `files?` (base64 nome→contenuto nella cwd del figlio), `seedSessions?`, `steps[]` (`wait`, `send` base64, `until`, `untilOnScreen`, `untilFromBuffer`, `checkpoint`, `mark`, `markEnd`), `tail?`.
- `PtyMeta`: `lines` (`{lead,width,text}`), `scrollback`, `exited`, `exitCode`, `aliveAtEnd`, `maxFrameRows`, `fullscreenFrames`, `framesAfterMark`, `fullscreenAfterMark`, `maxFrameRowsAfterMark`, `frames`, `checkpoints`.
- Esporta `python3`, `hasPython` (tutti i file sono gated su `hasPython`), `DEV_CONFIG = {onboarded:true, workflowOffered:true, mode:"dev"}`, `VIBE_CONFIG` (idem, `mode:"vibe"`).

**Ambiente del figlio** (`harness.py:428-453`) — `HOME=<temp>`, `TERM=xterm-256color`, `COLORTERM=truecolor`, **`CI` rimosso** (Ink si silenzia in CI), più `spec.env` sovrapposto all'ambiente ereditato (**nulla viene rimosso**); cwd = dir temporanea, pty reso terminale di controllo (`TIOCSCTTY`) perché bun su Linux legge la size da `/dev/tty`; il `moh.json` di progetto parte sempre da `{"handoff":{"transport":"none"}}` e viene aggiornato con `spec.project`.

**Semantica degli step** (`harness.py:576-603`) — `pump(2.5)` di boot **prima del primo step**; poi per ogni step:
- con `until` → `pump_until(wait ?? 5.0, needle, since=len(buf), on_screen=untilOnScreen, entry_buffer=untilFromBuffer)`; `until`+`send` nello stesso step → `ValueError`; al match pompa `0.2s` in più. **Una readiness scaduta ora solleva** (`"pty readiness wait expired after {seconds}s: needle … never appeared"` + coda del buffer): non è più un salto silenzioso.
- senza `until` → `send` (base64 → master) poi `pump(wait ?? 0.3)`.
- poi `mark`/`markEnd` (finestra dei frame) e `checkpoint` → `snapshot()`.
- `snapshot()` = `{lines: ultime tail righe come {lead,width,text}, scrollback: [...]}`; le `lines` finali hanno la stessa forma, limitate a `tail`, rstrippate, dal **modello VT100** (cursore/ED/EL/DECSTBM/SU/SD/RI + autowrap + buffer alternativo DECSET 1049 + sync block DECSET 2026; `lines()` ricade sulla grid viva se un sync block resta aperto >2s).
- fine: `aliveAtEnd = proc.poll() is None` campionato **prima** dell'uccisione; `SIGINT`, `terminate()`, `wait(2)`, `kill()`, `wait(1)`; un codice fuori da `{0, None, -SIGINT, -SIGTERM, -9, -15}` → `RuntimeError("moh TUI crashed under the PTY harness…")`; `rawDump` scritto; `checkpoints` anche su `MOH_PTY_DUMP`.

**Capacità usate da questi file e non da altri**
| capacità | usata da (in questi file) | altrove |
|---|---|---|
| `checkpoint` (snapshot mid-stream) | markdown-live-continuity, natural-scrollback, typewriter-reveal | streaming-persistence |
| `env` injection | nocolor (`NO_COLOR`), image-preview (`TERM_PROGRAM`/`KITTY_WINDOW_ID`), typewriter-reveal (`MOH_TYPEWRITER_MS`/`_CHARS`) | (#490) |
| `files` fixtureFiles | solo image-preview | — |
| `seedSessions` | home-compact (2, 2, 12, 3) | — |
| `untilFromBuffer` | solo markdown-live-continuity | — |
| `untilOnScreen` | image-preview, typewriter-reveal | pty-layout, ask-user-* |
| `rawDump` | home-compact, nocolor, image-preview, natural-scrollback | streaming-persistence |
| `runPty` (senza meta) | solo reasoning-controls | — |
| `mark`/`markEnd` | **nessuno di questi** | streaming-persistence |
| `resize`/SIGWINCH | **nessuno di questi** | pty-layout |

**Fatti trasversali che ogni script assume in silenzio**
- **Skip dell'intro via tasto.** La CLI parte con `intro` acceso; Home rende `<LogoIntro>` al posto del contenuto per `DURATION_MS = 2800` + 350 ms di settle, e il suo `useInput` salta l'intro su **qualsiasi** tasto; l'`useInput` di Home è registrato comunque, quindi lo **stesso** tasto finisce anche nella ricerca. Ogni script che invia prima di ~3.2 s (nocolor, image-preview, reasoning-controls, markdown-live-continuity, natural-scrollback, typewriter-reveal) ottiene "il primo tasto salta l'intro **e** avvia la query".
- **Vita del toast** `TOAST_MS = 3500`; `App` formatta il testo come **riga**, non numero.
- **Switch dell'hint del composer**: `COMPOSER_HINT_MIN_COLS = 71`; `COMPOSER_READY = "for everything you need"` a cols ≥ 71, `COMPOSER_COMPACT = "type…"` sotto (da `test/helpers.ts`).
- **Pacing della reveal** (`Chat.tsx:239-245`): `REVEAL_TICK_MS = MOH_TYPEWRITER_MS ?? 60`, `REVEAL_CHARS_PER_TICK = MOH_TYPEWRITER_CHARS ?? 20`, catch-up 400, boost `1 + min(4, deficit/500)` (≤5× ⇒ ≤1667 c/s), snap-open al settle.
- **Ink scrive i sync block DECSET 2026 solo quando `stdout.isTTY === true` e non in CI** (`node_modules/ink/build/write-synchronized.js`): il conteggio dei frame del harness esiste solo su un pty vero.

## 1. Conteggi per file

| file | righe | describe | `test(...)` | eseguibili | saltati | timeout |
|---|---|---|---|---|---|---|
| `home-banner.pty.test.ts` | 30 | 1 | 1 | 1 | 0 | 60_000 |
| `home-compact.pty.test.ts` | 97 | 1 | 4 | 4 | 0 | 90_000 ×4 |
| `nocolor.pty.test.ts` | 116 | 1 | 2 | 2 | 0 | 60_000 ×2 |
| `image-preview.pty.test.ts` | 70 | 1 | 2 | 2 | 0 | 60_000 ×2 |
| `reasoning-controls.pty.test.ts` | 58 | 1 | 2 | 2 | 0 | 15_000 ×2 |
| `markdown-live-continuity.pty.test.ts` | 63 | 0 | 1 | 1 | 0 | 30_000 |
| `modal-return-anchor.pty.test.ts` | 101 | 1 | 1 (`test.skip`) | 0 | **1 (sempre saltato)** | 90_000 (inerte) |
| `natural-scrollback.pty.test.ts` | 89 | 0 | 1 | 1 | 0 | 45_000 |
| `typewriter-reveal.pty.test.ts` | 88 | 0 | 1 | 1 | 0 | 20_000 |
| **totale** | **712** | 6 | **15** | **14** | **1** | — |

Nessun file è privo di `test(`; l'unica dichiarazione inerte è il `test.skip` di `modal-return-anchor` (§8).

## 2. `home-banner.pty.test.ts` — `shows the slant banner, acronym, and version under it`
- `cols: 100`, `rows: 40`; `config: {onboarded:true, workflowOffered:true, mode:"dev"}`; `project: {provider:"mock"}`; `tail: 40`. Nessun server.
- Script: `{ wait: 3.0, until: "New session" }`.
- Asserzioni (`text` = `lines.map(l=>l.text).join("\n")`):
  1. `toContain("/ /_")` — banner figlet-Slant sulla schermata fisica.
  2. `toContain("My Own Harness")` — riga dell'acronimo.
  3. `toContain("v0.1.0")` — versione resa (modalità banner).
  4. `not.toContain("v0.1.0 · ")` — il prefisso versione del **footer** è assente.
  5. `not.toContain("moh > — My Own Harness")` — il logo di fallback a una riga è assente.
  Proprietà: il banner è completo **e** i due fallback non sono dipinti (mutua esclusione dei rami di `homeBannerFits()`).
- Misura: solo schermata fisica (ultime 40 di 40 righe).
- Dipendenza dal tempo: la needle deve arrivare entro 3.0 s da uno step che parte 2.5 s dopo lo spawn, ma Home dipinge dopo l'intro (≈3.15 s dal mount): margine ≈1–2 s; un host lento **fa scadere** la wait.
- Invarianza non-PTY: `homeBannerFits(v) = widthClass(v) !== "compact" && v.rows >= HOME_BANNER_MIN_ROWS (30)` e il posto della versione (colonna del banner vs prefisso del footer).
- Pty necessario? Geometria + avvio reale: un fake tty in-process con `rows=40, columns=100` coprirebbe le asserzioni; irripetibili sono l'avvio CLI reale e la size vera.

## 3. `home-compact.pty.test.ts` (4 test)
Tutti con `DEV_CONFIG`, `project: {provider:"mock"}`, attesa `"New session"`.

### 3.1 `rows = 14: zero clearTerminal while sitting on Home`
- `cols: 80`, `rows: 14`; `seedSessions: 2`; `rawDump` repo-locale gitignorato (`.tmp-home-compact-14.bin`); `tail: 20`. Script: `{ wait: 4.0, until: "New session" }`.
- Asserzioni: `toContain("My Own Harness")`; `toContain("New session")`; **`readFileSync(rawDump,"utf8").split("\x1b[2J\x1b[3J\x1b[H").length - 1` = 0** (zero clearTerminal su tutto il run).
- Misura: schermata (1)-(2); **dump grezzo** (3), sul letterale `"\x1b[2J\x1b[3J\x1b[H"`.
- Dipendenza dal tempo: (3) è una proprietà **per-frame** valutata su tutti i repaint prodotti (≈4 s + 2.5 s di boot): funzione del numero di frame completati.
- Invarianza non-PTY: i tier verticali di Home (`homeVertical`: paddingY/spacers/hints/listFloor; `HOME_TIGHT_ROWS = 15`, `HOME_COMPACT_ROWS = 20`) e `visibleListHeight ≥ listFloor`.

### 3.2 `rows = 18: zero clearTerminal while sitting on Home`
- `cols: 80`, `rows: 18`; `seedSessions: 2`; `rawDump` (`.tmp-home-compact-18.bin`); `tail: 20`; **il risultato di `runPtyRaw` è scartato**. Script: `{ wait: 4.0, until: "New session" }`.
- Asserzione (una): zero occorrenze del triplo clearTerminal a 18 righe (tier medio: `HOME_TIGHT_ROWS ≤ 18 < HOME_COMPACT_ROWS` → `{paddingY:1, spacers:1, hints:false, listFloor:1}`).
- Misura: solo dump grezzo. Nessuna asserzione di schermo.
- Invarianza non-PTY: il confine del tier `HOME_COMPACT_ROWS`.

### 3.3 `rows = 12 with a long session list: banner, actionable row and hint survive`
- `cols: 80`, `rows: 12`; **`seedSessions: 12`**; `tail: 14`. Script: `{ wait: 4.0, until: "New session" }`.
- Asserzioni (`text` = righe unite):
  1. `toContain("My Own Harness")` — il logo sopravvive al tier più stretto (`rows 12 < 15` → `{paddingY:0, spacers:0, hints:false, listFloor:1}`).
  2. `toContain("New session")` — la riga azionabile sopravvive.
  3. `toContain("ctrl+o mode")` — l'hint del footer sopravvive.
  4. `text.length > 50` — il frame non è vuoto (titoli seminati / `↓ N more` visibili).
- Misura: schermata fisica (12 di 12 righe).
- Invarianza non-PTY: "la lista si restringe per prima, poi gli spaziatori, poi il padding — logo, casella di ricerca, riga 'New session' e hint del footer sono il pavimento che sopravvive sempre" (`viewport.ts:48-51`).

### 3.4 `rows = 14: arrows, enter and esc still work in the compact layout`
- `cols: 80`, `rows: 14`; `seedSessions: 3`; `tail: 16`; importa `COMPOSER_READY`. Nessun server (sessione seminata).
- Script: `{wait:4.0, until:"New session"}`, `↓`, 0.5, `x`, 0.5, `esc`, 0.5, `↓`, 0.5, `\r`, `{wait:10.0, until: COMPOSER_READY}`.
- Asserzione (una): `not.toContain("New session")` — Home è sparita: la sequenza frecce/tipeggio/esc/freccia/invio apre una sessione.
- Dipendenza dal tempo: `COMPOSER_READY` deve essere **ridipinta** dopo l'inizio dello step entro 10.0 s; i 0.5 s sono solo slack.
- Invarianza non-PTY: semantica dell'input (le frecce navigano, `esc` azzera la query, `enter` apre).

## 4. `nocolor.pty.test.ts` (2 test)
Fixture `startSlowEndpoint()`: SSE openai-compat con `{role:"assistant"}`, `{content:"Hello from moh"}`, **`await Bun.sleep(1500)`**, `{}` `stop`, `[DONE]`. Helper `scenario(env,url,rawPath)`: `cols: 100, rows: 30`, config con `provider:"fake"` + endpoint, `rawDump`, `tail: 30`. Regex: `COLOR = /\x1b\[(3[0-7]|4[0-7]|9[0-7]|10[0-7]|38;|48;)/g`, `BOLD = /\x1b\[1m/g`, `DIM = /\x1b\[2m/g`; lettura `latin1`.
Script condiviso: `{wait:0.3, send:"hi"}`, `{wait:0.4, send:"\r"}`, `{wait:6.0, until:"Hello from moh"}`.

### 4.1 `set: no color code on the wire, emphasis kept`
- `env: {NO_COLOR: "1"}`; `rawDump: "/tmp/moh-nocolor-on.bin"`.
- Asserzioni: `count(bytes, COLOR) === 0`; `count(bytes, BOLD) > 0`; `count(bytes, DIM) > 0`.
- Proprietà: `NO_COLOR` riguarda il colore, non l'enfasi.
- Misura: solo dump grezzo.
- Dipendenza dal tempo: il run deve durare abbastanza perché il footer della liveness scanner sia dipinto (hold del fixture 1500 ms); i conteggi BOLD/DIM dipendono dai frame prodotti in quella finestra.
- **Sensibilità all'ambiente del padre**: a livello chalk 0 *ogni* SGR sparisce (Ink instrada `dimColor`/`bold` via chalk): (2) e (3) passano solo se `FORCE_COLOR` è ereditato dal runner. Il harness rimuove solo `CI`.

### 4.2 `unset: the same screen is painted in color (the control)`
- Identico con `env: {}` (non rimuove nulla: il figlio eredita il `NO_COLOR`/`FORCE_COLOR` del padre).
- Asserzioni: `count(bytes, COLOR) > 0`; `bytes.toContain("Hello from moh")`.
- **Sensibilità speculare**: una shell che esporta `NO_COLOR=1` fa fallire questo controllo; una che esporta `FORCE_COLOR` fa fallire 4.1(1).

## 5. `image-preview.pty.test.ts` (2 test)
Fixture `startFakeOpenAi()`: `CHAIN = 15` chiamate, ognuna con 20 × `LONG_TEXT` (×40 ≈ 5 010 char) + un `bash {command:"ls"}`; la 16ª restituisce **quattro** `ask_user` con `Q1 — which way?`; poi `stop` con `all set`.
Script condiviso: `{wait:1.0}`, `send "look @image.png"` (0.3), `send "\r"` (1.0), `{until:"Q1 — which way?", wait:30.0, untilOnScreen:true}`, `{wait:1.0}`.
Config condivisa: `images:{preview:"auto"}`, `project: {permissions:{overrides:{tools:{bash:"allow"}}}}`, **`files: {"image.png": <PNG 1×1 base64>}`**.

### 5.1 `iTerm2 env: @mention attaches and emits an OSC 1337 sequence`
- `env: {TERM_PROGRAM: "iTerm.app"}`; `rawDump: "/tmp/moh-img-i-raw.bin"`.
- Asserzioni: `not.toContain("not found")` (schermo); `raw.toContain("\x1b]1337;File=")` (dump).
- **Sensibile all'ambiente del padre**: con `KITTY_WINDOW_ID`/`GHOSTTY_RESOURCES_DIR` esportati, `detectPreviewMode` sceglie kitty (ramo controllato prima) e l'asserzione OSC fallisce.

### 5.2 `kitty env: the graphics protocol hits the raw stream`
- `env: {KITTY_WINDOW_ID: "1"}`; `rawDump: "/tmp/moh-img-k-raw.bin"`; risultato scartato.
- Asserzione (una): `raw.toContain("\x1b_Gf=1,a=T,")`.
- Dipendenza dal tempo: l'emissione avviene all'attach (presto); la `untilOnScreen` da 30 s governa solo la durata.

## 6. `reasoning-controls.pty.test.ts` (2 test)
Entrambi usano `runPty` (sole righe), `DEV_CONFIG`, provider mock, timeout 15_000.

### 6.1 `/thinking show applies as non-blocking chrome without width overflow`
- `cols: 64`, `rows: 24`; `config: {...DEV_CONFIG, provider:"mock", showReasoning:false}`; `tail: 24`.
- Script: `{wait:1.0}`, `hello`, `\r`, `{until: COMPOSER_COMPACT, wait:15.0}`, `/thinking show`, `\r`, `{until: COMPOSER_COMPACT, wait:10.0}`.
- Asserzioni: `frame.toContain("reasoning display")` (il notice con cap di larghezza: a 64 col il budget è 20, la needle pinna la troncatura); `lines.every(l => l.width <= 64)` (**strutturalmente sempre vero** sotto questo harness — documenta il vecchio bug `lead + width`, non guarda un overflow raggiungibile); `frame.toContain(COMPOSER_COMPACT)`.
- Dipendenza dal tempo: il notice è un toast da 3500 ms, quindi lo step che lo campiona deve **matchare presto**; le due wait sono `since`-guarded e richiedono una ridipintura fresca.
- Pty necessario? **No**: nessuna delle tre asserzioni è specifica del protocollo terminale.

### 6.2 `bottom-bar ctrl+y explains models with no level map`
- `cols: 100`, `rows: 24`; `{...DEV_CONFIG, provider:"mock"}`; `tail: 24`.
- Script: `{wait:1.0}`, `hello`, `\r`, `{until: COMPOSER_READY, wait:15.0}`, `ctrl+y` (0x19), `{until: COMPOSER_READY, wait:10.0}`.
- Asserzioni: `frame.toContain("thinking levels not offered fo")` (budget a 100 col = 32 char, la needle di 30 è esattamente ciò che sopravvive al cap); `status && status.width <= 100`.
- Pty necessario? Solo per il `ctrl+y` in raw mode e l'avvio reale.

## 7. `markdown-live-continuity.pty.test.ts` — `an open Markdown item is readable before its semantic close`
- `cols: 149`, `rows: 40`; `config` con `mode:"vibe"`, `showReasoning:false`, provider fake; `tail: 40`. Timeout 30_000.
- Fixture inline: `{role:"assistant"}`, `"Architecture overview.\n\n"`, sleep 250 ms, `"1. **Core headless** OPEN-ITEM-ALREADY-SENT is readable while the provider has not closed this item"` (set `sentOpenItem = true`), poi **blocca su una promise `held`** fino al `finally`, poi `".\n\nReply complete."`, `stop`, `[DONE]`.
- Script: `{wait:1}`, `architecture`, `\r`, `{wait:12, until:"OPEN-ITEM-ALREADY-SENT", untilFromBuffer:true}`, `{wait:3, checkpoint:"openItem"}`.
- Asserzioni: `sentOpenItem === true`; `meta.aliveAtEnd === true`; sul checkpoint `openItem`, `visible = [...scrollback, ...lines]` → `toContain("Architecture overview.")` e `toContain("OPEN-ITEM-ALREADY-SENT")`.
- Proprietà: la proiezione Markdown viva rende progressivamente l'item non chiuso invece di nasconderlo fino alla chiusura semantica.
- Misura: flag del fixture, `aliveAtEnd`, **checkpoint** (schermo **+ scrollback**: l'unica coppia che attraversa entrambe le regioni).
- Dipendenza dal tempo: l'item è inviato 250 ms dopo il primo chunk; il checkpoint 3 s dopo deve cadere dopo che il cursore della reveal ha superato l'item (~333 c/s di base) e dopo la promozione.

## 8. `modal-return-anchor.pty.test.ts` — 1 test, **`test.skip`**
- Il describe è attivo, l'unico test è `test.skip`: **niente di questo file gira oggi**; nessun altro `test(`, nessun helper morto.
- Nota nel file (verbatim): "UNBLOCKING EVIDENCE (2026-09-25): #441 era esposizione al carico … il test è stato rieseguito senza skip: 3/3 verde a 32.5s (varianza <200ms), dentro il kill a 45s. … Non ancora tolto lo skip: sul runner CI a 2 vCPU lo stesso script chiede un margine più largo … Per ripristinare, cancellare `.skip` e confermare che il job tui-pty resti verde; il fallback è togliere il terzo turno … più budget di settle da 3s." E il caveat per turno: il provider demo risponde sempre lo stesso testo, quindi la `until: "Hello from moh"` dopo i turni 2 e 3 **non è** una prova di readiness per turno sotto #1045: "se mai questo test viene riattivato, dare a ogni turno una needle unica".
- `cols: 100`, `rows: 30`; `project: {provider:"mock"}`; `tail: 30`; timeout 90_000.
- Script: `{wait:2.0}`, `\r`, `{wait:5.0, until: COMPOSER_READY}`, `one\r`, `{wait:4.0, until:"Hello from moh"}`, `two\r`, idem, `three\r`, idem, `world` (bozza non inviata), 0.6, `ctrl+s` (settings, alt screen), `{wait:8.0, until:"Default permission mode"}`, `esc`, `{wait:1.5}` (> `ALT_FLIP_DELAY_MS = 40`).
- Asserzioni (tutte su righe-indice della schermata):
  1. `inputRow = lines.findIndex(l => l.text.includes("world"))` → `≥ 0` (la riga di input è a schermo).
  2. `chipsRow ≥ lines.length - 2` (la riga dei chip è l'ultima non vuota).
  3. `inputRow ≥ lines.length - 8` (l'input sta nel chrome basso).
  4. `inputRow < chipsRow`.
  5. `lines.filter(l => l.text.includes("Hello from moh")).length ≥ 2` (il transcript è sopravvissuto al ciclo in alt screen).
- Proprietà (dall'header): dopo un ciclo di modale in schermo alternativo il frame della sessione deve ridipingersi in place — riga di input e barra inferiore ancorate alle righe basse.
- Pty necessario? **Sì**: salvataggio/ripristino dello schermo alternativo (`\x1b[?1049h`/`\x1b[?1049l`), che Ink emette solo con `isTty`.
- Dipendenza dal tempo (se riattivato): le tre wait da 4.0 s sono **standby**, non prove per turno; il tutto è budgetato contro il **kill a 45 s** (misurato 32.5 s, varianza <200 ms).

## 9. `natural-scrollback.pty.test.ts` — `reasoning and an open long Markdown reply advance native scrollback`
- `cols: 100`, `rows: 24`; config con `mode:"vibe"`, `showReasoning:true`, endpoint con `capabilities.thinking`; `tail: 24`; `rawDump: "/tmp/moh-natural-scrollback.bin"`; timeout 45_000 (= kill del runner).
- Fixture: **45** delta `reasoning_content` `REASONING-ROW-NN …\n` (15 ms l'uno), poi `"## Architecture\n\n1. **REPLY-FIRST-ROW** "`, poi **65** delta `DETAIL-NN …` (20 ms), poi `"REPLY-LIVE-TAIL"` (set `emittedTail`), poi **blocca su `held`** fino al `finally`, poi `"\n\nReply complete."`, `stop`, `[DONE]`.
- Script: `{wait:1}`, `explain the architecture`, `\r`, `{wait:30, until:"REPLY-LIVE-TAIL"}`, `{wait:22, checkpoint:"longOpenReply"}`.
- Asserzioni:
  1. `emittedTail === true`; 2. `meta.aliveAtEnd === true`;
  3. checkpoint `longOpenReply`: `screen.toContain("REPLY-LIVE-TAIL")` (sul **fisico**, non solo scrollback);
  4. `raw.toContain("REASONING-ROW-00")` (dipinto prima che la risposta finisse: "l'accounting dello scrollback varia col pump sotto carico, il flusso grezzo no");
  5. `raw.toContain("REPLY-FIRST-ROW")`;
  6. `first = raw.lastIndexOf("REPLY-FIRST-ROW"); first > 0`;
  7. `raw.slice(first).split("REPLY-FIRST-ROW").length - 1 === 1` — **esattamente una volta**: da l'ultima pittura in poi, una riga promossa non viene mai ristampata;
  8. `raw.indexOf("REASONING-ROW-44") < raw.indexOf("REPLY-FIRST-ROW")` — il reasoning ha avanzato lo scrollback prima della risposta.
- Proprietà: le righe vecchie della risposta devono raggiungere lo scrollback **prima** della chiusura semantica; promozione esattamente-una-volta; ordine reasoning→risposta.
- Dipendenza dal tempo: il test più sensibile all'orologio. 45 × 15 ms = 0.675 s di reasoning, 65 × 20 ms = 1.3 s di dettaglio: `REPLY-LIVE-TAIL` è *streammato* ~2 s dopo l'inizio ma *dipinto* quando il cursore arriva (~1.3–6.6 s); la `until` (30 s) più il pump fisso di **22 s** congelano il frame: che la needle sia ancora sul fisico a 24 righe è la scommessa temporale portante.
- Pty necessario? Lo scrollback nativo in sé (le righe devono *uscire* dallo schermo fisico); un fake tty in-process con scrollback emulato potrebbe osservare le stesse invarianti.

## 10. `typewriter-reveal.pty.test.ts` — `a burst reply is revealed progressively, not in one block`
- `cols: 100`, `rows: 30`; **`env: {MOH_TYPEWRITER_MS:"60", MOH_TYPEWRITER_CHARS:"10"}`**; config con `mode:"vibe"`, provider fake; `tail: 30`; timeout **20_000**.
- Fixture: `{role:"assistant"}` e **un solo burst** `BURST-START ` + (`"the core owns the agent loop and every client only projects its events while the reveal advances "` × 9) + `BURST-END` (≈1 083 char, prosa senza punteggiatura), set `sent = true`, poi **tiene aperta la risposta per 9000 ms**, poi `stop`, `[DONE]`.
- Script: `{wait:1}`, `burst`, `\r`, `{wait:5, until:"BURST-START", untilOnScreen:true, checkpoint:"midReveal"}`, `{wait:2.5, checkpoint:"progressed"}`, `{wait:10, until:"BURST-END", untilOnScreen:true, checkpoint:"lateReveal"}`.
- Helper `revealedChars(snapshot)`: unisce scrollback + righe, trova `BURST-START` e misura fino al primo di `BURST-END`/`COMPOSER_READY`/`"⏎ send"`.
- Asserzioni: `sent === true`; `meta.aliveAtEnd === true`; su `midReveal`: `toContain("BURST-START")`, `not.toContain("BURST-END")`, `not.toContain("✓ done")`; su `progressed`: `not.toContain("✓ done")`, `revealedChars(progressed) >= revealedChars(early) + 100`; su `lateReveal`: `toContain("BURST-END")` e `split("BURST-END").length - 1 === 1`.
- Proprietà: un burst grande viene rivelato progressivamente (word-flow) e il testo finale appare una volta sola.
- Dipendenza dal tempo (quantitativa): con 10 char/60 ms la base è 167 c/s, il boost su un deficit di ~1 083 porta a ~528–833 c/s → il burst si drena in **≈1.3–6.5 s**. (3b) richiede che il campione cada dentro quella finestra; (4b) richiede ≥100 char di progresso nei 2.5 s successivi (≈4 tick: garantiti dalla base, ≈130 col boost). (3c)/(4c) valgono solo finché l'hold di 9000 ms è aperto.
- Pty necessario? La *pacing* è osservata attraverso la cadenza reale dei repaint con i due env iniettati; il pacer è stato di proiezione, quindi un fake tty con la stessa size e gli stessi env osserverebbe la stessa proprietà.

## 11. Cosa legge davvero ogni asserzione (consolidato)

| test | `lines` | `scrollback` | dump grezzo | checkpoint | contatori `meta.*` | flag fixture |
|---|---|---|---|---|---|---|
| home-banner 2.1 | 5 | — | — | — | — | — |
| home-compact 3.1 | 2 | — | `\x1b[2J\x1b[3J\x1b[H` ×0 | — | — | — |
| home-compact 3.2 | — | — | idem ×0 | — | — | — |
| home-compact 3.3 | 4 | — | — | — | — | — |
| home-compact 3.4 | 1 (negativa) | — | — | — | — | — |
| nocolor 4.1 | — | — | COLOR=0, BOLD>0, DIM>0 | — | — | — |
| nocolor 4.2 | — | — | COLOR>0, `"Hello from moh"` | — | — | — |
| image-preview 5.1 | 1 (negativa) | — | `"\x1b]1337;File="` | — | — | — |
| image-preview 5.2 | — | — | `"\x1b_Gf=1,a=T,"` | — | — | — |
| reasoning-controls 6.1 | 3 | — | — | — | — | — |
| reasoning-controls 6.2 | 2 | — | — | — | — | — |
| markdown-live-continuity 7.1 | (via checkpoint) | (via checkpoint) | — | `openItem`: lines **+ scrollback** | `aliveAtEnd` | `sentOpenItem` |
| modal-return-anchor 8.1 (skip) | 5 (indici) | — | — | — | — | — |
| natural-scrollback 9.1 | (via checkpoint) | — | 4 needle + aritmetica su indici | `longOpenReply`: lines | `aliveAtEnd` | `emittedTail` |
| typewriter-reveal 10.1 | (via checkpoint) | (via checkpoint) | — | 3 checkpoint: lines **+ scrollback** | `aliveAtEnd` | `sent` |

**Nessuna asserzione di questi nove file legge `maxFrameRows`, `fullscreenFrames`, `frames`, `framesAfterMark`, `fullscreenAfterMark`, `maxFrameRowsAfterMark`, `exited` o `exitCode`** — quei contatori appartengono a `streaming-persistence`/`home-compact`-style #1022. Nessun `mark`/`markEnd` e nessun `resize` in questi file.

## 12. Sintesi degli skip

- Tutti i nove file sono gated da `skipIf(!hasPython)`: senza `python3` nel PATH **tutte le 15 dichiarazioni spariscono in silenzio**.
- `modal-return-anchor` ha un solo test ed è `test.skip`: un oracolo di regressione parcheggiato e documentato, con istruzioni di ripristino esplicite.

## 13. Interni del harness su cui la baseline conta

- Lancia `bun <REPO_ROOT>/packages/cli/src/cli.ts` con `stdin=stdout=stderr=slave`, cwd e `HOME` temporanei, `TERM=xterm-256color`, `COLORTERM=truecolor`, `CI` rimosso, `preexec_fn` con `os.setsid()` + `TIOCSCTTY`.
- Modello di schermo: emulatore VT100 minimale (CUU/CUD/CUF/CUB, ED, EL, CUP/CHA, CR/LF/BS, autowrap, SU/SD, DECSTBM, DECSET 1049, DECSET 2026) che ignora SGR/OSC; lo scrollback riceve le righe spinte fuori ed è azzerato da `ED(3)`; `lines()` rstrippa.
- Le righe riportate sono le **ultime `tail`**; `rawDump` scrive l'intero flusso cumulativo — è da lì che le asserzioni di churn contano `\x1b[2J\x1b[3J\x1b[H` (ED2+ED3+CUP, il percorso fullscreen di Ink).
- `prune_stale_pty_tmp()` gira al massimo una volta l'ora e cancella i `moh-pty-*` più vecchi di 2 giorni.
- Dettaglio di protocollo da segnalare: il docstring dice "uno spec JSON su stdin, un array JSON su stdout", ma l'implementazione legge `json.loads(sys.argv[1])` ed emette **un oggetto JSON**.
