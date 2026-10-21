#!/bin/sh
# Agent Union, Local 404: CLI installer.
#
#   curl -fsSL https://ylove.github.io/agent-union/install.sh | sh
#
# Installs the `agent-union` command globally with npm (from GitHub; nothing is on npm yet), then prints
# the next step for each harness it finds. It never changes harness settings itself and never prompts.
# Source: https://github.com/ylove/agent-union (Apache-2.0)

set -eu

REPO="ylove/agent-union"
MIN_MAJOR=20
MIN_MINOR=10

say() { printf '%s\n' "$*"; }
fail() {
  printf 'agent-union install: %s\n' "$*" >&2
  exit 1
}

# ── Node.js >= 20.10 ─────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js $MIN_MAJOR.$MIN_MINOR or later is required, and 'node' is not on your PATH.
Install it from https://nodejs.org (or with your version manager), then run this again."
fi

node_version=$(node -p 'process.versions.node' 2>/dev/null) || fail "could not read the Node.js version from 'node'."
node_major=${node_version%%.*}
node_rest=${node_version#*.}
node_minor=${node_rest%%.*}
case "$node_major.$node_minor" in
  *[!0-9.]* | .* | *.) fail "could not parse the Node.js version '$node_version'." ;;
esac
if [ "$node_major" -lt "$MIN_MAJOR" ] || { [ "$node_major" -eq "$MIN_MAJOR" ] && [ "$node_minor" -lt "$MIN_MINOR" ]; }; then
  fail "Node.js $MIN_MAJOR.$MIN_MINOR or later is required; found $node_version.
Upgrade from https://nodejs.org (or with your version manager), then run this again."
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm is required (it ships with Node.js) but is not on your PATH."
fi

# ── Install ──────────────────────────────────────────────────────────────────
say "Agent Union, Local 404"
say "Installing the agent-union CLI from github:$REPO with npm (Node.js $node_version)..."
if ! npm install -g "github:$REPO"; then
  fail "npm install failed (see above). If it was a permissions error, set a user-level npm prefix
(https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)
rather than running this script with sudo."
fi

if command -v agent-union >/dev/null 2>&1; then
  au="agent-union"
  say "Installed agent-union $(agent-union --version 2>/dev/null || printf 'CLI')."
else
  au="npx github:$REPO"
  say "Installed, but 'agent-union' is not on your PATH yet."
  say "Add npm's global bin directory to your PATH: $(npm prefix -g 2>/dev/null || printf '<npm prefix -g>')/bin"
fi

# ── Next steps per harness ───────────────────────────────────────────────────
found=0
say ""
say "Next, connect the union to your harness. This script has not changed any harness settings."

if command -v claude >/dev/null 2>&1; then
  found=1
  say ""
  say "Claude Code (found 'claude'). Inside Claude Code, run:"
  say "  /plugin marketplace add $REPO"
  say "  /plugin install agent-union@agent-union"
  say "  (Claude Code 2.1.275 or later, one step: /plugin install agent-union --marketplace $REPO)"
fi

if command -v codex >/dev/null 2>&1; then
  found=1
  say ""
  say "Codex (found 'codex'). Run:"
  say "  $au install codex"
  say "  then open Codex and run /hooks to review and trust the hooks."
fi

if command -v agy >/dev/null 2>&1; then
  found=1
  say ""
  say "Antigravity (found 'agy'). Run:"
  say "  $au install antigravity"
fi

if [ "$found" -eq 0 ]; then
  say ""
  say "No harness CLI found on your PATH (claude, codex, agy). Use the line for yours:"
  say "  Claude Code, inside Claude Code:"
  say "    /plugin marketplace add $REPO"
  say "    /plugin install agent-union@agent-union"
  say "  Codex:        $au install codex   (then run /hooks in Codex to trust the hooks)"
  say "  Antigravity:  $au install antigravity"
fi

say ""
say "Then, in each project:"
say "  1. $au init      writes union-policy.yaml, the CBA template"
say "  2. Review the terms with your agent (ask it to run the union-init skill)"
say "  3. $au ratify    signs it; it binds from the next session"
say ""
say "Docs: https://ylove.github.io/agent-union/"
