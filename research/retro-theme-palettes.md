# Research: Authentic palette hex values for C64, Amiga Workbench, Green Phosphor TUI themes

## Commodore 64 (VIC-II PAL)
The iconic boot screen: light blue border, darker blue background, light blue text.
VIC-II 16-color palette, authoritative values (Pepto's widely-used C64 palette, the de-facto standard reference, pepto.de/projects/colors/):
- Border / text: light blue #7869C4 (Pepto) — some sources #7B70FF or #6C6EB6 (colodore). Pepto's is the most-cited: 0x7869C4.
- Background: blue #40318D (Pepto) — colon 0x5D509F or 0x4A41C6 appear in colodore variants.
- Green #883932? No — green is #59A349 (Pepto). Light green #94E089. Black #000000 / #3536A7? black = #000000, dark gray #6C6C6C, light gray #959595, white #FFFFFF, red #883932, cyan #67B6BD, purple #6C4FC9, yellow #B8B445, orange #6D5412? orange = #6D5412 (Pepto orange is dark).
For a TUI we mainly need: bg #40318D, border-accent light blue #7869C4, white #FFFFFF, light green #94E089, gray #6C6C6C, yellow #B8B445.
References: pepto.de/projects/colors/ (Pepto palette), colon database colodore (kabtor.github.io/colodore/).

## Amiga OS (Workbench 1.3 / classic Kickstart look)
Workbench 1.x palette: blue #0055AA (or #0055FF), white #FFFFFF, black #000000, orange #FF8800 (or #FF9900).
- The classic 4-color Workbench: blue background #0055BB (commonly cited #0055AA), white, black, orange #FF9900.
- Workbench 2.0+ grays: #AAAAAA, #777777, #000000.
Authoritative sources: Amiga Workbench 1.3 screenshots (back to roots), Wikipedia "Workbench" article; commonly cited: blue=RGB(0,85,170)=#0055AA, orange=RGB(255,153,0)=#FF9900, white #FFFFFF, black #000000.
For TUI: bg #0055AA, accent (windows/borders) white or #AAAAAA, text white, warn/selection orange #FF9900, dim #7A7A7A or #9999BB on blue.

## Green phosphor terminal (P1 phosphor, e.g. DEC VT220 green / IBM 3270 green)
- Background: near-black, often #000000 (purists) or #001100/#0B0F0A with slight green cast.
- Foreground green: canonical #00FF00 (pure) — real P1 phosphor is softer/more yellow-green; popular terminal emulator values: #33FF33, #00FF66, #66FF66, #00C853. "Matrix" theme commonly #00FF41 (IMDb terminal). DEC-style: #00B000? Many references use #2EFE2E or #41FF00.
- For perfect reproduction the safe canonical choice: bg #000000, fg #00FF00 pure green (classic), dim #008800/#00AA00, mid #00CC00. Monochrome theme: ALL semantic colors are shades of green (warn = brighter green + blink not available; use bold).
References: Wikipedia "Phosphor" (P1 green ~ wavelength 525nm), terminal color schemes (iterm2colorschemes "Matrix" #00FF00 on black, "Greenscreen" #00BB00).
