#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Detecting platform..."
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
    darwin | linux) ;;
    *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
    arm64 | aarch64) ARCH="arm64" ;;
    x86_64 | amd64)  ARCH="x64" ;;
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

TARGET="bun-${OS}-${ARCH}"
OUTFILE="$ROOT/.agents/skills/consensus/bin/consensus"

echo "==> Linking skills into .agents/skills/..."
mkdir -p "$ROOT/.agents/skills"
if [ -L "$ROOT/.agents/skills/consensus" ]; then
    rm -f "$ROOT/.agents/skills/consensus"
fi
mkdir -p "$ROOT/.agents/skills/consensus/bin"

rm -rf "$ROOT/.agents/skills/consensus/SKILL.md"
ln -s "../../../skills/consensus/SKILL.md" "$ROOT/.agents/skills/consensus/SKILL.md"

rm -rf "$ROOT/.agents/skills/consensus/scripts"
ln -s "../../../skills/consensus/scripts" "$ROOT/.agents/skills/consensus/scripts"

rm -rf "$ROOT/.agents/skills/delegate"
ln -s "../../skills/delegate" "$ROOT/.agents/skills/delegate"

echo "==> Building consensus binary ($TARGET) to .agents/skills/consensus/bin/consensus..."
cd "$ROOT"
bun build --minify --compile "$ROOT/src/cli.ts" --target="$TARGET" --outfile "$OUTFILE"

echo "==> Done."
