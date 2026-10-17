---
name: story-planning
description: Use when deciding what a story should be before prose exists: brainstorming with the author, capturing ideas without over-elaborating, shaping creative direction, or structuring arcs, chapters and scenes into an outline.
---

# Story Planning

Use this for pre-page decisions: what the story wants, what options exist, and how chosen direction becomes outline structure. Do not use it for production prose or critique.

Three parts: creative direction (shaping options with the author), brainstorming capture (recording ideas without filling gaps), and story architecture (arc, chapter, scene structure). Specialized guidance lives in `references/`.

## Creative Direction

Brainstorm alongside the author, research how similar stories handle the same
problems, sketch prose directions to make options tangible, and push back when
an idea doesn't serve the story. The author has the final say.

**Understand the creative need.** What experience should the reader have?
What existing story elements constrain the answer? Probe with why.

**Explore broadly.** Seek diverse creative angles. Research real references
and comparable works. Check established project facts and prior decisions
before recommending direction. Unsettled backstory stays open
until the author chooses.

**Synthesize and present.** Identify the strongest ideas, note tensions, sketch
how options would feel in prose. Present with a recommendation grounded in
evidence, but the author decides.

**Move production forward.** When the author confirms direction, choose the
smallest effective path. Record decisions before drafting begins, and carry the
approved outline, style, character state, and relevant context into the draft.

### Scaling Ceremony

- **Quick question** (character fact, timeline check): look it up.
- **Scene or chapter**: brainstorm, author confirms, move to drafting.
- **Arc planning**: multiple brainstorm rounds, structural outlining, deep
  research into comparable works.

When drafts come back, read them yourself before presenting to the author.

## Brainstorming Capture

Capture story brainstorming as minimal working notes that preserve creative freedom. The core principle: record what was stated, mark what was suggested, and don't fill gaps the author left open.

### Report Structure

When producing a standalone brainstorm document, tag all generated content
as `<AI>` since none came from the author:

```markdown
# [Topic]: [Angle]

## Approach
<AI>What direction you explored and why.</AI>

## Ideas
<AI>Concrete possibilities, organized logically.</AI>

## Tradeoffs
<AI>What each option gains and gives up.</AI>

## Connections
<AI>How this connects to existing story threads.</AI>

## Open Questions
<AI>Questions the author should consider before committing.</AI>
```

### Source Tagging

**Default: untagged text = the author said it.** Most story-planning content comes from the author, so untagged is the common case.

Three tags for special context:

**`<AI>...</AI>`**: AI suggestions and possibilities. Use when offering ideas the author didn't state. Keep brief: 2-3 options, not exhaustive lists.

**`<hidden>...</hidden>`**: Author-only information for planned reveals. Secret motivations, future twists, behind-the-scenes reasoning that readers and characters don't know yet.

**`<rejected>...</rejected>`**: Ideas explicitly considered and discarded. Recording why something was rejected prevents re-suggesting it and preserves the reasoning for later reconsideration.

### Minimal Capture

Record what the author stated. Don't elaborate, don't fill gaps, don't invent details they didn't mention.

AI suggestions are valuable: wrap them in `<AI>` tags and keep them brief.

- "Character A competes with B" → capture as stated. Optionally: `<AI>Tournament? Political? Trial?</AI>`
- "Maybe creates tension" → record as uncertain. Don't resolve the maybe.
- "Three kingdoms" → note three kingdoms. Don't name them.

### Preserve Vagueness

If the author left it vague, the notes stay vague. "Might," "maybe," "thinking about," "something like": all preserved as-is. Vagueness isn't a problem to solve; it's creative space the author is keeping open.

Multiple contradictory options coexist until the author chooses. Don't resolve them. Don't pick the "best" one.

### Output Format

Use whatever structure fits the discussion: bullet lists, topic sections, timeline format, question-driven, freeform. The goal is clarity, not template compliance.

Essential elements:
- Minimal capture of author's words
- Vagueness preserved
- AI suggestions wrapped in `<AI>` tags
- Author-only info wrapped in `<hidden>` tags
- Rejected ideas wrapped in `<rejected>` tags when relevant

### Brainstorming Types

All story-planning types share the core principles above. Read the relevant reference when the brainstorm focuses on that area:

- `references/chapter-planning.md`: beat and scene exploration, pacing thoughts, chapter structure
- `references/character-development.md`: motivations, arcs, relationships, voice
- `references/worldbuilding.md`: systems, cultures, geography, lore
- `references/continuity-timeline.md`: chronology, contradictions, knowledge propagation

### Calibration

The success check: the author says "yes, that's what I said." Capture stated
facts, preserve uncertainty, add brief tagged options when useful, keep notes
minimal. Durable decisions get recorded as decisions once the brainstorm completes.

## Story Architecture

Structure story at multiple levels so that each scene, chapter, and arc serves
the larger narrative. The patterns here apply across methodologies (three-act,
hero's journey, kishotenketsu, etc.): adapt them to what the story needs.

### Structural Levels

Stories operate at nested scales. Decisions at one level constrain and enable
decisions at others.

**Saga/Series**: the full story spanning multiple arcs. What's the overarching
question or transformation? How do arcs build on each other?

**Arc**: a self-contained narrative movement spanning multiple chapters. Each
arc has its own question, rising tension, and resolution, but also advances the
saga-level story. An arc that resolves its own conflict but doesn't change
anything at the saga level is filler.

**Chapter**: a unit of reading. Chapters need internal momentum (something
changes by the end) and external momentum (the reader wants to continue).

**Scene**: the fundamental building block. A scene happens in a specific time
and place, involves specific characters, and changes something. Scenes that
don't change anything are candidates for cutting or combining.

### What Makes Structure Work

**Causation over sequence.** "And then" is not structure. "Therefore" and "but"
are. Events should cause or complicate each other, not merely follow each
other. Can you reorder the scenes without the story breaking? If yes, the
structure is a sequence, not a plot.

**Stakes that escalate.** Each structural level should raise the stakes from
the previous one. Escalation doesn't always mean bigger explosions — stakes can
escalate emotionally, morally, or informationally.

**Setup and payoff.** Every significant payoff needs setup, and every
significant setup needs payoff. The best setups are invisible until the payoff
arrives. Track open setups explicitly across arcs.

**Tension and release.** Sustained tension becomes numbness. The reader needs
variation in intensity at every scale: within scenes, chapters, and arcs.

### Architecture References

- `references/arc-design.md`: arc components (hook, complications, midpoint
  shift, crisis, resolution) and arc pacing.
- `references/chapter-and-scene.md`: chapter design (internal completeness,
  external pull), scene design (earning presence), outline vs discovery writing.
- `references/structural-problems.md`: common problems (saggy middle, rushed
  ending, filler arcs, disconnected scenes, stakes plateau) and when to use
  diagrams.
