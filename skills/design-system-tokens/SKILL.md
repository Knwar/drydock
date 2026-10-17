---
name: design-system-tokens
description: Use when defining or auditing a product's design tokens: colour roles (primary, surface, text, accent, status), type scale, spacing, radius, elevation and motion, their naming and tiers, light and dark modes, and WCAG contrast checks on every text/background pair.
---

# Design System Tokens

Design tokens are the atomic values of a design system: the smallest named decisions about colour, type, spacing, shape and depth. Define them once and every screen, mockup and component draws from the same source of truth.

## When to Use This Skill

- Creating design tokens for colors, typography, spacing, and shadows
- Implementing light/dark themes with CSS custom properties
- Creating semantic token hierarchies (primitive, semantic, component)
- Turning brand guidelines (a brand colour, a typeface, a personality) into a usable system
- Auditing an existing set of styles for sprawl, magic numbers or failing contrast
- Setting up design system documentation and guidelines

## Core Principles

1. **Name tokens by purpose**: semantic names (`text-primary`, `surface-raised`) not visual descriptions (`dark-gray`).
2. **Maintain the hierarchy**: primitives → semantic → component. Screens and components use semantic (or component) tokens, never primitives or raw values.
3. **Constrain on purpose**: a small scale used consistently beats a large one used loosely. Every value outside the scale is a bug.
4. **Contrast is part of the definition**: a colour role is not defined until its text pairings are checked.
5. **Plan both modes from the start**: retrofitting dark mode is harder than designing for it.

## Token tiers

- **Primitive tokens**: raw values. Colour ramps (`gray-50 … gray-950`, `green-50 … green-900`), font families, the size scale, the spacing scale, radii, shadows.
- **Semantic tokens**: contextual meaning, referencing primitives. `color-bg`, `color-surface`, `color-text`, `color-text-muted`, `color-primary`, `color-on-primary`. These change between light and dark mode; primitives do not.
- **Component tokens** (optional, only when a component needs to diverge): `button-bg`, `card-border`. Do not create them for a small product unless a component genuinely needs its own value.

## Method

### 1. Collect the inputs
Brand colour(s), typeface choices and personality from the brand guidelines if they exist; otherwise ask for or propose them. Note the product's density (data-heavy tool vs. calm consumer app) because it sets the type ratio and spacing.

### 2. Build colour primitives
- A **neutral ramp** of 10–11 steps (50 to 900/950). Tint it slightly toward the brand hue rather than using pure grey, unless the brand calls for clinical neutrality.
- A ramp for the **primary** brand hue, and for an **accent** only if the brand has one.
- **Status hues**: success, warning, danger, info. Two to three steps each are usually enough (a fill, a text-safe dark, a subtle background).
- Build ramps by holding hue roughly constant and stepping lightness evenly from near-white to near-black; nudge saturation down at the extremes so light steps do not look neon and dark steps do not look muddy. Then check each step's contrast against white and against the darkest neutral, and adjust.

### 3. Assign semantic colour roles
Define at least these, for each mode:

| Role | Use |
|---|---|
| `color-bg` | Page background |
| `color-surface` | Cards, panels, inputs |
| `color-surface-muted` | Subtle fills, skeletons, table stripes |
| `color-surface-raised` | Menus, dialogs (with elevation) |
| `color-text` | Body and headings |
| `color-text-muted` | Secondary text, captions (must still pass 4.5:1) |
| `color-border` | Dividers (decorative, no contrast requirement) |
| `color-border-control` | Input and control outlines (3:1 against adjacent colour) |
| `color-primary` / `color-primary-hover` / `color-on-primary` | Main actions and the text on them |
| `color-accent` / `color-on-accent` | Highlights, if the brand has an accent |
| `color-success` / `-warning` / `-danger` / `-info` | Status text/icons, each with a `-subtle` background |
| `color-focus` | Focus ring (3:1 against both the page and the component) |
| `color-link` | Inline links, if different from primary |

State suffixes: `-hover`, `-active`, `-disabled`. Disabled text is exempt from contrast rules but must still look disabled, not invisible.

### 4. Set the type scale
- Choose families by role: body/UI, optional display, optional mono. Always give a full fallback stack.
- Pick a ratio from references/scales-and-contrast.md: about 1.125–1.2 for dense app UIs, 1.25 as the balanced default, 1.333 and above for marketing and editorial pages.
- Define 5–7 sizes, 2–3 weights, and line heights (tight ~1.2 for headings, ~1.5 for body). Pre-compose text styles (h1…caption) so screens use styles, not loose sizes.

### 5. Set spacing, radius, elevation, motion
- **Spacing**: a 4/8-based scale: 4, 8, 12, 16, 24, 32, 48, 64 (and 96/128 for page sections if needed). Map semantic names (xs…3xl) onto it.
- **Radius**: 3–4 steps plus `full` (e.g. 4, 8, 16, 999px). Radius expresses hierarchy and personality (sharp = precise/serious, generous = friendly); do not use one radius for everything.
- **Elevation**: 2–3 shadow levels at most, reserved for things above the page (sticky bars, menus, dialogs). Tint shadows with the neutral hue instead of pure black.
- **Motion** (if needed): 2–3 durations (e.g. 120ms, 200ms, 320ms) and one or two easing curves; every animation respects reduced-motion preferences.
- **Breakpoints**: content-driven, typically two or three (e.g. 40rem, 64rem, 80rem).

### 6. Define light and dark
- Semantic tokens get a value per mode; primitives stay the same.
- Dark backgrounds are dark neutrals, not pure black; raise surfaces by making them lighter, not by shadows alone.
- Desaturate and lighten the primary for dark mode so it does not vibrate, and recheck `on-primary`.
- In CSS: light values in `:root`, dark overrides in `@media (prefers-color-scheme: dark) { :root { … } }`; add a `[data-theme="dark"]` selector only if the product offers a manual toggle.

### 7. Check contrast, every pair
List every text/background pair the product actually uses (text on bg, text on surface, muted text on both, on-primary on primary, status text on its subtle background, link on bg) in both modes, compute the ratio with the formula in references/scales-and-contrast.md, and record it. Targets: 4.5:1 for normal text, 3:1 for large text, control boundaries, focus rings and meaningful icons. Fix failures by moving to a different ramp step, never by shrinking the requirement.

### 8. Write the tokens down
Two forms, kept identical:
1. A **CSS custom properties block** (`:root { --color-bg: …; }` plus the dark-mode override) ready to paste into any HTML or stylesheet.
2. A **token table** for people: name, light value, dark value, role/usage note, and the contrast ratio for text pairs.

References/design-tokens.md has a full worked example of primitives, light/dark semantic mapping, naming structure and CSS output.

## Naming

Structure: `[category]-[property]-[variant]-[state]`, for example `color-text-muted`, `color-border-control`, `space-4`, `radius-md`, `shadow-overlay`.

1. **Use kebab-case**: `text-primary` not `textPrimary`
2. **Be descriptive**: `button-padding-horizontal` not `btn-px`
3. **Use semantic names**: `danger` not `red`
4. **Include scale info**: `spacing-4` or `font-size-lg`
5. **State suffixes**: `-hover`, `-focus`, `-active`, `-disabled`

## Best Practices

1. **Name Tokens by Purpose**: Use semantic names (text-primary) not visual descriptions (dark-gray)
2. **Maintain Token Hierarchy**: Primitives > Semantic > Component tokens
3. **Document Token Usage**: Include usage guidelines with token definitions
4. **Treat Token Changes as API Changes**: renaming or removing a token breaks every screen that uses it; change values freely, change names deliberately
5. **Test Theme Combinations**: Verify all themes work with all components

## Common Issues

- **Token Sprawl**: Too many tokens without clear hierarchy
- **Inconsistent Naming**: Mixed conventions (camelCase vs kebab-case)
- **Missing Dark Mode**: Tokens that don't adapt to theme changes
- **Hardcoded Values**: Using raw values instead of tokens
- **Circular References**: Tokens referencing each other in loops
- **Undefined References**: semantic tokens pointing at primitives that were never declared
- **Text-unsafe brand colour**: using the brand's mid-tone as text or link colour on white without checking it (it often fails 4.5:1)
- **Muted text too muted**: secondary text that drops below 4.5:1, especially in dark mode

## Done means

- Primitives, semantic roles (both modes) and the type, spacing, radius and elevation scales are all defined and named consistently.
- Every semantic token resolves to a declared primitive; nothing references itself.
- Every text/background pair in use is listed with its ratio, and all pass WCAG AA.
- The CSS custom properties block and the human-readable table match exactly.
- A short usage note says which role to use where (e.g. "primary for the one main action per screen; accent never for text").
