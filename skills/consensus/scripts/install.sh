#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/zaherg/chorus"
# Empty: install the latest published stable release. A tag such as "v0.2.0-rc.1": install exactly that release.
# Stable release commits keep this empty; release.yml enforces it.
CLI_VERSION=""
VERIFY=1
PREFIX=""

usage() {
    cat <<'EOF'
Usage: scripts/install.sh [--prefix DIR] [--no-verify]

Downloads the consensus release binary for this platform: the latest
published stable release, or the release named by CLI_VERSION in this script.

Options:
  --prefix DIR  Install to DIR/consensus instead of ./bin/consensus
  --no-verify   Skip checksums.sha256 verification
  -h, --help    Show this help
EOF
}

# Tags end up in download URLs, so they must match a strict pattern.
require_tag() {
    if [[ ! "$1" =~ $2 ]]; then
        echo "Error: $3: '$1' is not $4" >&2
        exit 1
    fi
}

while [ "$#" -gt 0 ]; do
    case "$1" in
    --prefix)
        if [ "$#" -lt 2 ]; then
            echo "Error: --prefix requires a directory" >&2
            exit 2
        fi
        PREFIX="$2"
        shift 2
        ;;
    --no-verify)
        VERIFY=0
        shift
        ;;
    -h | --help)
        usage
        exit 0
        ;;
    *)
        echo "Error: unknown argument: $1" >&2
        usage >&2
        exit 2
        ;;
    esac
done

case "$(uname -s)" in
Darwin)
    PLATFORM="darwin"
    ;;
Linux)
    PLATFORM="linux"
    ;;
*)
    echo "Unsupported platform: $(uname -s). Supported platforms: darwin, linux." >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
arm64 | aarch64)
    ARCH="arm64"
    ;;
x86_64 | amd64)
    ARCH="x64"
    ;;
*)
    echo "Unsupported platform: $(uname -s)-$(uname -m). Supported architectures: arm64, x64." >&2
    exit 1
    ;;
esac

if [ -n "$CLI_VERSION" ]; then
    require_tag "$CLI_VERSION" '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' "CLI_VERSION" "a release tag like v1.2.3"
else
    # GitHub redirects /releases/latest to the newest published, non-pre-release tag.
    # Resolve it once so the binary and checksums come from the same release.
    if ! latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${REPO_URL}/releases/latest")"; then
        echo "Error: could not look up the latest release at ${REPO_URL}/releases/latest" >&2
        exit 1
    fi
    CLI_VERSION="${latest_url##*/}"
    # Never install a pre-release by default, even if one were marked latest.
    require_tag "$CLI_VERSION" '^v[0-9]+\.[0-9]+\.[0-9]+$' "latest release lookup" "a stable release tag like v1.2.3"
fi

ARTIFACT="consensus-${PLATFORM}-${ARCH}"
BASE_URL="${REPO_URL}/releases/download/${CLI_VERSION}"
TMPDIR="$(mktemp -d)"

cleanup() {
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

if [ -n "$PREFIX" ]; then
    DEST_DIR="$PREFIX"
else
    DEST_DIR="$PWD/bin"
fi
DEST="${DEST_DIR}/consensus"

download() {
    url="$1"
    out="$2"
    curl -fsSL "$url" -o "$out"
}

strip_quarantine() {
    path="$1"
    if [ "$PLATFORM" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
        xattr -d com.apple.quarantine "$path" >/dev/null 2>&1 || true
    fi
}

verify_checksum() {
    checksum_file="$1"
    artifact_path="$2"
    expected_file="${TMPDIR}/expected.sha256"

    if ! grep -E "  ${ARTIFACT}$" "$checksum_file" >"$expected_file"; then
        echo "Error: checksum entry for ${ARTIFACT} not found in checksums.sha256" >&2
        exit 1
    fi

    if command -v shasum >/dev/null 2>&1; then
        if ! (cd "$TMPDIR" && shasum -a 256 -c "$expected_file") >/dev/null; then
            echo "Error: checksum verification failed for ${ARTIFACT}" >&2
            exit 1
        fi
    elif command -v sha256sum >/dev/null 2>&1; then
        if ! (cd "$TMPDIR" && sha256sum -c "$expected_file") >/dev/null; then
            echo "Error: checksum verification failed for ${ARTIFACT}" >&2
            exit 1
        fi
    else
        echo "Error: checksum verification requires shasum or sha256sum. Re-run with --no-verify to skip." >&2
        exit 1
    fi

    if [ ! -s "$artifact_path" ]; then
        echo "Error: downloaded artifact is empty: ${ARTIFACT}" >&2
        exit 1
    fi
}

ARTIFACT_PATH="${TMPDIR}/${ARTIFACT}"
CHECKSUM_PATH="${TMPDIR}/checksums.sha256"

echo "Downloading ${ARTIFACT} from ${CLI_VERSION}..."
download "${BASE_URL}/${ARTIFACT}" "$ARTIFACT_PATH"
strip_quarantine "$ARTIFACT_PATH"

if [ "$VERIFY" -eq 1 ]; then
    echo "Verifying checksum..."
    download "${BASE_URL}/checksums.sha256" "$CHECKSUM_PATH"
    verify_checksum "$CHECKSUM_PATH" "$ARTIFACT_PATH"
else
    echo "Skipping checksum verification (--no-verify)."
fi

mkdir -p "$DEST_DIR"
install -m 0755 "$ARTIFACT_PATH" "${DEST}.tmp"
strip_quarantine "${DEST}.tmp"
mv "${DEST}.tmp" "$DEST"
strip_quarantine "$DEST"

echo "Installed ${DEST}"
