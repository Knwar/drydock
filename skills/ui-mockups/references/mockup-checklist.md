# Pre-delivery checklist

Go through every item for the whole set, not only the screen you just built.

## Format
- [ ] Each screen is one `.html` file that opens directly from disk and looks right.
- [ ] No `<script>`, no `on…=` attributes, no `javascript:` links.
- [ ] No `http://` or `https://` resource anywhere: no font, stylesheet, image or icon by URL (outbound example links in content are the only exception, and are rare).
- [ ] The `:root` token block is identical in every file; components use `var(--…)`, no stray hex values or one-off pixel sizes.
- [ ] `<html lang>`, charset, viewport meta and a screen-specific `<title>` are present.

## Navigation
- [ ] `index.html` lists every screen and state, grouped by flow, each with a one-line note.
- [ ] Every screen is reachable from the index; every flow can be clicked through start to finish.
- [ ] No broken relative links (each `href` matches an existing file name exactly) and no `href="#"`.
- [ ] Forms submit to the next screen; nothing blocks the click-through.

## Design
- [ ] One primary action per screen; secondary and destructive actions visually distinct.
- [ ] Spacing, type sizes, radius and elevation all come from the token scales.
- [ ] Shared components (header, nav, buttons, inputs, cards, empty states) are identical across screens.
- [ ] Hover, focus-visible, active, disabled and selected states are styled.
- [ ] The design plan's one memorable idea is visible; none of the default AI-design tells crept in unchosen.

## Content
- [ ] Realistic, consistent content: same user, same numbers and names across screens; no lorem ipsum or "Item 1".
- [ ] Buttons name their action; an action keeps the same word through the flow.
- [ ] Empty, loading and error states exist wherever data can be missing, slow or fail; errors say what happened and what to do.

## Responsive
- [ ] Checked at about 375px and about 1280–1440px: no horizontal page scroll, nothing clipped or overlapping.
- [ ] Navigation adapts between mobile and desktop.
- [ ] Touch targets at least 44×44px on mobile; body measure under 80 characters on desktop.

## Accessibility
- [ ] Text contrast at least 4.5:1 (large text 3:1); focus indicators and control boundaries at least 3:1.
- [ ] Landmarks (`header`, `nav`, `main`), headings in order, real buttons and links, labelled inputs.
- [ ] Decorative SVG hidden from assistive tech; meaningful SVG labelled.
- [ ] Colour is never the only signal; animation sits behind `prefers-reduced-motion: no-preference`.
