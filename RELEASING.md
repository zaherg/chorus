# Releasing Chorus

## Overview

Pushing a new `v*` tag starts the `Release` workflow in `.github/workflows/release.yml`.
The workflow checks the tag, runs CI on the tagged commit, builds and runs each binary on its own platform, and creates a draft GitHub Release.
A maintainer reviews the draft and publishes it; nothing is published automatically.
There is no local release script; this file is the runbook.

## Workflow Sequencing

```
git push origin refs/tags/vX.Y.Z
  -> Validate tag: v<semver>, equal to package.json version; installer CLI_VERSION empty (stable) or the tag (pre-release)
  -> CI (reusable ci.yml): lint, format, typecheck, bun run test
  -> Build on 5 native runners: compile, run --version and --schema, upload the tested file
  -> Draft release: 5 binaries + checksums.sha256
  -> Maintainer publishes the draft
```

Branch pushes, pull requests, tag moves, and tag deletions never start a release.

## Release Assets

| Native runner | Asset |
|---|---|
| `ubuntu-24.04` | `consensus-linux-x64` |
| `ubuntu-24.04-arm` | `consensus-linux-arm64` |
| `macos-15` | `consensus-darwin-arm64` |
| `macos-15-intel` | `consensus-darwin-x64` |
| `windows-2025` | `consensus-windows-x64.exe` |

Each binary is built on its own platform so platform-specific packages are installed, then run from a directory outside the checkout with no `node_modules`.
`--version` must print `consensus <version>` and `--schema` must report `cli.consensus/2`; any failure stops the release before a draft exists.
The npm package exposes `consensus` from the built `dist/cli.js` runtime.
The standalone agent skill uses `skills/consensus/scripts/install.sh` to download the binary from the latest published stable release; pre-releases and drafts are never installed by default.
If `CLI_VERSION` at the top of the installer is set to a tag, the installer downloads exactly that release instead.
The tag check in `release.yml` requires `CLI_VERSION` to be empty for a stable release, and empty or equal to the tag for a pre-release.

## Repository Settings

Immutable releases are enabled, so a published release's tag and assets cannot change.
The `Release tags` ruleset allows only repository admins to create, move, or delete `v*` tags.
Workflows cannot create release tags, which keeps tagging a maintainer decision.

## Prerequisites

- Admin access to `zaherg/chorus`, which the ruleset requires for pushing `v*` tags.
- Bun at the version in `package.json` `packageManager`.
- [git-cliff](https://git-cliff.org) on `PATH` for `bun run changelog:update`.
  Without a global install, `uv run --no-project --with git-cliff -- bun run changelog:update -- --tag vX.Y.Z` provides it for one command.
- The [GitHub CLI](https://cli.github.com) (`gh`) for watching runs, downloading assets, and cleanup; the web UI works too.
- A Git token with the `workflow` scope, but only when pushing commits that change `.github/workflows/`.
  Release branches change only `package.json` and `CHANGELOG.md`, so they do not need it.
- A passing `CI` run on `main`.

## Choose the Version

Versions follow semver, and each tag is `v` followed by the `package.json` version.
Before 1.0, a breaking change bumps the minor version, for example `0.2.0` to `0.3.0`.
Breaking changes include removed config keys, routes, or flags, and stricter input checks.
Fixes bump the patch version, for example `0.2.0` to `0.2.1`.
A published version can never be reused, because immutable releases lock its tag.
Ship a release candidate first when a change affects how binaries are built or installed; see [Release Candidates](#release-candidates).

## Stable Release

### 1. Prepare the release branch

Start from an up-to-date `main` with a clean working tree:

```bash
git switch main
git pull --ff-only
git switch -c release/vX.Y.Z
```

Set `version` in `package.json` to `X.Y.Z`.
Leave `CLI_VERSION=""` in `skills/consensus/scripts/install.sh`; the tag check rejects a stable release that sets it.
Then commit the bump and generate the changelog:

```bash
git commit -am "chore: bump version to X.Y.Z"
bun run changelog:update -- --tag vX.Y.Z
git commit -am "chore: update changelog for vX.Y.Z"
```

Do not edit `CHANGELOG.md` by hand; git-cliff regenerates it from commit messages.
Check that the new `X.Y.Z` section is on top and that earlier sections are unchanged.

### 2. Push the branch and wait for CI

```bash
git push -u origin release/vX.Y.Z
gh run list --branch release/vX.Y.Z --workflow ci.yml --limit 1
```

Continue only after that `CI` run passes.

### 3. Tag the release

Tag the branch head that CI checked, and push only that tag:

```bash
git tag vX.Y.Z
git push origin refs/tags/vX.Y.Z
```

GitHub prints `Bypassed rule violations` for an admin; that is expected.
Push one tag at a time: GitHub creates no push event when more than three tags are pushed together.

### 4. Watch the Release workflow

```bash
gh run list --workflow release.yml --limit 1
gh run watch <run-id> --exit-status
```

The run takes a few minutes.
No draft exists until every native build passes; if a job fails, see [Troubleshooting](#troubleshooting).

### 5. Review the draft

Open the draft on the [Releases page](https://github.com/zaherg/chorus/releases) and check that it has six assets: five binaries and `checksums.sha256`.
On Linux, spot-check a downloaded binary:

```bash
gh release download vX.Y.Z --pattern 'consensus-linux-*' --pattern checksums.sha256 --dir /tmp/chorus-vX.Y.Z
cd /tmp/chorus-vX.Y.Z && sha256sum -c --ignore-missing checksums.sha256
```

If users must do something after upgrading, add a note to the draft now; see [Release Notes](#release-notes).

### 6. Publish

Click **Publish release** and keep **Set as the latest release** checked.
A draft cannot be marked latest before publishing, and the installer downloads whichever release is latest.
Publishing is irreversible: the tag and assets lock, and new installs pick up the release immediately.

### 7. Bring the release into `main`

Fast-forward `main` to the tagged commit:

```bash
git push origin release/vX.Y.Z:main
```

If GitHub rejects the push because `main` has moved, merge with a merge commit instead:

```bash
git switch main
git pull --ff-only
git merge --no-ff release/vX.Y.Z
git push origin main
```

Never squash, rebase, or force-push the release commits.
The tag must stay in `main`'s history, or git-cliff loses that release in later changelogs.
Merge promptly: `npx skills add zaherg/chorus` installs the skill text from `main`, which should describe the binary it installs.

### 8. Verify the public install

Run the installer from `main` in an empty directory:

```bash
tmp="$(mktemp -d)" && mkdir "$tmp/scripts"
curl -fsSL https://raw.githubusercontent.com/zaherg/chorus/main/skills/consensus/scripts/install.sh -o "$tmp/scripts/install.sh"
(cd "$tmp" && bash scripts/install.sh && bin/consensus --version)
```

Expect `Downloading consensus-<platform>-<arch> from vX.Y.Z...` and `consensus X.Y.Z`.
`raw.githubusercontent.com` can serve the previous `main` for a few minutes after a push.

### 9. Clean up

```bash
git switch main
git pull --ff-only
git push origin --delete release/vX.Y.Z
git branch -d release/vX.Y.Z
```

Also remove leftover release candidates for this version, as described below.

## Release Candidates

A release candidate follows the stable steps with these differences:

- Name the branch `release/vX.Y.Z-rc.N` and set `version` to `X.Y.Z-rc.N`.
- Set `CLI_VERSION="vX.Y.Z-rc.N"` in the installer, so the candidate's own installer installs it.
  The tag check accepts an empty value or exactly this tag.
- The changelog commit is optional; the stable release regenerates it.
- Tag `vX.Y.Z-rc.N`.
  The workflow marks it as a pre-release, which never becomes latest, so default installs never pick it up.
- After publishing it, test the public download on Linux ARM64 and Apple Silicon:

  ```bash
  tmp="$(mktemp -d)"
  git show vX.Y.Z-rc.N:skills/consensus/scripts/install.sh > "$tmp/install.sh"
  bash "$tmp/install.sh" --prefix "$tmp/bin"
  "$tmp/bin/consensus" --version
  ```

- Never merge a release-candidate branch into `main`; its version and `CLI_VERSION` must not reach `main`.
  Start the stable release from `main` at step 1.

After the stable release is published, delete the candidate branches.
Delete unpublished candidate drafts together with their tags; published candidates are immutable and stay:

```bash
gh release delete vX.Y.Z-rc.N --cleanup-tag --yes
git tag -d vX.Y.Z-rc.N
git push origin --delete release/vX.Y.Z-rc.N
git branch -D release/vX.Y.Z-rc.N
```

## Release Notes

The workflow asks GitHub to generate the draft's notes; `CHANGELOG.md` remains the curated record.
When users must act after upgrading, put a note at the top of the draft before publishing.
Release notes stay editable after publishing; only the tag and assets lock.
The note used for `v0.2.0` is an example:

```markdown
**Upgrading from v0.0.7 or v0.1.0:** those binaries can crash on startup with `Cannot require module @basetenlabs/performance-client-...`, and their skill installer is pinned to them.
Delete the installed Chorus skill folders (`consensus` and `delegate`, wherever your agent keeps skills, for example `.agents/skills/`), then reinstall with `npx skills add zaherg/chorus`.
The new installer downloads the latest release.
Baseten users: see [Migrating from Baseten](https://github.com/zaherg/chorus/blob/main/docs/providers.md#migrating-from-baseten).
```

## Troubleshooting

- **Tag validation fails**: no draft exists yet.
  `package.json version ... does not match tag` means the wrong commit was tagged or the version was not bumped.
  `CLI_VERSION is ...` means the installer constant is set; clear it for a stable release.
  An admin deletes the tag with `git push origin --delete vX.Y.Z` and `git tag -d vX.Y.Z`, fixes the branch, and tags again.
- **CI or a native build fails**: for a transient runner error, run `gh run rerun <run-id> --failed`.
  For a real failure, delete the tag, fix the branch, and tag again.
- **Push rejected with `without workflow scope`**: the token cannot push changes to `.github/workflows/`.
  Run `gh auth refresh -h github.com -s workflow`, or push from a session whose token has that scope.
- **Tag push rejected by the ruleset**: only repository admins can create `v*` tags.
- **Installs get an older version**: check which release is latest with `gh api repos/zaherg/chorus/releases/latest --jq .tag_name`.
  If **Set as the latest release** was unchecked, mark the new release as latest in its settings.
- **A published release is broken**: do not replace its assets; immutable releases reject that.
  Mark the last good release as latest so new installs avoid the broken one, then publish a fixed patch version.
