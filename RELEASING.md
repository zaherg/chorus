# Releasing Chorus

## Overview

Pushing a new `v*` tag starts the `Release` workflow in `.github/workflows/release.yml`.
The workflow checks the tag, runs CI on the tagged commit, builds and runs each binary on its own platform, and creates a draft GitHub Release.
A maintainer reviews the draft and publishes it; nothing is published automatically.
There is no local release script.

## Workflow Sequencing

```
git push origin refs/tags/vX.Y.Z
  -> Validate tag: v<semver>, equal to package.json version and installer CLI_VERSION
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
The standalone agent skill uses `skills/consensus/scripts/install.sh` to download the binary for the release named by its `CLI_VERSION`.

## Repository Settings

Immutable releases are enabled, so a published release's tag and assets cannot change.
The `Release tags` ruleset allows only repository admins to create, move, or delete `v*` tags.
Workflows cannot create release tags, which keeps tagging a maintainer decision.

## Release Steps

1. Create a release branch from `main`.
2. Set `version` in `package.json` to `X.Y.Z` and `CLI_VERSION` in `skills/consensus/scripts/install.sh` to `vX.Y.Z`.
3. Generate the changelog with `bun run changelog:update -- --tag vX.Y.Z`, which requires [git-cliff](https://git-cliff.org); do not edit `CHANGELOG.md` by hand.
4. Commit the changes and get them reviewed; CI must pass on the branch.
5. Tag the reviewed commit and push only that tag:

   ```bash
   git tag vX.Y.Z <reviewed-commit>
   git push origin refs/tags/vX.Y.Z
   ```

   Push one tag at a time: GitHub creates no push event when more than three tags are pushed together.
6. Wait for the `Release` workflow, review the draft and its six assets, then publish it.
7. After publishing, bring the exact tagged commit into `main` by fast-forward or merge commit.
   Never squash, rebase, or force-push it away, or the tag leaves `main`'s history and git-cliff loses that release.

Publish before merging because `npx skills add zaherg/chorus` installs the skill from `main`, and its installer downloads the release named by `CLI_VERSION`.
Draft assets are not public, so `main` must not point at a release until it is published.

### First release after v0.1.0

The `v0.1.0` tag is not reachable from `main`, because `main` was rewritten after that release.
Merge `v0.1.0` into the release branch, keeping the new version and installer pin, before generating the changelog.
This keeps the `0.1.0` section and stops git-cliff from assigning its commits to the new version.

## Pre-releases

A tag with a semver pre-release suffix, such as `v0.2.0-rc.1`, creates a pre-release that never becomes `latest`.
Do not merge a pre-release's version and installer pin into `main`.
After publishing a release candidate, test the public download path on Linux ARM64 and Apple Silicon:

```bash
git show vX.Y.Z-rc.N:skills/consensus/scripts/install.sh > /tmp/install.sh
bash /tmp/install.sh --prefix /tmp/consensus-rc
/tmp/consensus-rc/consensus --version
```

## Troubleshooting

- **Tag validation fails**: no draft exists yet.
  An admin can delete the tag, fix the release commit, and push the tag again.
- **CI or a native build fails**: re-run the failed jobs for a transient runner error.
  For a real failure, delete the unpublished draft and tag, fix the commit, and tag again.
- **A published release is broken**: do not replace its assets; immutable releases reject that.
  Keep `main`'s installer pin on the last good release and publish a new version.
