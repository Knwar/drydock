---
name: brand-guidelines
description: Use when an idea or early product needs a brand: turning its problem and audience into positioning, personality, voice and tone, name and tagline criteria, logo direction, colour and type rationale, imagery rules, and a concise guidelines document a solo founder can apply.
---

# Brand Guidelines

A brand, for a product that does not exist yet, is a set of decisions that make every later piece of work (screens, landing page, posts, emails) look and sound like it came from the same place. This skill produces those decisions, with reasons, in a document short enough to actually be used.

## When to use

- An idea is being shaped and needs a look and voice before screens or marketing are made.
- A product exists but its copy, colours and type drift from piece to piece.
- Someone asks for a name, tagline, logo direction, palette, voice guide or "brand book".

Not for: auditing a single draft against an existing guide (use the guide directly), or full design tokens (this skill picks the colours and type with rationale; the design-system-tokens skill turns them into a full token set).

## Core principles

1. **Strategy before style.** Every visual and verbal choice traces back to the problem, the audience and the position against alternatives. A colour with no reason is decoration.
2. **Specific beats safe.** "Friendly, modern, trustworthy" describes every brand and guides nothing. Pick traits that rule things out.
3. **Show, don't define.** Voice is taught with before/after examples, not adjectives. Usage rules are taught with do/don't pairs.
4. **Small enough to apply.** A solo founder needs one page they reread, not forty they never open. Cut anything that would not change a decision.
5. **Honest about what is a guess.** Before launch, positioning is a hypothesis. Mark assumptions so they can be revisited when real users arrive.

## Method

### 1. Extract the strategic core
From the idea's brief (or by asking), write down:
- **Problem**: the specific pain, in the audience's words.
- **Audience**: who feels it most; what they already use; what they are tired of.
- **Alternatives**: what people do today instead (competitors, spreadsheets, doing nothing).
- **Difference**: the one thing this product does that the alternatives do not, and why that matters to this audience.
- **Proof**: what makes the difference believable (a mechanism, a constraint, the founder's expertise).

Turn it into one positioning statement:

> For **[audience]** who **[problem/need]**, **[product]** is the **[category]** that **[key difference]**, unlike **[main alternative]**, because **[reason to believe]**.

If any slot is vague, stop and sharpen it with the user before going further; everything downstream inherits the vagueness.

### 2. Define personality
Choose 3–4 traits. For each, say what it means and what it is not, so it rules something out (see the voice attribute table in references/guidelines-template.md). Useful tensions to place the brand on:
- serious ↔ playful
- expert ↔ approachable
- calm ↔ energetic
- understated ↔ bold
- precise ↔ expressive

Check: would a direct competitor pick the same traits? If yes, push one trait further toward what makes this product different.

### 3. Voice and tone
- **Voice** is constant: vocabulary, sentence length, person (we/you), formality, humour (if any), words to use and avoid.
- **Tone** shifts by context: onboarding, empty states, errors, marketing headlines, support replies, legal. Write a tone row for each context the product will actually have.
- For each trait give a **do/don't pair** with real lines from the product, e.g.:
  - Direct. Do: "Your export is ready." Don't: "Great news! We've finished preparing your export for you!"
  - Calm under failure. Do: "We couldn't reach your bank. Check the account number and try again." Don't: "Oops! Something went wrong :("
- Include a short word list: product nouns (what things are called, consistently) and banned words (jargon, hype, competitor terms).
- Interface copy follows the voice but stays plain: sentence case, active verbs, buttons that name the action.

### 4. Name and tagline (when needed)
Name criteria (score candidates against these, do not just list favourites):
- Says something true about the difference or the feeling, or is a neutral, ownable word that can carry meaning over time.
- Easy to say after hearing it once, and easy to spell after hearing it said.
- Not confusable with a competitor in the same space; no unfortunate meanings in the main audience's languages.
- Short enough for an app icon label and a domain or handle variant.
- Availability is a gate the user must check (trademark search in the relevant classes, domain, social handles); never claim a name is available or registrable.

Tagline criteria: says what it is or what it changes, in under about eight words; concrete over clever; would not fit a competitor if their name were swapped in. Offer 3–5 options with a one-line rationale each.

### 5. Logo direction (in words)
Describe, do not render, unless asked:
- **Type**: wordmark, lettermark, symbol plus wordmark, or emblem, and why (a new name usually needs a wordmark so people learn it).
- **Form**: the shapes, weight and construction (geometric, hand-drawn, stencil, monoline), tied to personality traits.
- **Concept**: one idea the mark expresses, if any; avoid literal clip-art of the category (a lightbulb for ideas, a cart for shopping).
- **Variations required**: primary, inverted for dark backgrounds, single-colour, and mark-only for small sizes (app icon, favicon).
- **Constraints**: must read at 16px; works in one colour; no gradients the brand cannot reproduce.
- A simple text-and-shape mark that can be built in SVG is a legitimate result for an early product.

### 6. Colour rationale
- 1 primary brand colour, 1 optional accent, a neutral family with a slight tint, and status colours (success, warning, danger).
- For each, give the hex, the role (what it is used for and what it is never used for) and the reason (trait, audience, contrast with competitors' colours).
- Check text pairings against WCAG AA (4.5:1 body text, 3:1 large text and UI boundaries) before committing; a brand colour that fails as text on white is still fine as a fill, but say so in the rules.
- Note which competitors own which colours; avoid the category default unless the strategy is to look established.

### 7. Type rationale
- One family for body and UI, an optional distinct family for display. Explain the choice by personality (e.g. a transitional serif for considered and literary; a rounded sans for friendly; a condensed sans for data-dense and utilitarian).
- Give a full fallback stack and note the system-font fallback; if the product's mockups or emails cannot load web fonts, choose so the fallback still carries the personality.
- Licensing is the user's check for any non-system font.

### 8. Imagery and illustration
- Choose one primary visual language: photography, illustration, product UI screenshots, abstract shapes, or type-only. Mixing several reads as no brand.
- For photography: subjects (real use, real people, real settings), lighting, colour treatment, what to avoid (generic stock, posed handshakes).
- For illustration: line vs filled, stroke weight, corner treatment, palette limit, level of detail, human figures or not.
- Iconography: one style (outline or filled), one stroke weight, one corner style.
- Do/don't pairs make this concrete.

### 9. Usage rules
Short, enforceable rules: logo clear space and minimum size, approved backgrounds, colour proportions (e.g. mostly neutral, primary for actions, accent sparingly), type pairings and sizes, what never to do (stretch the logo, recolour it, set body text in the display face).

### 10. Write the document
Use references/guidelines-template.md. Keep the main guide to what fits on a few screens; push long examples to an appendix. End with "open questions and assumptions" so the next decision-maker knows what is provisional.

## Common failure modes

- **Adjective soup**: traits like "innovative, trustworthy, user-friendly" that every competitor shares.
- **Style with no strategy**: a palette chosen because it looks nice, with no link to audience or differentiation.
- **Voice described but not demonstrated**: no before/after lines, so nobody can apply it.
- **Agency theatre**: mission/vision/values pages, archetype wheels and mood-board essays that change no decision for a one-person team.
- **Over-specification**: rules for print, merchandise and co-branding that the product will not need for a year.
- **Inaccessible palette**: brand colours that fail contrast as text, discovered only when screens are built.
- **Claims of availability**: stating a name or domain is free without the user checking.

## Done means

- A positioning statement with every slot specific, and assumptions marked.
- 3–4 personality traits that each rule something out, with is/is-not definitions.
- Voice rules plus a tone row per real context, each with do/don't example lines.
- Name/tagline options scored against criteria (when requested), with availability left to the user.
- Logo direction described clearly enough that a designer or an SVG could execute it.
- Colours with hex, role, reason and checked contrast; type with roles, fallbacks and reason.
- One imagery language with do/don'ts; short usage rules.
- The whole guide fits the template and can be read in under ten minutes.
