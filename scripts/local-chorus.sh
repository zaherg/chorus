#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Building consensus binary..."
cd "$ROOT"
bun run build:binary

echo "==> Copying skills to .agents/skills/..."
mkdir -p "$ROOT/.agents/skills"
cp -R "$ROOT/skills/" "$ROOT/.agents/skills/"

echo "==> Detecting platform..."
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64)        ARCH="x64" ;;
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
BINARY="consensus-${OS}-${ARCH}"

echo "==> Moving consensus binary ($BINARY) to .agents/consensus/bin/..."
mkdir -p "$ROOT/.agents/skills/consensus/bin"
mv "$ROOT/dist/$BINARY" "$ROOT/.agents/skills/consensus/bin/consensus"

echo "==> Done."
