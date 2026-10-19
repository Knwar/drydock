> Reference for the board engine that Drydock is forked from. In this fork the CLI is `brain`, the daemon port is 7900, and data lives in `~/.ai-brain`. The text below still uses kankanban's names.

# kankan (engine reference)

A Kanban-board orchestration kit for [Claude Code](https://claude.com/claude-code).

You describe a feature. Claude Code — acting as the **orchestrator** — decomposes it into cards on a live Kanban board, then dispatches **builder** and **reviewer** subagents that work in isolated git worktrees. The board is not a to‑do list you maintain by hand; it is a real‑time mirror of what the agents are actually doing, served as a web overlay you can watch while it runs.

```
backlog → queued → in_progress → in_review → done
```

## How it works

kankan has four moving parts:

- **Daemon** — a small HTTP + WebSocket server (default `http://localhost:7890`) backed by a single SQLite file at `~/.kankan/board.db`. It owns all board state and serves the live overlay UI.
- **MCP server** — a thin stdio [Model Context Protocol](https://modelcontextprotocol.io) server that Claude Code talks to. It never touches SQLite directly; every board read/write goes through the daemon. This is how the orchestrator plans cards, dispatches work, and routes review verdicts.
- **Hooks** — Claude Code hooks that inject the current board and active card into each session, and fire lane transitions automatically (e.g. a builder checking the last acceptance criterion moves a card to `in_review`).
- **CLI (`kankan`)** — sets up a project and manages the daemon lifecycle.

Builders and reviewers run in **per‑card git worktrees** (`card/<id>` branches), so parallel work never collides. The orchestrator reviews the real diff — not the agent's self‑report — before merging.

## Requirements

- [Node.js](https://nodejs.org) 20+
- [Claude Code](https://claude.com/claude-code)
- `git` (worktrees and per‑card branches)

## Install

```bash
npm install -g kankanban
```

This puts the `kankan` command on your `PATH`.

## Quick start

From the project you want to orchestrate:

```bash
cd your-project
kankan init        # set up this folder and auto-start the daemon
claude             # approve the kankan MCP server + hooks on first run
```

`kankan init` is idempotent and merge‑aware: it adds the orchestration protocol, hooks, agents, and MCP wiring **alongside** anything you already have, never overwriting your own files. It works on a fresh directory or an existing repo.

Then, inside Claude Code, just describe what you want built. The orchestrator takes it from there. Open the overlay URL it prints (e.g. `http://localhost:7890/?project=<id>`) to watch the board live.

## CLI

```
kankan init [dir] [name]                 set up a project (auto-starts the daemon)
kankan update [dir]                      re-sync kit files into a set-up project
kankan info                              project details for this folder
kankan start | stop | restart            daemon + project details (set-up folders)
kankan worktree add|remove|merge <id>    per-card git worktree, run in the project
kankan daemon start|stop|restart|status  machine-level daemon management
kankan daemon run                        run the daemon in the foreground
```

### Updating an existing project

The daemon, MCP server, and overlay all run from your kankan install, so pulling a new version updates those everywhere automatically. The per‑project files copied in at `init` (hooks, agents, statusline, settings/protocol merges) are refreshed with:

```bash
cd your-project
kankan update     # overwrites kit-owned files, re-merges settings + protocol
```

Then restart Claude Code in that project to load the refreshed hooks.

## Board tools (MCP)

The orchestrator drives the board through these MCP tools — you don't call them by hand, but they describe the model's vocabulary:

| Tool | Purpose |
| --- | --- |
| `get_or_create_project` | Resolve the board project for a directory. |
| `get_board` | Full board as summary cards (used sparingly). |
| `get_active_card` | What's currently `in_progress` — "what am I on?" |
| `get_next_card` | Top backlog card whose dependencies are all done. |
| `create_task` | Add a card to the backlog. |
| `update_task` | Edit a card's requirements, tag, dependencies, or acceptance criteria. |
| `check_subtask` | Tick off one acceptance criterion. |
| `move_task` | Move a card between lanes (judgment moves only). |
| `assign_card` | Record which agent owns a card, in which worktree/branch. |
| `record_review` | Record a pass/fail review verdict with findings. |

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `DAEMON_URL` | `http://localhost:7890` | Where the daemon listens and where the CLI, MCP server, and hooks reach it. |
| `DB_PATH` | `~/.kankan/board.db` | SQLite database file for all board state. |

All board data lives in `~/.kankan/` (database, daemon PID, and log). Nothing project‑specific is written outside the project folder and that directory.

## Reducing permission prompts

The orchestrator drives worktrees through one vetted command (`kankan worktree`, which runs the central `scripts/worktree.js`), so the committed `.claude/settings.json` allows just that entrypoint:

```jsonc
"permissions": { "allow": ["Bash(kankan worktree:*)"] }
```

That covers the per‑card create / merge / remove without prompting, while keeping raw `git` mutations gated. We deliberately **don't** allowlist a runtime (`node`, `python`), a package runner (`npm`), or bare `git` — those are equivalent to arbitrary code execution. If you want to silence other prompts on your machine, add narrow rules to `.claude/settings.local.json` (git‑ignored) rather than the committed file.

## License

[Apache-2.0](LICENSE)
