#!/bin/sh
# AI Agent Manager installer: curl -fsSL <site>/install.sh | sh
set -eu
BASE=${AGENTMGR_BASE:-__BASE__}
# The program goes here. Agents, workspaces and settings live in ~/.agentmanager (or
# $AGENTMGR_HOME), which this script never touches.
PREFIX=${AGENTMGR_INSTALL_DIR:-$HOME/.local/share/agentmanager}
DATA=${AGENTMGR_HOME:-$HOME/.agentmanager}
case "$(cd "$(dirname "$PREFIX")" 2>/dev/null && pwd)/$(basename "$PREFIX")" in
  "$DATA"|"$DATA"/*|"$HOME"|/) echo "Refusing to install into $PREFIX (that folder holds your data). Set AGENTMGR_INSTALL_DIR elsewhere." >&2; exit 1 ;;
esac
BIN_DIR=${AGENTMGR_BIN:-$HOME/.local/bin}

os=$(uname -s); arch=$(uname -m)
case "$os-$arch" in
  Darwin-arm64) t=darwin-arm64 ;;
  Darwin-x86_64) t=darwin-x64 ;;
  Linux-x86_64) t=linux-x64 ;;
  *) echo "Unsupported platform: $os $arch. Install from source: npm install && npm link" >&2; exit 1 ;;
esac

echo "Downloading AI Agent Manager ($t)..."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fL --progress-bar "$BASE/downloads/agentmanager-$t.tar.gz" -o "$tmp/am.tar.gz"
tar -xzf "$tmp/am.tar.gz" -C "$tmp"
mkdir -p "$(dirname "$PREFIX")" "$BIN_DIR"
# Swap in the new version; the old one is removed only after the new one is in place.
if [ -e "$PREFIX" ]; then mv "$PREFIX" "$PREFIX.old.$$"; fi
mv "$tmp"/agentmanager-*-"$t" "$PREFIX"
rm -rf "$PREFIX.old.$$"
ln -sf "$PREFIX/bin/agentmgr" "$BIN_DIR/agentmgr"

echo "Installed agentmgr -> $BIN_DIR/agentmgr"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Add to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
command -v claude >/dev/null 2>&1 || echo "Note: AI Agent Manager drives the Claude Code CLI. Install it: https://claude.com/claude-code"
echo "Start it:  agentmgr ui"
