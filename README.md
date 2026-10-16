# AI Brain

A second brain and project studio that runs on your Mac. Describe an idea to the main agent and it helps you scope it, creates the project, keeps the requirements, has an Architect design the system (C4 model), and then a PM runs the build on a live board with builder and reviewer agents. Every agent is a Claude Code session on your subscription, with its own role and memory, and works only within the permissions you grant. Alongside projects it runs your day: the Daily, reminders, notes, email and calendar (once connected), bills and spending.

AI Brain is a fork of [kankanban](https://github.com/Knwar/kankanban), which provides the board engine: daemon, SQLite, MCP server, hooks, git worktrees, phases and cards.

- Requirements: [AI Brain — Requirements](https://claude.ai/code/artifact/db3b2243-f989-4415-b078-b9195274eca0)
- Mockups: [AI Brain — Main Dashboard](https://claude.ai/artifact/PtzGG5m9a5yWj93np1dkPc)
- Engine reference: [docs/kankanban-engine.md](docs/kankanban-engine.md)

## Run it

```bash
npm install
npm run build
node bin/brain.js daemon start      # then open http://localhost:7900/app/
```

The first screen asks for your **workspace folder**. Everything AI Brain creates (vault, projects, database) goes inside it, and agents are blocked from reading or writing outside it by a PreToolUse hook (`.claude/hooks/boundary.js`). The only file outside is `~/.ai-brain/config.json`, which records where the workspace is.

### Develop with live reload

```bash
PORT=7900 npm run dev:daemon        # daemon, restarts on backend changes
npm run dev:web                     # UI with hot reload at http://localhost:5190/app/
```

## How it works

| Piece | Where |
| --- | --- |
| Workspace, onboarding, boundary guard | `src/brain/workspace.ts`, `.claude/hooks/boundary.js` |
| `/api/*` routes | `src/brain/router.ts`, `routes-*.ts` |
| Roles and personas (main, CTO, CFO, Marketing, Social, QC, Architect, PM) | `src/brain/roles.ts` |
| Team chat: DMs, channels, decisions, approvals | `src/brain/chat.ts`, `routes-chat.ts` |
| Agent runs: `claude -p` per role per conversation, resumed sessions, streamed replies | `src/brain/runner.ts` |
| Agent tools (the `brain` MCP server), incl. the permission-prompt tool behind approval cards | `src/brain/mcp.ts` |
| Project pipeline: create → requirements → C4 design → verticals → roadmap → build | `src/brain/pipeline.ts`, `routes-projects.ts` |
| Personal data, the Daily, integrations, usage | `src/brain/personal.ts`, `daily.ts`, `integrations.ts`, `usage.ts` |
| Web app (React + Vite, ELK for diagrams) | `web/` |

Lifecycle gates: **Mark requirements final** brings in the Architect and CTO (`#<project>-design`); **Finalise design** creates one board vertical per app container and asks the PM for a roadmap (`#<project>-build`); **Approve roadmap** starts the phase loop.

## Connect email and calendar

Gmail and Google Calendar come from your claude.ai connectors. If Settings → Integrations shows them connected but agents can't use them, sign in once for Claude Code: run `claude`, type `/mcp`, pick each server and follow the browser sign-in.

## Test

```bash
npm run typecheck
npm test
```

Agent tests use a fake `claude` (`test/fixtures/fake-claude.mjs`); the real CLI was verified end to end separately. One kankanban autopilot test is timing-sensitive under full-suite load.

| | kankanban | AI Brain |
| --- | --- | --- |
| CLI | `kankan` | `brain` |
| Daemon | `http://localhost:7890` | `http://localhost:7900` (app at `/app/`) |
| Data | `~/.kankan/` | your workspace folder (`<workspace>/.ai-brain/`) |

## License

Apache-2.0, as in kankanban.
