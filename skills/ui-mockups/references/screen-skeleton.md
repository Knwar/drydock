# Screen skeleton

A starting point for one screen file. Replace the token values with the product's tokens, keep the structure. Every screen in the set starts with the identical `:root` block.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Projects | Fieldnote</title>
<style>
:root {
  /* Colour roles */
  --color-bg: #fbfaf7;
  --color-surface: #ffffff;
  --color-surface-muted: #f1efe9;
  --color-text: #1d1b16;
  --color-text-muted: #5c574c;
  --color-border: #ddd8cc;          /* dividers only */
  --color-border-control: #857f71;  /* input and control outlines: 3:1 or more */
  --color-primary: #1f5c4a;
  --color-on-primary: #ffffff;
  --color-accent: #b4482c;
  --color-danger: #a8261b;
  --color-success: #23683a;
  --color-focus: #1f5c4a;

  /* Type */
  --font-body: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-display: Charter, "Bitstream Charter", "Sitka Text", Cambria, serif;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-lg: 1.25rem;
  --text-xl: 1.5625rem;
  --text-2xl: 1.953rem;
  --leading-tight: 1.2;
  --leading-body: 1.55;

  /* Space, radius, elevation */
  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem;
  --space-6: 1.5rem; --space-8: 2rem; --space-12: 3rem; --space-16: 4rem;
  --radius-sm: 4px; --radius-md: 8px; --radius-full: 999px;
  --shadow-overlay: 0 8px 24px rgb(29 27 22 / 0.16);
}

*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: var(--color-bg); color: var(--color-text);
  font: var(--text-base)/var(--leading-body) var(--font-body); }
a { color: var(--color-primary); }
:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 2px; }
.skip { position: absolute; left: -999px; }
.skip:focus { left: var(--space-4); top: var(--space-4); }

/* Layout: mobile first */
.app { display: grid; min-height: 100vh; min-height: 100dvh; grid-template-rows: auto 1fr auto; }
.sidebar { display: none; }
main { padding: var(--space-4); max-width: 72rem; width: 100%; margin: 0 auto; }

@media (min-width: 64rem) {
  .app { grid-template-columns: 15rem 1fr; grid-template-rows: 1fr; }
  .topbar, .tabbar { display: none; }
  .sidebar { display: block; }
  main { padding: var(--space-8) var(--space-12); }
}

/* Components: copy these unchanged between screens */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);
  min-height: 44px; padding: 0 var(--space-4); border-radius: var(--radius-md);
  font: inherit; font-weight: 600; text-decoration: none; border: 1px solid transparent; cursor: pointer; }
.btn-primary { background: var(--color-primary); color: var(--color-on-primary); }
.btn-secondary { background: transparent; color: var(--color-primary); border-color: var(--color-border-control); }

@media (prefers-reduced-motion: no-preference) {
  .btn { transition: background-color 120ms ease; }
}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="app">
  <header class="topbar"><!-- mobile header --></header>
  <nav class="sidebar" aria-label="Main"><!-- desktop navigation: links to the other screens --></nav>
  <main id="main">
    <h1>Projects</h1>
    <!-- real content -->
    <a class="btn btn-primary" href="project-new.html">New project</a>
  </main>
  <nav class="tabbar" aria-label="Main"><!-- mobile navigation --></nav>
</div>
<footer><a href="index.html">All screens</a></footer>
</body>
</html>
```

Notes:
- The example palette is illustrative; check every text/background pair you actually use against WCAG AA before shipping a set.
- Icons: inline `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">…</svg>` with `stroke="currentColor"` so they follow text colour.
- Forms: `<form action="project-created.html" method="get">` with a submit `<button>`; no `required`.
- In-page dialog without script: a link to `#confirm-delete`, and `#confirm-delete:target { display: grid; }` on an overlay that is hidden by default, with a "Cancel" link to the screen's own file (e.g. `href="project-detail.html"`), which clears the target. When in doubt, make the dialog its own screen file.
- Loading skeleton: grey blocks sized like the real content (`background: var(--color-surface-muted); border-radius: var(--radius-sm);`), plus an optional shimmer inside the reduced-motion media query.
