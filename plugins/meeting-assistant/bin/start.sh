#!/bin/sh
# Starts the Meeting Assistant MCP server with Node.js 22+. Desktop apps often start plugins without the
# shell's PATH, so Node installed through nvm, Homebrew, Volta or fnm is looked for in the usual places.
root=$(cd "$(dirname "$0")/.." && pwd)
works() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)' >/dev/null 2>&1; }
try() { if works "$1"; then exec "$1" "$root/server/index.mjs"; fi; }
try "$MEETING_NODE"
try "$(command -v node 2>/dev/null)"
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do try "$candidate"; done
for candidate in $(ls -d "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -r); do try "$candidate"; done
try "$("${SHELL:-/bin/zsh}" -lc 'command -v node' 2>/dev/null)"
echo "Meeting Assistant needs Node.js 22 or later. Install it from https://nodejs.org, or set MEETING_NODE to the node executable." >&2
exit 1
