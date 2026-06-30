# Releasing Chorus

## Overview

Chorus uses a GitHub Actions driven release pipeline. A single manual dispatch starts `Prepare Release`, which runs the test gate, bumps the version, updates the changelog, and pushes a `v*` tag. The tag push then triggers `Release Orchestrator`, which re-runs the test gate and creates a draft GitHub Release with binaries when runtime inputs changed.

There is no local release script. Every release goes through GitHub Actions.

## Workflow Sequencing

```
Prepare Release (workflow_dispatch)
  -> test gate
  -> bump package.json + installer CLI_VERSION
  -> update CHANGELOG.md (via reusable Changelog)
  -> push v* tag
        |
        v  tag push
Release Orchestrator (on v* tag)
  -> test gate
  -> reusable Release (build + checksum + draft release)
```

## Release Rules

The npm package exposes `consensus` from the built `dist/cli.js` runtime. The standalone agent skill uses `skills/consensus/scripts/install.sh` to download the matching GitHub Release binary into `bin/consensus`. GitHub release binaries are generated with `bun build --compile` on a single runner producing cross-platform binaries for all releases.

## Step 1: Prepare Release

1. Go to **Actions > Prepare Release** in GitHub
2. Click **Run workflow** and pick a version bump (`patch`, `minor`, or `major`)
3. The workflow runs the test gate, bumps `package.json` and the installer `CLI_VERSION` pin together, commits them, updates `CHANGELOG.md`, and pushes the `v*` tag

## Step 2: Tag and Release

1. The `v*` tag push triggers `Release Orchestrator` automatically
2. It re-runs the test gate, then the reusable `Release` workflow
3. A single runner builds platform-specific binaries with `bun build --compile`:

   - `consensus-darwin-arm64`
   - `consensus-darwin-x64`
   - `consensus-linux-x64`
   - `consensus-linux-arm64`
   - `consensus-windows-x64.exe`

4. A checksum job generates `checksums.sha256` from all binaries
5. A **draft** GitHub Release is created with the binaries and checksums attached -- review and publish it manually
6. If only skill-text/docs changed, a draft release is created with notes only and no binary artifacts

## Version Bumping

Version is computed from the current `package.json` version plus the chosen bump (`patch`, `minor`, `major`). The CLI reads its version from `package.json` at build time, while `skills/consensus/scripts/install.sh` downloads the GitHub Release tag named by its embedded `CLI_VERSION`. Both are bumped together in `Prepare Release`, so they stay in sync.

Pre-release tags containing `beta`, `rc`, or an 8-digit date suffix are marked as pre-releases and do not become `latest`.

## Workflows

- `.github/workflows/prepare-release.yml` -- manual entry point (test gate, bump, changelog, tag)
- `.github/workflows/release-orchestrator.yml` -- tag-triggered (test gate, calls reusable Release)
- `.github/workflows/changelog.yml` -- reusable, called by `Prepare Release`
- `.github/workflows/release.yml` -- reusable, called by `Release Orchestrator`

## Troubleshooting

- **Test gate fails**: `Prepare Release` stops before tagging; fix the tests and re-run the dispatch.
- **Build failures**: Check the `Release` runner log. `bun build --compile` is used for each target platform from one runner.
- **Checksum job fails**: Ensure the `binaries` upload completed. The checksum job depends on it via `needs:`.
