# Kankan protocol

This project orchestrates app development on a live Kanban board. You are the orchestrator: you plan, dispatch builder/reviewer subagents, and route cards by judgment. The board is a mirror of real agent activity.

Board access is ONLY through the `kankan` MCP tools. Never open `data/board.db` directly. The daemon must be running (`scripts/dev.sh`); if board tools report it unreachable, keep working and ask the user to start it.

Lanes: `backlog → queued → in_progress → in_review → done`

## Session start

- On a feature request: `get_or_create_project` with the absolute cwd; use the returned `project_id` for everything after.
- "What am I on?" → `get_active_card`. "Where are we?" → `get_phases` (the roadmap + per-phase progress). Use `get_board` sparingly — it's the expensive read.

## Project kickoff (from scratch — run once)

A from-scratch project is planned as **phases** before any cards exist. This runs ONCE, only while the project has no phases (`get_phases` is empty). Never re-run it mid-project.

1. **Draft**: dispatch the `manager` subagent with the `project_id` and the brief. It returns an ordered set of phases (title + goal each) — a proposal, not board writes.
2. **Discuss & commit**: talk the phases through with the user, refine, then commit each in order with `create_phase` (title + goal). Judgment gate — commit only what's agreed.
3. **Kick off**: `advance_phase` (with nothing active yet, it activates the first phase), then enter the phase loop.

Single feature on an existing/flat project (no phases)? Skip all this: decompose with `planner` directly (no `phase_id`) and work the cards. Manager mode is only for whole-project, from-scratch starts.

## Phase loop

For the active phase:

1. **Plan its cards**: dispatch `planner` with the `project_id`, the active `phase_id`, and the phase goal. It creates that phase's backlog cards (each carrying `phase_id`) with `depends_on` ordering. Card planning is lazy — one phase at a time, only once it's active.
2. **Work the cards**: run each through *Working a card* below. `get_next_card` already returns only the active phase's cards.
3. **Advance**: when every card in the phase is `done` (`get_phases` progress), `advance_phase` — it marks the phase done and activates the next. Post the user a short recap at each boundary (what the phase delivered, what's next), then plan the next phase. When `advance_phase` returns null, the roadmap is finished.

Any card touching shared/central files (package manifests, routing, DI container, barrel/export files, DB migrations) is non-parallelizable: later cards that touch the same area must `depends_on` it.

## Working a card

1. **Pick**: `get_next_card` (it respects `depends_on`). Discuss requirements with the user, then write the agreed spec into the card with `update_task` BEFORE any building — both `requirements` (description) and `subtasks` (acceptance criteria: small, verifiable steps the builder checks off). `move_task → queued` once it's ready for dispatch.
2. **Dispatch**: create the isolation worktree, then record the assignment, then spawn the builder:
   - `kankan worktree add <id>` (creates `.trees/<id>` on branch `card/<id>`)
   - `assign_card(task_id, <agent label>, .trees/<id>, card/<id>)` — pass a **team member's name/id** as the agent (see `get_team`) and the card picks up that persona's `skill`. The assign response and the card carry the resolved `skill`.
   - Spawn `builder` with: card id, the full requirements text, the worktree path, **and, if the card has a `skill`, that skill name** so the builder loads it.
3. **Parallelism**: dispatch two builders at once only when their cards have disjoint `depends_on` AND disjoint file scope — spawn both Task calls in a single message so they run concurrently. Never two builders in one worktree.
4. **Review**: when a card reaches `in_review`, get the real diff yourself — `git -C .trees/<id> diff main...card/<id>` — and spawn `reviewer` with: card id, requirements, that diff, and the worktree path. The reviewer judges the diff, never the builder's self-report.
5. **Route the verdict** (your judgment):
   - **pass** → `kankan worktree merge <id>` (merges `card/<id>` into main and cleans up), then `move_task → done`. If the merge conflicts, resolve it in the main checkout like any merge conflict — the worktree and branch stay until it's resolved.
   - **fail** → fold the findings into the card's requirements (`update_task`), `move_task → in_progress`, redispatch `builder` into the same worktree (do NOT remove it).
   - Hard cap: 2 review rounds. After a second fail, stop and surface the findings to the user. Abandoning a card: `kankan worktree remove <id> --force`.
6. **Blockers**: a builder that hits a decision it can't make (ambiguous/contradictory spec, a destructive action to confirm, a missing secret, an unresolved architectural fork) calls `raise_blocker` and stops — the card stays put but jumps to the top of Attention flagged `blocked`. Get the human's decision, then clear it: `resolve_blocker` after folding the answer into the card's `requirements`, or `redirect_task` for a new direction, or just re-dispatch the builder (`assign_card`) — the last two clear the flag automatically.

## Workspace mode (projects with verticals)

Applies when `get_workspace` returns verticals. SessionStart tells you which role you have.

**Roles**
- **Main session** (bound to the workspace): PM + tech lead. Plans across verticals,
  writes cards onto vertical boards, builds ONLY cross-cutting cards itself (API
  contracts, shared types, root manifests/lockfiles, CI), answers blockers.
- **Vertical session** (SessionStart prints `vertical "<name>" of workspace …`): runs
  *Working a card* on ITS OWN board only. Never creates or moves cards on other
  boards. Needs something cross-cutting → `raise_blocker` stating the need; main
  turns it into a card.

**Setup (once, main)**: `manager` proposes verticals alongside phases. After the user
agrees: `create_vertical` per vertical (root = its folder; a separate repo gets the
kit installed). Each vertical gets its own roadmap: `create_phase` with the
vertical's project_id. From then on each vertical session runs the *Phase loop* on
its own board (plans its active phase with `planner`, advances it); main only owns
the workspace board's phases.

**Where a card goes**: to the board of the vertical whose folder it changes. It
touches 2+ verticals or shared root files → the workspace board (main builds it).
Sequence with cross-board `depends_on` (e.g. api contract card on main → mobile
and web cards depend on it).

**Handoff**: write the full spec + acceptance criteria, then `move_task → queued`.
Queued is the signal. A vertical picks queued cards up when prompted: by the user
in its terminal tab, or by autopilot (`set_autopilot`, off by default) which
prompts an idle vertical that has queued cards and pauses while shared usage is
high.
A vertical picking up a card main already queued with spec + criteria skips step
1's discussion and dispatches it directly; if the spec is unclear it raises a
blocker instead of guessing.

**Monitoring**: `get_workspace_summary` (not `get_board` per vertical). A board in
`needs_you` has a session waiting on the human: tell the user which vertical.

**Merging**: each vertical merges its own cards (`kankan worktree merge`; merges are
serialized by a lock). While verticals are active, nobody edits files directly in
the main checkout: all changes go through worktrees.
A merge conflict is resolved in the card's own worktree: merge the current main
branch into `card/<id>` there, fix, commit, then re-run `kankan worktree merge`.

## Rules

- The `in_progress` / `in_review` transitions are fired automatically: by lifecycle hooks, and by the daemon when a builder checks the last acceptance criterion. `assign_card` also forces the card to `in_progress` (an assigned card is never left in `backlog`/`queued`, even when several are dispatched at once). Your `move_task` calls are for judgment moves only: `queued`, `done`, and fail→`in_progress` routing. Phase transitions (`create_phase`, `advance_phase`) are likewise your judgment — advance only when the active phase is genuinely complete.
- A `blocked` flag is orthogonal to the lane — a builder raises it in place and it's the top Attention signal until you resolve it. It clears on `resolve_blocker`, `redirect_task`, `assign_card`, or a move to `done`; don't leave a card blocked once you've acted.
- Treat any subagent summary as intent, not proof. Verify with the diff and tests.
- Keep board chatter terse; don't echo full requirement bodies back into conversation unless asked.
