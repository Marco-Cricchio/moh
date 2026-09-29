# Baseline — le asserzioni della suite PTY (#1055, ticket T2 della catena #1052)

Catturata **prima** di toccare qualsiasi cosa, come richiede la catena: ogni spostamento di
test successivo (T3-T9) si accetta per **uguaglianza di comportamento** contro questo record,
mai "perché è verde". Fonte: i corpi dei test, letti come checklist.

## Cosa c'è qui

| file | contenuto | test |
|---|---|---|
| `part-a-streaming-persistence.md` | `streaming-persistence.pty.test.ts` (1.148 righe) — la famiglia che ha prodotto il rosso di #1052 | 15 |
| `part-b-layout-and-harness.md` | il harness (`harness.py`, `pty-runner.ts`, vocabolario degli step), `home-banner`, `home-compact`, `nocolor`, `image-preview`, `reasoning-controls`, `markdown-live-continuity`, `modal-return-anchor`, `natural-scrollback`, `typewriter-reveal` | 14 + 1 saltato |
| `part-c-askuser-and-fixtures.md` | `pty-layout` (6), i quattro test ask-user (4), e i fixture `fake-openai*.ts` con cadenze e hold | 10 |

**Totale suite PTY: 30 test in 14 file, 2.860 righe di test + 680 di harness.**

## I numeri che contano (baseline della transizione)

- **Attese**: 49 `until:`, di cui **2** con `untilFromBuffer` e **9** con `untilOnScreen`; **170 `wait: N` fissi** (sonno, non attesa di stato).
- **Letture**: il dump grezzo è letto in **103** punti, `clearTerminal`/ED in **21**, il fullscreen in **14**, `meta.scrollback` in **7**; nessuna asserzione della famiglia layout legge i contatori di frame (`frames`, `maxFrameRows`, `fullscreen*`) — quelli appartengono a `streaming-persistence`/`home-compact`.
- **Job CI**: `tui-pty` 11m26s contro `tui-unit` 2m33s.
- **Runtime non pinnato**: la CI installa `bun-version: latest` (il runner ha riportato 1.4.2) mentre un checkout locale gira 1.2.19 — la stessa suite, due runtime, nessun commit.
- **Ambiente ereditato**: il harness rimuove solo `CI`; `spec.env` si sovrappone al resto senza rimuovere nulla. Quindi `nocolor` e `image-preview` **dipendono dall'ambiente del genitore** (vedi part-b §4, §5).

## Anomalie trovate scrivendo la baseline

Da consegnare ai ticket che spostano i test; nessuna è stata corretta qui.

1. **Asserzione vacua** — `streaming-persistence` test «reasoning past the display cap repaints once, not per frame»: `raw.split("CAP-THINK-0000")` conta una stringa che il fixture **non emette mai** (i suoi marker sono `PIECE-0001…NN`). Il conteggio è sempre 0, l'assert passa sempre, e il "reprint once" del nome non è misurato. Anche `PIECE-0000` non esiste (pre-incremento).
2. **`modal-return-anchor`**: l'unico test è `test.skip` — un oracolo parcheggiato con istruzioni di ripristino, e un caveat dichiarato: se riattivato, ogni turno vuole una needle unica (il provider demo ripete la stessa risposta).
3. **Import morto** in `pty-layout.test.ts` (`COMPOSER_COMPACT` mai usato); **dump dichiarato e mai usato** in `streaming-persistence` test 12; **checkpoint morto** (`afterCycle1`) nel test 15.
4. **Margini wall-clock stretti**: `streaming-persistence` test 7 assert 4 (≈0.3 s) e test 4 assert 2 (≈1.0 s); tre test con timeout `45_000` **pari** al SIGKILL del runner, quindi nessun margine fra "test in timeout" e "harness ucciso".
5. **Sensibilità al genitore**: `nocolor` 4.1 richiede `FORCE_COLOR` ereditato per le asserzioni su bold/dim; il suo controllo 4.2 fallisce se la shell esporta `NO_COLOR=1`; `image-preview` 5.1 fallisce se l'ambiente esporta `KITTY_WINDOW_ID`/`GHOSTTY_RESOURCES_DIR` (kitty è controllato prima di iTerm2).
6. **Tutti i file spariscono in silenzio senza `python3`** (`skipIf(!hasPython)`): 30 test che diventano 0 senza un segnale.

## Come si usa

- **T3 (=#1056)**: prende dalla part-a e dalla part-b le proprietà non terminali (promozione esattamente-una-volta, ordine reasoning→reply, bound di output, confine assestato) e le porta al livello 0.
- **T4 (=#1057)**: dalla part-b §0 e §13 ricava il vocabolario che il terminale finto deve riprodurre (schermo fisico, scrollback, altezza dei frame, ED2/ED3, alt-screen, sync block).
- **T5 (=#1058)**: i guardiani — `clearTerminal` in part-b §3, §4, `fullscreen`/`maxFrameRows` in part-a §3, §5, §6, layout compatti in part-b §2, §3.
- **T6 (=#1059)**: la famiglia streaming, part-a §1-§15, con i suoi `checkpoint` (schermo **+** scrollback).
- **T7 (=#1060)**: i quattro ask-user, part-c §4, con i loro `rawDump` e le finestre inattive.
- **T8 (=#1061)**: part-c §8 dice riga per riga cosa resta davvero al pty vero (avvio CLI, tasti raw, alt-screen, SIGWINCH, protocolli immagine, `--no-color` a livello di byte).
- **T9 (=#1062)**: la part-b §0 e §13 (modello VT100, sync block, scrollback) sono la specifica di ciò che il test di parità deve confrontare.

## Limite noto di questo record

La baseline descrive **ciò che i test asseriscono oggi**, non ciò che *dovrebbero* asserire: le
proprietà che oggi passano per costruzione (per esempio la larghezza di riga sotto il harness) sono
registrate come tali, senza gonfiarle a copertura. Dove un'asserzione è vacua, è scritto.
