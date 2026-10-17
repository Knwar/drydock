# System font stacks

Mockups cannot load web fonts, so typography is chosen among faces that ship with operating systems. Each stack lists a macOS/iOS face, a Windows face, then Linux/Android fallbacks and a generic family. The first available face wins, so the same mockup renders differently per OS: pick stacks whose fallbacks share the character you want, and look at the fallback too, not only the first face.

| Character | Stack |
|---|---|
| Neutral UI sans | `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` |
| Humanist sans (warmer, rounder) | `Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", sans-serif` |
| Rounded sans (friendly, consumer) | `ui-rounded, "Hiragino Maru Gothic ProN", "Arial Rounded MT", Calibri, sans-serif` |
| Industrial / condensed (data-dense, signage) | `Bahnschrift, "DIN Alternate", "Franklin Gothic Medium", "Nimbus Sans Narrow", sans-serif` |
| Transitional serif (readable body, editorial) | `Charter, "Bitstream Charter", "Sitka Text", Cambria, serif` |
| Old-style serif (bookish, literary) | `"Iowan Old Style", "Palatino Linotype", Palatino, "URW Palladio L", P052, Georgia, serif` |
| Didone (fashion, luxury display only) | `Didot, "Bodoni MT", "Noto Serif Display", serif` |
| Monospace (code, tabular data only) | `ui-monospace, "SF Mono", "Cascadia Code", "Segoe UI Mono", Menlo, Consolas, "Liberation Mono", monospace` |

Guidance:
- One stack for body and UI, optionally a second, clearly different stack for display. Distinct means different classification (serif display over sans body), not two similar sans faces.
- Didone and condensed faces are for large sizes only; never set body copy in them.
- Character can also come from treatment rather than face: weight contrast, tight tracking on large display sizes (around -0.01 to -0.02em), generous size steps, `font-variant-numeric: tabular-nums` for figures in tables.
- Monospace is for code and aligned numbers, not decoration (see the template-chrome tells in the main skill).
