# Drydock

A second brain and project studio that runs on your own computer. Tell the Main agent an idea and it helps you shape it: the problem, the users, the features and the requirements. When you're ready it becomes a project: an Architect designs the system, and a PM runs the build on a live board with builder and reviewer agents. Every agent is a Claude Code session on **your own Claude subscription**, with its own role and memory, and works only inside the folder you give it and within the permissions you grant. Alongside projects it runs your day: the Daily, reminders, notes, and email and calendar once connected.

---

## Install

Takes about 5 minutes. You run a few commands in **Terminal** (on a Mac: press `⌘ Space`, type *Terminal*, press Enter).

### 1. What you need first

| You need | Check with | How to get it |
| --- | --- | --- |
| A Mac (or Linux) | | Windows: use [WSL 2](https://learn.microsoft.com/windows/wsl/install) and follow the Linux steps inside it |
| **Node.js 20 or newer** | `node -v` | Mac: `brew install node` (needs [Homebrew](https://brew.sh)), or the installer from [nodejs.org](https://nodejs.org) |
| **git** | `git --version` | Mac: `xcode-select --install` · Linux: `sudo apt install git` |
| **Claude Code** | `claude --version` | `npm install -g @anthropic-ai/claude-code` |
| **A Claude account, signed in** | `claude auth status` | `claude auth login`, then follow the browser sign-in. A Pro or Max plan is best: agents use your plan's usage. |

> Each person uses **their own** Claude account. Drydock never sees your Claude password; it runs the `claude` command you signed in to.

### 2. Download Drydock

```bash
cd ~
git clone https://github.com/Knwar/drydock.git
cd drydock
```

This puts Drydock in a `drydock` folder in your home folder. Keep it: that folder *is* the app.

### 3. Install and start it

```bash
./install.sh
```

The installer:

1. checks for everything in the table above, and tells you exactly what to run if something is missing;
2. installs Drydock's packages (a minute or two the first time);
3. builds it;
4. adds the `drydock` command, so you can use it from any folder;
5. starts Drydock and opens it in your browser.

When it's done you'll see:

```
  ● Drydock is running

  Open        http://localhost:7900/app/
  Port        7900
  Workspace   not chosen yet: the app asks for a folder the first time you open it
  Claude      Signed in (max plan)
  Log         ~/.ai-brain/daemon.log

  Forgot the address? Run drydock status or drydock open
  Stop it with drydock stop
```

If the installer said `drydock` isn't on your PATH yet, it printed one line to fix that. Run it, then open a new Terminal window.

### 4. First time in the app

The first screen:

- **checks your computer** (Node, git, Claude Code, your Claude sign-in) and shows a ✓ or what to fix;
- **asks for your workspace folder**, for example `~/Documents/Drydock`. Everything Drydock makes goes in there: notes, ideas, projects and its database. Agents can't read or write anything outside it.

Then say hi to the Main agent, or tell it an idea.

---

## Everyday use

Drydock runs in the background. You can close Terminal; it keeps running until you stop it or restart your computer.

| To | Run |
| --- | --- |
| Start it (e.g. after restarting your computer) | `drydock start` |
| Open it in your browser | `drydock open` |
| See if it's running, and its address | `drydock status` |
| Stop it | `drydock stop` |
| Restart it | `drydock restart` |
| Watch its log (Ctrl+C to leave) | `drydock logs` |
| Get the latest version | `drydock update` |

### Forgot the address or port?

Run **`drydock status`** in any Terminal window. It prints the address to open, the port, your workspace folder and whether Claude is signed in. Or run **`drydock open`** and it opens the right page for you, starting Drydock first if needed.

The address normally stays **http://localhost:7900**, so it's worth bookmarking. Opening just `localhost:7900` takes you into the app.

### Port 7900 is taken by something else

`drydock start` tells you which program holds the port. To use another port:

```bash
drydock start --port 7950
```

Drydock remembers that port from then on (`drydock status` shows it). Pick it once and keep it: projects you create remember the port they were made with.

### Updating

```bash
drydock update
```

This downloads the latest version, reinstalls, rebuilds and restarts Drydock. Your workspace (ideas, projects, notes) is untouched. Agents that were mid-task are interrupted and pick up where they left off.

---

## Good to know

- **It's private to your computer.** Drydock only listens on `localhost`: other devices on your network can't open it. Your data stays in your workspace folder, plus a small settings folder at `~/.ai-brain/`.
- **Agents use your Claude plan.** Settings → Usage alerts pauses work before you run out. Auto mode on a project uses more, because nobody waits for you between steps.
- **You stay in control.** Anything risky (running commands outside a project, deleting things, sending email, using a secret) shows an approval popup first.
- **Email and calendar** come from your Claude account's connectors (claude.ai → Settings → Connectors). Settings → Integrations shows what's connected and lets you sign in to others.
- **Secrets** (API keys, passwords) go to a password manager: 1Password or Bitwarden. Settings → Secrets installs and connects one. They never go into your files.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Red banner: "Claude isn't signed in" | Run `claude auth login` in Terminal, then click **Check again** in the banner |
| `drydock: command not found` | Open a new Terminal window. Still missing? Run `./install.sh` again inside the `drydock` folder |
| The page won't load | `drydock status`: if it says not running, `drydock start` |
| `drydock start` says it did not start | It prints the end of its log. The full log is `~/.ai-brain/daemon.log` (or `drydock logs`) |
| `npm install` failed on a Mac | `xcode-select --install`, then `./install.sh` again |
| Something else is odd | `drydock restart`. Still stuck? Send the output of `drydock status` and the last lines of `drydock logs` |

## Uninstall

```bash
drydock stop
npm unlink -g drydock 2>/dev/null; rm -f ~/.local/bin/drydock ~/.local/bin/brain
```

Then delete the `drydock` folder and the `~/.ai-brain` settings folder. Your workspace folder is yours: delete it only if you no longer want your ideas and projects.

---

## For developers

### Run from source with live reload

```bash
npm install
PORT=7900 npm run dev:daemon        # daemon, restarts on backend changes
npm run dev:web                     # UI with hot reload at http://localhost:5190/app/
```

### How it works

| Piece | Where |
| --- | --- |
| Workspace, onboarding, boundary guard | `src/brain/workspace.ts`, `.claude/hooks/boundary.js` |
| `/api/*` routes | `src/brain/router.ts`, `routes-*.ts` |
| Roles and personas (main, CTO, CFO, Marketing, Social, QC, Architect, PM) | `src/brain/roles.ts` |
| Team chat: DMs, channels, decisions, approvals | `src/brain/chat.ts`, `routes-chat.ts` |
| Agent runs: `claude -p` per role per conversation, resumed sessions, streamed replies | `src/brain/runner.ts` |
| Agent tools (the `brain` MCP server), incl. the permission-prompt tool behind approval popups | `src/brain/mcp.ts` |
| Idea board: intake questions, first pass, stories to confirm | `src/brain/ideas.ts`, `routes-ideas.ts`, `web/src/components/IdeaOverview.tsx` |
| Project pipeline: create → requirements → C4 design → verticals → roadmap → build | `src/brain/pipeline.ts`, `routes-projects.ts` |
| Personal data, the Daily, integrations, usage | `src/brain/personal.ts`, `daily.ts`, `integrations.ts`, `usage.ts` |
| Computer checks (Node, git, Claude CLI and sign-in) | `src/brain/system-check.ts` |
| The `drydock` command and installer | `bin/drydock.js`, `install.sh` (agents use `bin/brain.js`) |
| Web app (React + Vite, ELK for diagrams) | `web/` |

Lifecycle gates: **Mark requirements final** brings in the Architect and CTO (`#<project>-design`); **Finalise design** creates one board vertical per app container and asks the PM for a roadmap (`#<project>-build`); **Approve roadmap** starts the phase loop.

Drydock is a fork of [kankanban](https://github.com/Knwar/kankanban), which provides the board engine: daemon, SQLite, MCP server, hooks, git worktrees, phases and cards. Engine reference: [docs/kankanban-engine.md](docs/kankanban-engine.md).

### Test

```bash
npm run typecheck
npm test
```

Agent tests use a fake `claude` (`test/fixtures/fake-claude.mjs`). One kankanban autopilot test is timing-sensitive under full-suite load.

## License

Apache-2.0, as in kankanban.
