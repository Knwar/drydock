---
name: ui-mockups
description: Use when designing an app's UI as static, clickable HTML mockups: one self-contained file per screen, inline CSS, no JavaScript, linked screens, token-driven styling, mobile and desktop layouts, and empty, loading and error states drawn as their own screens.
---

# UI Mockups

Approach this as the design lead at a design studio known for giving every client a distinct visual identity that is not mistaken for anyone else's. This client has already rejected proposals that felt cliché or templated, and is paying for a distinctive point of view: make deliberate, opinionated choices about palette, typography, and layout that are specific to this brief, and take aesthetic risk if justified.

The deliverable is a set of static HTML mockups that a person can click through in a browser. The hard rules for that format are in "Mockup rules" below; everything else in this skill is about making the screens good.

## Ground your designs in the subject matter

If the brief does not identify what the product or subject matter is, identify it yourself before designing, and confirm with the user. You can come up with one concrete subject, the design's audience, and the design's primary job, as a proposal. If there's any information about the user's preferences or context about what they're building, use that as a hint. The subject's industry, subject matter, materials, and vernacular are where distinctive visual choices come from — a design for a toy for girls aged 8–11 will be very aesthetically different from a dashboard for financial analysts. Build with the brief's real content and subject matter throughout.

If brand guidelines and design tokens already exist for the product, they are the brief's visual direction: use their colours, type, spacing and voice exactly, and spend your own judgment on layout, hierarchy and flow.

## Design principles

For web designs, the hero is the first thing viewers will see. Open with the most characteristic thing in the subject's world, in the form that is most appropriate: a headline, an illustration drawn in inline SVG or CSS, or a representative slice of the real product UI. Be deliberate with your choice: a big number with a small label, supporting stats, and a gradient accent is the default treatment, so only use it if that's truly the best option.

Typography carries the personality of the page. You don't need a different typeface for display or headline text and body content: use one family or two, and if two, make them clearly distinct.

Choose your typefaces deliberately, not the default stack you would reach for on any other project, and set a clear type scale following the default guidance of The Elements of Typographic Style with intentional weights, widths, and spacing. Mockups use system font stacks only (no web fonts), so the choice is among the faces that ship with operating systems; see references/system-font-stacks.md. When type is used as a headline or visual element, use the type treatment itself as an active part of the design, not a neutral delivery vehicle for the content.

Default to line lengths of less than 80 characters. Serif typefaces can have slightly longer line lengths; give serif body text slightly more line-height than a sans-serif.

Avoid these default typographic treatments; they are the commonest tells of a generated page:
- Accenting just a single word or phrase in a headline, like putting one word in italic/bold or a different color.
- Using all caps for labels.
- Adding unnecessary typographic labels above content.

Visual structure is information. Structural devices like outlines, borders, numbering, eyebrows, dividers, labels, etc., encode useful information about the content rather than decorate it. Many generic designs use numbered markers (01 / 02 / 03), but that's only appropriate if the content actually is a sequence — like a stepped process or a timeline. Before adding numbered markers, check the content really is a sequence.

Mockups are static, so motion is limited to CSS. Use it sparingly: hover, focus and pressed states that show what is clickable, and at most one deliberate moment (for example a loading skeleton's shimmer). Fade-and-slide-up entrances on each section and hover transitions on every card are the generic default and read as AI-generated. Wrap any animation in `@media (prefers-reduced-motion: no-preference)`.

Consider written content carefully. Often a design brief may not contain real content, and it's up to you to come up with copy and placeholder content. Copy can make a design feel as templated as the design itself. See the below section on writing for more guidance.

## Process: plan, review against the brief, build, critique

For calibration, AI-generated design right now clusters around some traits:
1. a warm cream background (near #F4F1EA) with a high-contrast serif display and a terracotta or warm-clay accent (often near #D97757 — Anthropic's own Claude-interaction accent, so on a user's brief it reads as a tell);
2. a near-black background with a single bright acid-green or vermilion accent;
3. a broadsheet-style layout with hairline rules, zero border-radius, and dense newspaper-like columns;
4. the SaaS-card kit: content chopped into identical rounded cards, one border-radius on everything regardless of hierarchy, the same soft grey shadow (rgba(0,0,0,.1)) under each, and gradient washes as decoration;
5. template chrome that appears whatever the subject: a tracked-out ALL-CAPS eyebrow label above every heading; meta strings joined with middle dots ('A · B · C'); labels built as 'WORD — fragment' with a spaced em dash; tinted near-black (#0B0B0B, #111) standing in for black; a monospace face for small data labels; a '→' appended to link and button text.

All traits are legitimate for some briefs, but they are defaults rather than choices, and they appear regardless of subject. Where the brief pins down a visual direction, follow it exactly — the brief's own words always win, including when it asks for one of these looks. Where it leaves an axis free, don't spend that freedom on one of these defaults. As with a hired human designer, there's often a careful balance between doing what you're good at and taking each project as a chance to experiment and learn.

Work in two passes. First, brainstorm a short design plan based on the design brief: create a compact token system with color, type, layout, and principles (or take it from the existing design tokens).
- Color: describe the core base palette as 4–6 named hex values.
- Type: the typefaces and their roles.
- Layout: a layout concept, using one-sentence prose descriptions and ASCII wireframes to ideate and compare. Include alignment guidance; should the content be left aligned, center aligned, justified?
- Principles: the high-level guidance for what makes this design unique.
- Screens: the screen list and the flows that connect them (see "The screen set").

Then review that plan against the brief before building: if any part of it reads like the generic default you would produce for any similar product (work through a similar prompt to see if you arrive somewhere similar) rather than a choice made for this specific brief — revise that part, say what you changed and why. Only after you've confirmed the relative uniqueness of your design plan should you start building screens, following the revised plan.

When writing the CSS, be careful of structuring your selector specificities. It's easy to generate CSS classes that cancel each other out (especially with a type-based selector like .section and an element-based selector like .cta). This can happen often with padding/margin between sections.

## Mockup rules: static HTML, no JavaScript

These are the craft rules for the format. Break none of them.

1. **One self-contained file per screen.** Each file opens on its own from disk: `<!doctype html>`, `<html lang>`, `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width, initial-scale=1">`, a `<title>` naming the screen, and one `<style>` block in the head. Skeleton in references/screen-skeleton.md.
2. **No JavaScript.** No `<script>`, no `on*` attributes, no `javascript:` URLs. Interaction is links, native HTML and CSS only.
3. **No external resources.** No web fonts, CDNs, stylesheets, or images by URL. Use system font stacks; draw icons, logos and illustrations as inline SVG or CSS shapes. Inline SVGs that are decorative get `aria-hidden="true"`; meaningful ones get `role="img"` and an `aria-label`.
4. **Tokens as CSS custom properties.** Every file starts its `<style>` with the same `:root { … }` token block, copied identically; components use `var(--…)` only, never raw hex or ad-hoc pixel values. If a token changes, it changes in every file.
5. **Screens link with relative links**, e.g. `href="settings.html"`. Every link and button that would navigate in the real product goes to the screen it would show. A control whose destination is not mocked links to the closest relevant screen or is visibly inert (styled as such, no `href`), never to `#`.
6. **Forms navigate.** Wrap form controls in `<form action="next-screen.html" method="get">` so the submit button moves the flow on. Do not add `required` or pattern validation that would block a click-through; show validation failure as its own error screen instead.
7. **Native interactivity is allowed.** `<details>/<summary>` for disclosures and accordions, `:hover`, `:focus-visible`, `:active`, `:checked` and `:target` for in-page panels or a dialog overlay. Anything that needs real state (a modal over a specific screen, a selected tab) can also be its own screen file.
8. **Mobile and desktop in one file.** Mobile-first CSS with `min-width` media queries at content-driven breakpoints. Check each screen at a phone width (around 375px) and a desktop width (around 1280–1440px): no horizontal scroll, navigation adapts (for example a bottom or top bar on mobile, a sidebar on desktop).
9. **Realistic content.** Real names, plausible numbers, dates, prices and messages from the product's world, consistent across screens (the user who signs in is the same user on every screen). No lorem ipsum, no "Item 1 / Item 2", no "John Doe".
10. **States are designed, not implied.** Wherever data can be absent, slow or fail, draw it: an empty state, a loading state (static skeleton blocks in the shapes of the real content), and an error state with what happened and what to do next. Give each its own screen (`inbox-empty.html`, `inbox-loading.html`, `inbox-error.html`) or, for small components, a labelled section on the screen.

## The screen set

1. **List the flows first**: the primary job end to end (for example sign up → set up → first use → result), then secondary flows (settings, account, billing if relevant). Each flow is a sequence of screens.
2. **Name files by screen and state**: lowercase, hyphenated, flat in one folder: `index.html`, `signup.html`, `dashboard.html`, `dashboard-empty.html`, `project-detail.html`, `settings.html`.
3. **Build an index page (`index.html`)** that is not part of the product: the product name, one line on what it is, and every screen grouped by flow with its state variants, each a link with a one-line note of what it shows. It is the map a reviewer starts from. Style it with the same tokens.
4. **Reachability**: every screen is linked from the index, and every screen in a flow links forward to the next one. A small, unobtrusive "All screens" link back to the index (a corner link in the footer) is fine; keep it visually separate from product navigation.
5. **Shared components stay identical**: the header, navigation, buttons, inputs, cards and empty-state pattern use the same markup and class names on every screen. Build one screen fully, then copy its components rather than redrawing them.

## Hierarchy, spacing and type

- **One primary action per screen.** It is the most visually prominent control; secondary actions are quieter (outline or text style); destructive actions are distinct and never the default.
- **Spacing comes from the scale.** Use the spacing tokens (a 4- or 8-based scale such as 4, 8, 12, 16, 24, 32, 48, 64px). Related items sit closer than unrelated ones; section gaps are clearly larger than gaps inside a group. Typical values: card padding 16–24px, section gap 32–64px, form field gap 16–24px, icon-to-text gap 8px.
- **Line height**: headings 1.1–1.3, body text 1.5–1.7, UI labels 1.2–1.4. Body measure stays under 80 characters (`max-width: 65ch` is a good default).
- **Limit choices**: 2–3 weights per family, one or two families, a type scale of about 5–7 sizes. Inconsistent spacing, magic numbers and font overload are the commonest failures.
- **Radius and elevation carry hierarchy**: do not give everything the same radius and shadow. Reserve elevation for things that sit above the page (menus, dialogs, sticky bars).
- **Design every component state**: default, hover, focus, active, disabled, and selected where relevant. A mockup that forgets focus and disabled states is not finished.

## Responsive

- Mobile-first: base styles for the narrowest screen, then enhance at larger widths.
- Breakpoints come from the content (where a line gets too long or a layout gets cramped), not from device names.
- Use relative units and fluid layouts (`max-width`, `minmax()`, `clamp()` for type); avoid fixed widths that overflow.
- Touch targets at least 44×44px on mobile.
- Tables on mobile: collapse to stacked rows or let only the table scroll horizontally inside its own container, never the page.
- Avoid `100vh` for full-height mobile layouts; prefer `min-height: 100dvh` with a `100vh` fallback declared first.

## Accessibility floor

Build to a quality floor without announcing it:
- Contrast (WCAG 2.2 AA): body text at least 4.5:1 against its background; large text (at least 24px regular or about 18.7px bold) and UI component boundaries and focus indicators at least 3:1. Check every text/background token pair you use, including text on the primary colour and muted text on surfaces.
- Semantic HTML first: `header`, `nav`, `main`, `footer`, real `button` and `a` elements, headings in order, lists as lists, tables with `th`.
- Every input has a visible `<label>`; error messages sit next to the field and say how to fix it.
- Visible `:focus-visible` styles on every interactive element; never remove outlines without a replacement.
- Colour is never the only signal (pair status colours with text or an icon).
- Content still works at 200% zoom; respect `prefers-reduced-motion`.

## Restraint and self-critique

Spend your boldness in one place. Let one element be the memorable thing, keep everything around it quiet and disciplined, and cut any decoration that does not serve the brief. Build to a quality floor without announcing it: responsive down to mobile, visible keyboard focus, reduced motion respected, visually accessible, harmonious color palettes. Critique your own work as you build, taking screenshots to review if your environment supports it — a picture is worth 1000 tokens. Consider Chanel's advice: before leaving the house, take a look in the mirror and remove one accessory. Human creatives have memory and always try to do something new, so if you have a space to quickly jot down notes about what you've tried, it can help you in future passes.

## More on writing in design

Words appear in a design for one reason: to make it easier to understand and use. They are design content, not decoration. Bring the same intentionality and minimalism to copywriting that you would bring to spacing and color. Before writing anything, ask what the design needs to say, and how it can best be said to help the person navigate the experience.

Write from the end user's perspective. Name things by what users will understand in simple language, not by how the system is built. A user manages notifications, not webhook config. Describe what something is or does in plain terms rather than selling it. Being specific and legible to new users is always better than being clever.

Use active voice as default. A CTA says exactly what happens when it is used: "Save changes," not "Submit." An action keeps the same name through the whole flow, so the button that says "Publish" produces a toast that says "Published." The vocabulary of an interface is the signposting for someone navigating the product. Cohesion and consistency are how people learn their way around.

Treat failure and emptiness as moments for direction, not mood. Explain what went wrong and how to fix it, in the interface's voice rather than a person's. Errors don't apologize, and they are never vague about what happened. An empty screen is an invitation to act.

Keep the tone conversational: plain verbs, sentence case, no filler, with tone matched to the brand and the audience. Let each written element do exactly one job.

## Done means

- An `index.html` maps every screen and state; every screen is reachable by clicking from it, and no link is broken or points to `#`.
- Each file passes the mockup rules: self-contained, no script, no external URL, identical token block, works at phone and desktop widths.
- Components look and behave the same on every screen; content is realistic and consistent.
- Empty, loading and error states exist wherever the product can hit them.
- Contrast and focus checks pass; the design has one clear idea, chosen for this brief.

Run the pre-delivery checklist in references/mockup-checklist.md before calling the set finished.
