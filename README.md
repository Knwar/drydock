# AI Brain

A second brain and project studio that runs on your Mac. You describe an idea in chat, and AI Brain helps you scope it, designs the system (C4 model), breaks it into phases and cards, and runs a team of Claude Code agents to build it. Each agent is a Claude Code session with its own role and skill, and works only within the permissions you grant. Alongside projects, it manages your day: email, calendar, notes, reminders, and a daily brief.

AI Brain is a fork of [kankanban](https://github.com/Knwar/kankanban), which provides the board engine: daemon, SQLite, MCP server, hooks, git worktrees, phases and cards.

- Requirements: [AI Brain — Requirements](https://claude.ai/code/artifact/db3b2243-f989-4415-b078-b9195274eca0)
- Mockups: [AI Brain — Main Dashboard](https://claude.ai/artifact/PtzGG5m9a5yWj93np1dkPc)
- Engine reference: [docs/kankanban-engine.md](docs/kankanban-engine.md)

## Status

Phase 1 (fork and foundation) is done. The board engine runs under its own name, so it can sit next to an installed kankanban:

| | kankanban | AI Brain |
| --- | --- | --- |
| CLI | `kankan` | `brain` |
| Daemon | `http://localhost:7890` | `http://localhost:7900` |
| Data | `~/.kankan/` | `~/.ai-brain/` (moves into your workspace folder in phase 2) |

Next phases: workspace folder and onboarding, the new UI shell, agent sessions and team chat, the project pipeline, then the personal page, the Daily, and Settings.

## Run it

```bash
npm install          # also fixes node-pty's spawn-helper permissions
npm run build
node bin/brain.js daemon start   # http://localhost:7900
```

To put `brain` on your PATH, run `npm link` from this folder.

## Develop

```bash
npm run typecheck
npm test
```

One autopilot test (`autopilot nudges an idle session through the pty`) is timing-sensitive. It sometimes fails under full-suite load and passes on its own. It has the same behaviour in kankanban.

## License

Apache-2.0, as in kankanban.
