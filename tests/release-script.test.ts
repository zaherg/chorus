import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const releaseScriptPath = join(repoRoot, "scripts", "release.sh");
const tempDirs: string[] = [];

const makeTempDir = async (prefix: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
    tempDirs.push(dir);
    return dir;
};

const writeExecutable = async (path: string, content: string): Promise<void> => {
    await writeFile(path, content, "utf8");
    await chmod(path, 0o755);
};

const runCmd = async (
    cmd: string[],
    options: { cwd: string; env?: Record<string, string | undefined> },
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const proc = Bun.spawn(cmd, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { exitCode, stdout, stderr };
};

const runGit = async (cwd: string, args: string[]): Promise<void> => {
    const res = await runCmd(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
        { cwd },
    );
    if (res.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed (${res.exitCode}): ${res.stderr}`);
    }
};

const createReleaseFixtureRepo = async (): Promise<{
    repoDir: string;
    binDir: string;
    isolatedTmpDir: string;
}> => {
    const root = await makeTempDir("chorus-release-test");
    const originDir = join(root, "origin.git");
    const repoDir = join(root, "repo");
    const binDir = join(root, "bin");
    const isolatedTmpDir = join(root, "tmp");

    await mkdir(originDir, { recursive: true });
    await mkdir(join(repoDir, "scripts"), { recursive: true });
    await mkdir(join(repoDir, "skills", "consensus", "scripts"), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await mkdir(isolatedTmpDir, { recursive: true });

    await runGit(originDir, ["init", "--bare", "--initial-branch=main"]);
    await runGit(repoDir, ["init", "--initial-branch=main"]);
    await runGit(repoDir, ["remote", "add", "origin", originDir]);

    await copyFile(releaseScriptPath, join(repoDir, "scripts", "release.sh"));
    await chmod(join(repoDir, "scripts", "release.sh"), 0o755);
    await writeFile(join(repoDir, "package.json"), JSON.stringify({ version: "0.3.0" }, null, 2), "utf8");
    await writeExecutable(
        join(repoDir, "skills", "consensus", "scripts", "install.sh"),
        "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n",
    );

    await runGit(repoDir, ["add", "."]);
    await runGit(repoDir, ["commit", "-m", "chore: initial commit"]);
    await runGit(repoDir, ["push", "-u", "origin", "main"]);

    await writeExecutable(
        join(binDir, "mktemp"),
        `#!/usr/bin/env bash
set -euo pipefail
command -p mktemp -d "\${TMPDIR%/}/chorus-work.XXXXXX"
`,
    );

    return { repoDir, binDir, isolatedTmpDir };
};

afterEach(async () => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

describe("scripts/release.sh finish cleanup traps", () => {
    test("finish for stable release completes without unbound work_dir and cleans up temp dir", async () => {
        const { repoDir, binDir, isolatedTmpDir } = await createReleaseFixtureRepo();

        await runGit(repoDir, ["switch", "-c", "release/v0.3.1"]);
        await writeFile(join(repoDir, "package.json"), JSON.stringify({ version: "0.3.1" }, null, 2), "utf8");
        await runGit(repoDir, ["add", "package.json"]);
        await runGit(repoDir, ["commit", "-m", "chore: bump version to 0.3.1"]);
        await runGit(repoDir, ["push", "-u", "origin", "release/v0.3.1"]);

        await writeExecutable(
            join(binDir, "gh"),
            `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "view" ]; then
  printf '{"isDraft":false,"isPrerelease":false,"url":"https://example.test/releases/tag/v0.3.1"}\n'
  exit 0
fi
exit 1
`,
        );

        await writeExecutable(
            join(binDir, "curl"),
            `#!/usr/bin/env bash
set -euo pipefail
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    out="$2"
    shift 2
    continue
  fi
  shift
done
cat >"$out" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p bin
cat >bin/consensus <<'BIN'
#!/usr/bin/env bash
printf 'consensus 0.3.1\n'
BIN
chmod +x bin/consensus
EOF
chmod +x "$out"
`,
        );

        const res = await runCmd(["bash", join(repoDir, "scripts", "release.sh"), "finish", "0.3.1"], {
            cwd: repoDir,
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH ?? ""}`,
                TMPDIR: isolatedTmpDir,
            },
        });

        expect(res.stderr).not.toContain("unbound variable");
        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain("Public install verified: consensus 0.3.1");
        expect(res.stdout).toContain("Release v0.3.1 complete.");
        expect(await readdir(isolatedTmpDir)).toEqual([]);
    });

    test("finish for pre-release completes without unbound work_dir and cleans up temp dir", async () => {
        const { repoDir, binDir, isolatedTmpDir } = await createReleaseFixtureRepo();

        await runGit(repoDir, ["switch", "-c", "release/v0.4.0-rc.1"]);
        await writeExecutable(
            join(repoDir, "skills", "consensus", "scripts", "install.sh"),
            `#!/usr/bin/env bash
set -euo pipefail
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    prefix="$2"
    shift 2
    continue
  fi
  shift
done
mkdir -p "$prefix"
cat >"$prefix/consensus" <<'BIN'
#!/usr/bin/env bash
printf 'consensus 0.4.0-rc.1\n'
BIN
chmod +x "$prefix/consensus"
`,
        );
        await runGit(repoDir, ["add", "skills/consensus/scripts/install.sh"]);
        await runGit(repoDir, ["commit", "-m", "chore: prepare pre-release 0.4.0-rc.1"]);
        await runGit(repoDir, ["tag", "v0.4.0-rc.1"]);

        await writeExecutable(
            join(binDir, "gh"),
            `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "view" ]; then
  printf '{"isDraft":false,"isPrerelease":true,"url":"https://example.test/releases/tag/v0.4.0-rc.1"}\n'
  exit 0
fi
exit 1
`,
        );

        const res = await runCmd(["bash", join(repoDir, "scripts", "release.sh"), "finish", "0.4.0-rc.1"], {
            cwd: repoDir,
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH ?? ""}`,
                TMPDIR: isolatedTmpDir,
            },
        });

        expect(res.stderr).not.toContain("unbound variable");
        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain("RC install verified: consensus 0.4.0-rc.1");
        expect(await readdir(isolatedTmpDir)).toEqual([]);
    });

    test("failed RC install verification still cleans up temp dir", async () => {
        const { repoDir, binDir, isolatedTmpDir } = await createReleaseFixtureRepo();

        await runGit(repoDir, ["switch", "-c", "release/v0.4.0-rc.2"]);
        await writeExecutable(
            join(repoDir, "skills", "consensus", "scripts", "install.sh"),
            `#!/usr/bin/env bash
set -euo pipefail
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    prefix="$2"
    shift 2
    continue
  fi
  shift
done
mkdir -p "$prefix"
cat >"$prefix/consensus" <<'BIN'
#!/usr/bin/env bash
printf 'consensus 0.0.0-wrong\n'
BIN
chmod +x "$prefix/consensus"
`,
        );
        await runGit(repoDir, ["add", "skills/consensus/scripts/install.sh"]);
        await runGit(repoDir, ["commit", "-m", "chore: prepare pre-release 0.4.0-rc.2"]);
        await runGit(repoDir, ["tag", "v0.4.0-rc.2"]);

        await writeExecutable(
            join(binDir, "gh"),
            `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "view" ]; then
  printf '{"isDraft":false,"isPrerelease":true,"url":"https://example.test/releases/tag/v0.4.0-rc.2"}\n'
  exit 0
fi
exit 1
`,
        );

        const res = await runCmd(["bash", join(repoDir, "scripts", "release.sh"), "finish", "0.4.0-rc.2"], {
            cwd: repoDir,
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH ?? ""}`,
                TMPDIR: isolatedTmpDir,
            },
        });

        expect(res.exitCode).toBe(1);
        expect(res.stderr).toContain("RC install verification failed");
        expect(res.stderr).not.toContain("unbound variable");
        expect(await readdir(isolatedTmpDir)).toEqual([]);
    });
});
