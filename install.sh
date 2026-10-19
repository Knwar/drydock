#!/usr/bin/env bash
# Drydock installer: checks what Drydock needs, installs its packages, builds
# it, adds the `drydock` command and starts it. Safe to run again (it is also
# how you repair an install). Usage: ./install.sh [--no-start]
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; D=$'\e[2m'; N=$'\e[0m'; else B=; G=; R=; Y=; D=; N=; fi
step() { printf '\n%s%s%s\n' "$B" "$1" "$N"; }
ok() { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
die() { printf '  %s✗ %s%s\n\n' "$R" "$1" "$N"; [ $# -gt 1 ] && printf '    %s\n\n' "${@:2}"; exit 1; }

OS="$(uname -s)"
[ "$OS" = Darwin ] || [ "$OS" = Linux ] || die "Drydock runs on macOS or Linux (this is $OS)." "On Windows, use WSL 2 and run this inside it."

step "1. Checking this computer"

command -v node >/dev/null 2>&1 || die "Node.js is not installed." \
  "Install Node 20 or newer: $( [ "$OS" = Darwin ] && echo 'brew install node' || echo 'https://nodejs.org (or nvm)'), then run ./install.sh again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js $(node -v) is too old; Drydock needs 20 or newer." \
  "Update it: $( [ "$OS" = Darwin ] && echo 'brew upgrade node' || echo 'https://nodejs.org (or nvm install 22)'), then run ./install.sh again."
ok "Node.js $(node -v)"

command -v git >/dev/null 2>&1 || die "git is not installed." \
  "Install it: $( [ "$OS" = Darwin ] && echo 'xcode-select --install' || echo 'sudo apt install git'), then run ./install.sh again."
ok "git $(git --version | awk '{print $3}')"

if [ "$OS" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then
  warn "Xcode command line tools are missing. If the install below fails, run: xcode-select --install"
fi

CLAUDE_OK=1
if ! command -v claude >/dev/null 2>&1; then
  die "Claude Code (the claude command) is not installed. Every Drydock agent runs through it." \
    "Install it: npm install -g @anthropic-ai/claude-code" \
    "Then sign in with your own Claude account: claude auth login" \
    "Then run ./install.sh again."
fi
ok "Claude Code $(claude --version 2>/dev/null | awk '{print $1}')"
if claude auth status --json 2>/dev/null | grep -q '"loggedIn": *true'; then
  ok "Signed in to Claude"
else
  CLAUDE_OK=0
  warn "Claude Code is not signed in. Drydock installs anyway, but agents cannot run until you run: claude auth login"
fi

step "2. Installing packages ${D}(a minute or two the first time)${N}"
npm install --no-audit --no-fund --silent --update-notifier=false || die "npm install failed (see the messages above)." \
  "$( [ "$OS" = Darwin ] && echo 'Often fixed by: xcode-select --install, then ./install.sh again.' || echo 'Often fixed by: sudo apt install build-essential python3, then ./install.sh again.')"
ok "Packages installed"

step "3. Building Drydock"
BUILD_LOG="$ROOT/.build.log"
npm run build --silent >"$BUILD_LOG" 2>&1 || { cat "$BUILD_LOG"; die "The build failed (see the messages above, also in .build.log)."; }
ok "Built"

step "4. Adding the drydock command"
chmod +x bin/drydock.js bin/brain.js
if npm link --no-audit --no-fund --loglevel=error >/dev/null 2>&1 && command -v drydock >/dev/null 2>&1; then
  ok "drydock is ready to use from any folder"
else
  mkdir -p "$HOME/.local/bin"
  ln -sf "$ROOT/bin/drydock.js" "$HOME/.local/bin/drydock"
  ln -sf "$ROOT/bin/brain.js" "$HOME/.local/bin/brain"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ok "drydock is ready to use from any folder" ;;
    *)
      SHELL_RC="$HOME/.$(basename "${SHELL:-zsh}")rc"
      warn "Added drydock to ~/.local/bin, which is not on your PATH yet. Add it once with:"
      printf '\n    echo '"'"'export PATH="$HOME/.local/bin:$PATH"'"'"' >> %s && source %s\n\n' "$SHELL_RC" "$SHELL_RC"
      warn "Until then, use: $ROOT/bin/drydock.js"
      ;;
  esac
fi

if [ "${1:-}" = "--no-start" ]; then
  step "Done. Start Drydock with: drydock start"
  exit 0
fi

step "5. Starting Drydock"
node bin/drydock.js start
[ "$CLAUDE_OK" = 1 ] || warn "Remember to sign in to Claude before using the agents: claude auth login"
