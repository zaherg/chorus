#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER_REL="skills/consensus/scripts/install.sh"
INSTALLER_PATH="$ROOT/$INSTALLER_REL"
SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'

POLL_ATTEMPTS="${CHORUS_RELEASE_WAIT_ATTEMPTS:-30}"
POLL_SECONDS="${CHORUS_RELEASE_POLL_SECONDS:-5}"
RAW_BASE_URL="${CHORUS_RELEASE_RAW_BASE_URL:-https://raw.githubusercontent.com/zaherg/chorus/main}"

DRY_RUN=false
VERSION=""
TAG=""
BRANCH=""
PRERELEASE=false

usage() {
  cat <<'EOF'
Usage: scripts/release.sh <command> [args] [options]

Phased release helper implementing RELEASING.md while keeping tag creation and
immutable release publishing under local maintainer control.

Commands:
  prepare <version>     Create release/v<version> from main, bump package.json,
                        configure install.sh CLI_VERSION, run checks, and
                        generate CHANGELOG.md (for stable releases).
  tag <version>         Push release/v<version>, wait for CI, create and push
                        v<version> tag, and watch the Release workflow.
  finish <version>      Verify (or publish with --publish) the GitHub release,
                        fast-forward/merge stable releases into main, verify
                        install.sh, and clean up the release branch.
  cleanup-rc <version>  Delete candidate branch and unpublished draft/tag for a
                        pre-release version.
  status [version]      Show local git, version, installer, and GitHub state.
  help                  Show this help message.

Global options:
  --dry-run             Print mutating commands without executing them.
  -h, --help            Show this help message.

Command options:
  prepare:
    --skip-pull           Skip fetching/fast-forwarding main from origin.
    --skip-checks         Skip tsc, lint:check, format:check, and test.
  tag:
    --push-main           Push main to origin before pushing the release branch.
    --skip-ci-wait        Do not wait for ci.yml before creating the tag.
    --no-watch            Do not wait for release.yml after pushing the tag.
  finish:
    --publish             Publish the draft release via gh before finishing.
    --skip-install-verify Skip downloading and verifying install.sh.

Examples:
  scripts/release.sh prepare 0.3.1
  scripts/release.sh tag 0.3.1
  scripts/release.sh finish 0.3.1
  scripts/release.sh prepare 0.4.0-rc.1 --dry-run
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '==> %s\n' "$*"
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

run_cmd() {
  printf '+ '
  printf '%q ' "$@"
  printf '\n'
  if [ "$DRY_RUN" = true ]; then
    return 0
  fi
  "$@"
}

run_in_root() {
  printf '+ (cd %q && ' "$ROOT"
  printf '%q ' "$@"
  printf ')\n'
  if [ "$DRY_RUN" = true ]; then
    return 0
  fi
  (cd "$ROOT" && "$@")
}

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "Required tool '$1' was not found on PATH."
  fi
}

parse_version() {
  local raw="${1:-}"
  if [ -z "$raw" ]; then
    die "Missing <version> argument (for example: 0.3.1 or 0.4.0-rc.1)."
  fi
  VERSION="${raw#v}"
  if [[ ! "$VERSION" =~ $SEMVER_RE ]]; then
    die "Version '$raw' is not valid semver (<major>.<minor>.<patch>[-prerelease])."
  fi
  TAG="v${VERSION}"
  BRANCH="release/${TAG}"
  if [[ "$VERSION" == *-* ]]; then
    PRERELEASE=true
  else
    PRERELEASE=false
  fi
}

require_clean_tracked_tree() {
  if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet; then
    die "Working tree has uncommitted tracked changes. Commit or stash them first."
  fi
}

read_package_version() {
  bun -e 'const pkg = await Bun.file(process.argv[1]).json(); console.log(pkg.version ?? "");' "$ROOT/package.json"
}

read_installer_cli_version() {
  local count
  count="$(grep -c '^CLI_VERSION="[^"]*"$' "$INSTALLER_PATH" || true)"
  if [ "$count" != "1" ]; then
    die "$INSTALLER_REL must contain exactly one CLI_VERSION=\"...\" line (found $count)."
  fi
  sed -n 's/^CLI_VERSION="\(.*\)"$/\1/p' "$INSTALLER_PATH"
}

validate_installer_cli_version() {
  local cli_version
  cli_version="$(read_installer_cli_version)"
  if [ "$PRERELEASE" = false ]; then
    if [ -n "$cli_version" ]; then
      die "$INSTALLER_REL has CLI_VERSION=\"$cli_version\"; stable releases require CLI_VERSION=\"\"."
    fi
  else
    if [ -n "$cli_version" ] && [ "$cli_version" != "$TAG" ]; then
      die "$INSTALLER_REL has CLI_VERSION=\"$cli_version\"; pre-release $TAG requires empty or \"$TAG\"."
    fi
  fi
}

set_package_version() {
  local target_version="$1"
  if [ "$DRY_RUN" = true ]; then
    printf '+ update package.json version -> %s\n' "$target_version"
    return 0
  fi
  bun -e '
    const path = process.argv[1];
    const nextVersion = process.argv[2];
    const raw = await Bun.file(path).text();
    const updated = raw.replace(/^(\s*"version"\s*:\s*)"[^"]*"/m, `$1"${nextVersion}"`);
    if (updated === raw) {
      const parsed = JSON.parse(raw);
      if (parsed.version !== nextVersion) {
        throw new Error("Failed to locate version field in package.json");
      }
    }
    await Bun.write(path, updated);
  ' "$ROOT/package.json" "$target_version"
}

set_installer_cli_version() {
  local target_cli_version="$1"
  if [ "$DRY_RUN" = true ]; then
    printf '+ update %s CLI_VERSION -> "%s"\n' "$INSTALLER_REL" "$target_cli_version"
    return 0
  fi
  bun -e '
    const path = process.argv[1];
    const nextValue = process.argv[2];
    const raw = await Bun.file(path).text();
    const matches = raw.match(/^CLI_VERSION="[^"]*"$/gm) ?? [];
    if (matches.length !== 1) {
      throw new Error(`Expected exactly 1 CLI_VERSION line in ${path}, found ${matches.length}`);
    }
    const updated = raw.replace(/^CLI_VERSION="[^"]*"$/m, `CLI_VERSION="${nextValue}"`);
    await Bun.write(path, updated);
  ' "$INSTALLER_PATH" "$target_cli_version"
}

run_changelog_update() {
  local tag_name="$1"
  if command -v git-cliff >/dev/null 2>&1; then
    run_in_root bun run changelog:update -- --tag "$tag_name"
  elif command -v uv >/dev/null 2>&1; then
    run_in_root uv run --no-project --with git-cliff -- bun run changelog:update -- --tag "$tag_name"
  else
    die "Neither git-cliff nor uv was found on PATH. Install git-cliff or uv to generate CHANGELOG.md."
  fi
}

has_origin_remote() {
  git -C "$ROOT" remote get-url origin >/dev/null 2>&1
}

tag_exists_locally() {
  git -C "$ROOT" rev-parse -q --verify "refs/tags/$1" >/dev/null 2>&1
}

tag_exists_remotely() {
  if ! has_origin_remote; then
    return 1
  fi
  [ -n "$(git -C "$ROOT" ls-remote --tags origin "refs/tags/$1" 2>/dev/null || true)" ]
}

branch_exists_locally() {
  git -C "$ROOT" show-ref --verify --quiet "refs/heads/$1"
}

branch_exists_remotely() {
  if ! has_origin_remote; then
    return 1
  fi
  [ -n "$(git -C "$ROOT" ls-remote --heads origin "refs/heads/$1" 2>/dev/null || true)" ]
}

wait_for_workflow_run() {
  local workflow="$1"
  local commit_sha="$2"
  local branch_filter="${3:-}"

  if [ "$DRY_RUN" = true ]; then
    printf '+ gh run watch <latest %s run for %s> --exit-status\n' "$workflow" "$commit_sha"
    return 0
  fi

  local attempt=1
  local run_id=""
  while [ "$attempt" -le "$POLL_ATTEMPTS" ]; do
    local json
    if [ -n "$branch_filter" ]; then
      json="$(gh run list --workflow "$workflow" --branch "$branch_filter" --commit "$commit_sha" --json databaseId,status,conclusion,url --limit 1 2>/dev/null || echo '[]')"
    else
      json="$(gh run list --workflow "$workflow" --commit "$commit_sha" --json databaseId,status,conclusion,url --limit 1 2>/dev/null || echo '[]')"
    fi
    run_id="$(printf '%s' "$json" | bun -e 'const arr = JSON.parse(await new Response(Bun.stdin).text()); console.log(arr[0]?.databaseId ?? "");')"
    if [ -n "$run_id" ]; then
      break
    fi
    if [ "$attempt" -lt "$POLL_ATTEMPTS" ] && [ "$POLL_SECONDS" -gt 0 ]; then
      sleep "$POLL_SECONDS"
    fi
    attempt=$((attempt + 1))
  done

  if [ -z "$run_id" ]; then
    die "Timed out waiting for GitHub Actions workflow '$workflow' on commit $commit_sha."
  fi

  info "Watching $workflow run #$run_id..."
  gh run watch "$run_id" --exit-status
}

cmd_prepare() {
  local skip_pull=false
  local skip_checks=false
  local version_arg=""

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=true ;;
      --skip-pull) skip_pull=true ;;
      --skip-checks) skip_checks=true ;;
      -h | --help) usage; exit 0 ;;
      -*) die "Unknown option for prepare: $1" ;;
      *)
        if [ -n "$version_arg" ]; then
          die "Unexpected extra argument: $1"
        fi
        version_arg="$1"
        ;;
    esac
    shift
  done

  parse_version "$version_arg"
  require_tool git
  require_tool bun
  require_clean_tracked_tree

  if branch_exists_locally "$BRANCH"; then
    die "Local branch '$BRANCH' already exists. Switch to it or delete it before preparing again."
  fi
  if tag_exists_locally "$TAG"; then
    die "Local tag '$TAG' already exists. Published versions cannot be reused."
  fi
  if [ "$skip_pull" = false ] && tag_exists_remotely "$TAG"; then
    die "Remote tag '$TAG' already exists on origin. Published versions cannot be reused."
  fi

  info "Preparing $TAG on branch $BRANCH (prerelease=$PRERELEASE)"
  run_cmd git -C "$ROOT" switch main

  if [ "$skip_pull" = false ] && has_origin_remote; then
    run_cmd git -C "$ROOT" fetch origin main
    if [ "$DRY_RUN" = false ] && git -C "$ROOT" show-ref --verify --quiet refs/remotes/origin/main; then
      local behind ahead
      behind="$(git -C "$ROOT" rev-list --count main..origin/main)"
      ahead="$(git -C "$ROOT" rev-list --count origin/main..main)"
      if [ "$behind" -gt 0 ] && [ "$ahead" -gt 0 ]; then
        die "Local main has diverged from origin/main (ahead $ahead, behind $behind). Reconcile main first."
      elif [ "$behind" -gt 0 ]; then
        run_cmd git -C "$ROOT" merge --ff-only origin/main
      elif [ "$ahead" -gt 0 ]; then
        warn "Local main is ahead of origin/main by $ahead commit(s). Push main before or alongside the release branch."
      fi
    fi
  fi

  run_cmd git -C "$ROOT" switch -c "$BRANCH"
  set_package_version "$VERSION"

  if [ "$PRERELEASE" = true ]; then
    set_installer_cli_version "$TAG"
  else
    set_installer_cli_version ""
  fi

  if [ "$DRY_RUN" = false ]; then
    validate_installer_cli_version
  fi

  if [ "$skip_checks" = false ]; then
    info "Running local verification gates..."
    run_in_root bunx tsc --noEmit
    run_in_root bun run lint:check
    run_in_root bun run format:check
    run_in_root bun run test
  fi

  if [ "$PRERELEASE" = true ]; then
    run_cmd git -C "$ROOT" add package.json "$INSTALLER_REL"
    run_cmd git -C "$ROOT" commit -m "chore: prepare pre-release $VERSION"
  else
    run_cmd git -C "$ROOT" add package.json "$INSTALLER_REL"
    run_cmd git -C "$ROOT" commit -m "chore: bump version to $VERSION"

    info "Generating CHANGELOG.md via git-cliff..."
    run_changelog_update "$TAG"
    run_cmd git -C "$ROOT" add CHANGELOG.md
    run_cmd git -C "$ROOT" commit -m "chore: update changelog for $TAG"
  fi

  info "Prepared $BRANCH locally."
  printf 'Next step:\n  scripts/release.sh tag %s\n' "$VERSION"
}

cmd_tag() {
  local push_main=false
  local skip_ci_wait=false
  local no_watch=false
  local version_arg=""

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=true ;;
      --push-main) push_main=true ;;
      --skip-ci-wait) skip_ci_wait=true ;;
      --no-watch) no_watch=true ;;
      -h | --help) usage; exit 0 ;;
      -*) die "Unknown option for tag: $1" ;;
      *)
        if [ -n "$version_arg" ]; then
          die "Unexpected extra argument: $1"
        fi
        version_arg="$1"
        ;;
    esac
    shift
  done

  parse_version "$version_arg"
  require_tool git
  require_tool bun
  if [ "$skip_ci_wait" = false ] || [ "$no_watch" = false ]; then
    require_tool gh
  fi
  require_clean_tracked_tree

  if ! branch_exists_locally "$BRANCH"; then
    die "Branch '$BRANCH' does not exist locally. Run 'scripts/release.sh prepare $VERSION' first."
  fi
  if tag_exists_locally "$TAG"; then
    die "Local tag '$TAG' already exists."
  fi
  if tag_exists_remotely "$TAG"; then
    die "Remote tag '$TAG' already exists on origin."
  fi

  run_cmd git -C "$ROOT" switch "$BRANCH"

  if [ "$DRY_RUN" = false ]; then
    local pkg_version
    pkg_version="$(read_package_version)"
    if [ "$pkg_version" != "$VERSION" ]; then
      die "package.json version '$pkg_version' on $BRANCH does not match '$VERSION'."
    fi
    validate_installer_cli_version
  fi

  if [ "$push_main" = true ]; then
    run_cmd git -C "$ROOT" push origin main
  elif has_origin_remote && git -C "$ROOT" show-ref --verify --quiet refs/remotes/origin/main; then
    local unpushed_main
    unpushed_main="$(git -C "$ROOT" rev-list --count origin/main..main)"
    if [ "$unpushed_main" -gt 0 ]; then
      warn "Local main is ahead of origin/main by $unpushed_main commit(s). Re-run with --push-main or push main separately."
    fi
    if git -C "$ROOT" diff --name-only origin/main.."$BRANCH" | grep -q '^\.github/workflows/'; then
      warn "Commits being pushed modify .github/workflows/ (requires GitHub token 'workflow' scope)."
    fi
  fi

  info "Pushing $BRANCH to origin..."
  run_cmd git -C "$ROOT" push -u origin "$BRANCH"

  local head_sha
  head_sha="$(git -C "$ROOT" rev-parse HEAD)"

  if [ "$skip_ci_wait" = false ]; then
    wait_for_workflow_run "ci.yml" "$head_sha" "$BRANCH"
  fi

  info "Tagging $TAG at $head_sha and pushing tag to origin..."
  run_cmd git -C "$ROOT" tag "$TAG"
  run_cmd git -C "$ROOT" push origin "refs/tags/$TAG"

  if [ "$no_watch" = false ]; then
    wait_for_workflow_run "release.yml" "$head_sha"
    if [ "$DRY_RUN" = false ]; then
      local release_json asset_count release_url
      release_json="$(gh release view "$TAG" --json isDraft,url,assets)"
      asset_count="$(printf '%s' "$release_json" | bun -e 'const r = JSON.parse(await new Response(Bun.stdin).text()); console.log(Array.isArray(r.assets) ? r.assets.length : 0);')"
      release_url="$(printf '%s' "$release_json" | bun -e 'const r = JSON.parse(await new Response(Bun.stdin).text()); console.log(r.url ?? "");')"
      info "Draft release ready: $release_url ($asset_count assets)"
      if [ "$asset_count" -ne 6 ]; then
        warn "Expected 6 assets (5 binaries + checksums.sha256), found $asset_count."
      fi
    fi
  fi

  printf 'Next step after reviewing the draft release:\n  scripts/release.sh finish %s\n' "$VERSION"
}

verify_public_install() {
  local expected_version="$1"
  if [ "$DRY_RUN" = true ]; then
    printf '+ verify public install.sh downloads consensus %s\n' "$expected_version"
    return 0
  fi

  require_tool curl
  (
    work_dir="$(mktemp -d)"
    trap 'rm -rf "$work_dir"' EXIT

    mkdir -p "$work_dir/scripts"
    attempt=1
    actual=""
    while [ "$attempt" -le 5 ]; do
      curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 60 \
        "$RAW_BASE_URL/$INSTALLER_REL" -o "$work_dir/scripts/install.sh"
      rm -rf "$work_dir/bin"
      if (cd "$work_dir" && bash scripts/install.sh >/dev/null); then
        actual="$("$work_dir/bin/consensus" --version)"
        if [ "$actual" = "consensus $expected_version" ]; then
          info "Public install verified: $actual"
          exit 0
        fi
      fi
      if [ "$attempt" -lt 5 ]; then
        warn "Public install returned '${actual:-error}' (expected 'consensus $expected_version'); retrying after raw cache delay..."
        sleep 5
      fi
      attempt=$((attempt + 1))
    done

    die "Public install verification failed: got '${actual:-none}', expected 'consensus $expected_version'."
  )
}

verify_rc_install() {
  local expected_version="$1"
  local tag_name="$2"
  if [ "$DRY_RUN" = true ]; then
    printf '+ verify RC install.sh from tag %s downloads consensus %s\n' "$tag_name" "$expected_version"
    return 0
  fi

  (
    work_dir="$(mktemp -d)"
    trap 'rm -rf "$work_dir"' EXIT

    git -C "$ROOT" show "$tag_name:$INSTALLER_REL" >"$work_dir/install.sh"
    bash "$work_dir/install.sh" --prefix "$work_dir/bin"
    actual="$("$work_dir/bin/consensus" --version)"
    if [ "$actual" != "consensus $expected_version" ]; then
      die "RC install verification failed: got '$actual', expected 'consensus $expected_version'."
    fi
    info "RC install verified: $actual"
  )
}

cmd_finish() {
  local do_publish=false
  local skip_install_verify=false
  local version_arg=""

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=true ;;
      --publish) do_publish=true ;;
      --skip-install-verify) skip_install_verify=true ;;
      -h | --help) usage; exit 0 ;;
      -*) die "Unknown option for finish: $1" ;;
      *)
        if [ -n "$version_arg" ]; then
          die "Unexpected extra argument: $1"
        fi
        version_arg="$1"
        ;;
    esac
    shift
  done

  parse_version "$version_arg"
  require_tool git
  require_tool bun
  require_tool gh
  require_clean_tracked_tree

  local release_json is_draft release_url
  if [ "$DRY_RUN" = true ]; then
    is_draft="false"
    release_url="https://github.com/zaherg/chorus/releases/tag/$TAG"
  else
    release_json="$(gh release view "$TAG" --json isDraft,isPrerelease,url)"
    is_draft="$(printf '%s' "$release_json" | bun -e 'const r = JSON.parse(await new Response(Bun.stdin).text()); console.log(String(Boolean(r.isDraft)));')"
    release_url="$(printf '%s' "$release_json" | bun -e 'const r = JSON.parse(await new Response(Bun.stdin).text()); console.log(r.url ?? "");')"
  fi

  if [ "$is_draft" = "true" ]; then
    if [ "$do_publish" = true ]; then
      info "Publishing $TAG ($release_url)..."
      if [ "$PRERELEASE" = true ]; then
        run_cmd gh release edit "$TAG" --draft=false --prerelease
      else
        run_cmd gh release edit "$TAG" --draft=false --latest
      fi
    else
      die "Release $TAG is still a draft ($release_url). Review and publish it on GitHub first, or re-run with --publish."
    fi
  elif [ "$do_publish" = true ] && [ "$DRY_RUN" = true ]; then
    if [ "$PRERELEASE" = true ]; then
      run_cmd gh release edit "$TAG" --draft=false --prerelease
    else
      run_cmd gh release edit "$TAG" --draft=false --latest
    fi
  fi

  if [ "$PRERELEASE" = true ]; then
    info "Pre-release $TAG is published. Per RELEASING.md, pre-release branches are never merged into main."
    if [ "$skip_install_verify" = false ]; then
      verify_rc_install "$VERSION" "$TAG"
    fi
    printf 'When ready to clean up this candidate branch:\n  scripts/release.sh cleanup-rc %s\n' "$VERSION"
    return 0
  fi

  info "Bringing $BRANCH into main..."
  if [ "$DRY_RUN" = true ]; then
    run_cmd git -C "$ROOT" push origin "$BRANCH:main"
  elif ! git -C "$ROOT" push origin "$BRANCH:main"; then
    warn "Fast-forward push to origin/main was rejected; falling back to --no-ff merge."
    run_cmd git -C "$ROOT" switch main
    run_cmd git -C "$ROOT" pull --ff-only
    run_cmd git -C "$ROOT" merge --no-ff "$BRANCH" -m "Merge $BRANCH into main"
    run_cmd git -C "$ROOT" push origin main
  fi

  run_cmd git -C "$ROOT" switch main
  run_cmd git -C "$ROOT" pull --ff-only

  if branch_exists_remotely "$BRANCH"; then
    run_cmd git -C "$ROOT" push origin --delete "$BRANCH"
  fi
  if branch_exists_locally "$BRANCH"; then
    run_cmd git -C "$ROOT" branch -d "$BRANCH"
  fi

  if [ "$skip_install_verify" = false ]; then
    verify_public_install "$VERSION"
  fi

  info "Release $TAG complete."
}

cmd_cleanup_rc() {
  local version_arg=""

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=true ;;
      -h | --help) usage; exit 0 ;;
      -*) die "Unknown option for cleanup-rc: $1" ;;
      *)
        if [ -n "$version_arg" ]; then
          die "Unexpected extra argument: $1"
        fi
        version_arg="$1"
        ;;
    esac
    shift
  done

  parse_version "$version_arg"
  if [ "$PRERELEASE" != true ]; then
    die "cleanup-rc only accepts pre-release versions (for example: 0.4.0-rc.1)."
  fi
  require_tool git
  require_tool bun

  if command -v gh >/dev/null 2>&1; then
    local release_json=""
    if release_json="$(gh release view "$TAG" --json isDraft 2>/dev/null)"; then
      local is_draft
      is_draft="$(printf '%s' "$release_json" | bun -e 'const r = JSON.parse(await new Response(Bun.stdin).text()); console.log(String(Boolean(r.isDraft)));')"
      if [ "$is_draft" = "true" ]; then
        info "Deleting unpublished draft release and tag $TAG..."
        run_cmd gh release delete "$TAG" --cleanup-tag --yes
        if tag_exists_locally "$TAG"; then
          run_cmd git -C "$ROOT" tag -d "$TAG"
        fi
      else
        info "Pre-release $TAG is already published (immutable); keeping release and tag."
      fi
    fi
  fi

  local current_branch
  current_branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
  if [ "$current_branch" = "$BRANCH" ]; then
    run_cmd git -C "$ROOT" switch main
  fi

  if branch_exists_remotely "$BRANCH"; then
    run_cmd git -C "$ROOT" push origin --delete "$BRANCH"
  fi
  if branch_exists_locally "$BRANCH"; then
    run_cmd git -C "$ROOT" branch -D "$BRANCH"
  fi

  info "Cleaned up candidate $TAG."
}

cmd_status() {
  local version_arg=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h | --help) usage; exit 0 ;;
      -*) die "Unknown option for status: $1" ;;
      *) version_arg="$1" ;;
    esac
    shift
  done

  require_tool git
  require_tool bun

  local current_branch pkg_version cli_version latest_tag
  current_branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
  pkg_version="$(read_package_version)"
  cli_version="$(read_installer_cli_version)"
  latest_tag="$(git -C "$ROOT" tag --sort=-creatordate | head -n 1 || true)"

  printf 'Branch:            %s\n' "$current_branch"
  printf 'package.json:      %s\n' "$pkg_version"
  printf 'install.sh CLI:    "%s"\n' "$cli_version"
  printf 'Latest local tag:  %s\n' "${latest_tag:-none}"

  if has_origin_remote && git -C "$ROOT" show-ref --verify --quiet refs/remotes/origin/main; then
    local ahead behind
    ahead="$(git -C "$ROOT" rev-list --count origin/main..main)"
    behind="$(git -C "$ROOT" rev-list --count main..origin/main)"
    printf 'main vs origin:    ahead %s, behind %s\n' "$ahead" "$behind"
  fi

  local release_branches
  release_branches="$(git -C "$ROOT" for-each-ref --format='%(refname:short)' 'refs/heads/release/*' || true)"
  if [ -n "$release_branches" ]; then
    printf 'Release branches:  %s\n' "$(printf '%s' "$release_branches" | tr '\n' ' ')"
  else
    printf 'Release branches:  none\n'
  fi

  if [ -n "$version_arg" ] && command -v gh >/dev/null 2>&1; then
    parse_version "$version_arg"
    printf 'GitHub release %s:\n' "$TAG"
    gh release view "$TAG" --json tagName,isDraft,isPrerelease,url 2>/dev/null || printf '  not found\n'
  fi
}

main() {
  local cmd="${1:-help}"
  if [ "$#" -gt 0 ]; then
    shift
  fi

  case "$cmd" in
    prepare) cmd_prepare "$@" ;;
    tag) cmd_tag "$@" ;;
    finish) cmd_finish "$@" ;;
    cleanup-rc) cmd_cleanup_rc "$@" ;;
    status) cmd_status "$@" ;;
    -h | --help | help) usage ;;
    *) die "Unknown command '$cmd'. Run 'scripts/release.sh --help' for usage." ;;
  esac
}

main "$@"
