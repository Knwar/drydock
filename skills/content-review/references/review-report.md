# Review report format

The shape below adapts the editorial memo from haowjy/creative-writing-skills' story-review editorial-review resource (Apache-2.0): overall diagnosis, priority queue, major notes, recurring line patterns, surface patterns, revision order. It adds the brief check, the fact check and a pass/fail verdict.

```markdown
# Review: <piece title> (<form>, <length or runtime>)

Verdict: PASS | FAIL
Reviewed against: <brief name/date, or "reconstructed brief, see Assumptions">
Draft reviewed: <version or date>

## Assumptions
<Only if the brief was missing or unclear: the criteria you assumed, and the questions the author should answer.>

## Overall diagnosis
<Two to four sentences: the kind of revision this piece needs, not everything that could improve. A piece that needs structural work hears that first.>

## Brief check
| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | <criterion> | met / partly / not met | "<quote>" (para 3) |

## Must-fix (blocks the verdict)
1. **<short name>**: <where> - <what> - <why it matters> - <direction>
2. ...

## Nice-to-have
- **<short name>**: <where> - <what> - <direction> (label taste as taste)

## Line and voice patterns
- **<pattern>**: <reader cost>. Examples: "<quote>" (para 2), "<quote>" (para 9). Direction: <what the prose would gain>.

## Copy and consistency
- <Recurring surface patterns only, plus anything that blocks comprehension. Style-sheet decisions: names, spellings, numbers, capitalization.>

## Fact and claim check
| Claim | Location | Status | Note |
|-------|----------|--------|------|
| "<claim>" | para 4 | verified / unverified / contradicted | <source you checked, or "needs a source", or what contradicts it> |

## AI-writing tells
- <Clear problems with quotes; judgment calls labeled; "none found" if none.>

## What works
<One or two sentences on what the piece does well and why.>

## Revision order
1. <What to fix first and why: usually brief misses and structure.>
2. <Then...>
3. <Leave line polish until the above is done.>
```

## On a re-review

Start with a table of the previous must-fix items, each marked fixed / partly fixed / not fixed with evidence, then read the revised piece for anything new. A fix that introduced a new problem is a new must-fix.

## Severity guide

- **Must-fix**: brief criterion not met; factual error; claim the piece relies on with no source; misattributed or unsourced quote of a real person; legal or safety exposure; structure that stops the piece working; wrong audience; missing required section or call to action; length far outside the brief.
- **Nice-to-have**: rhythm, word choice, alternative examples, stronger headline options, tightening that doesn't change meaning, taste.
