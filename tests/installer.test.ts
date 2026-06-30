import { afterEach, describe, expect, it } from "bun:test";
import {
    chmod,
    cp,
    mkdir,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = new URL("..", import.meta.url).pathname;
const installerPath = join(
    repoRoot,
    "skills",
    "consensus",
    "scripts",
    "install.sh",
);
const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(
        tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
});

const tempDir = async (name: string): Promise<string> => {
    const dir =
        await Bun.$`mktemp -d ${join(tmpdir(), `${name}.XXXXXX`)}`.text();
    const trimmed = dir.trim();
    tempDirs.push(trimmed);
    return trimmed;
};

const writeExecutable = async (
    path: string,
    content: string,
): Promise<void> => {
    await writeFile(path, content);
    await chmod(path, 0o755);
};

const createCopiedSkill = async (): Promise<string> => {
    const dir = await tempDir("chorus-installer");
    await mkdir(join(dir, "scripts"), { recursive: true });
    await cp(installerPath, join(dir, "scripts", "install.sh"));
    await chmod(join(dir, "scripts", "install.sh"), 0o755);
    return dir;
};

const createTooling = async ({
    platform = "Darwin",
    arch = "arm64",
    binaryName = "consensus-darwin-arm64",
    checksum = "valid",
}: {
    platform?: string;
    arch?: string;
    binaryName?: string;
    checksum?: "valid" | "invalid";
} = {}): Promise<{ binDir: string; logPath: string }> => {
    const binDir = await tempDir("chorus-tools");
    const logPath = join(binDir, "calls.log");
    const binaryBody = "released binary\n";
    const digest = new Bun.CryptoHasher("sha256")
        .update(binaryBody)
        .digest("hex");
    const checksumValue =
        checksum === "valid"
            ? digest
            : "0000000000000000000000000000000000000000000000000000000000000000";

    await writeExecutable(
        join(binDir, "uname"),
        `#!/usr/bin/env bash
if [ "$1" = "-s" ]; then
  printf '%s\\n' '${platform}'
elif [ "$1" = "-m" ]; then
  printf '%s\\n' '${arch}'
else
  /usr/bin/uname "$@"
fi
`,
    );

    await writeExecutable(
        join(binDir, "curl"),
        `#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
printf 'curl %s\\n' "$url" >> '${logPath}'
case "$url" in
  */checksums.sha256)
    printf '%s  %s\\n' '${checksumValue}' '${binaryName}' > "$out"
    ;;
  */${binaryName})
    printf '%s' '${binaryBody}' > "$out"
    ;;
  *)
    printf 'unexpected url: %s\\n' "$url" >&2
    exit 9
    ;;
esac
`,
    );

    await writeExecutable(
        join(binDir, "xattr"),
        `#!/usr/bin/env bash
printf 'xattr %s\\n' "$*" >> '${logPath}'
exit 0
`,
    );

    return { binDir, logPath };
};

const runInstaller = async (
    cwd: string,
    binDir: string,
    args: string[] = [],
): Promise<{ exitCode: number; stderr: string; stdout: string }> => {
    const proc = Bun.spawn(["bash", "scripts/install.sh", ...args], {
        cwd,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        stderr: "pipe",
        stdout: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return { exitCode, stderr, stdout };
};

describe("skill-local installer", () => {
    it("installs the matching released binary under the copied skill directory by default", async () => {
        const skillDir = await createCopiedSkill();
        const { binDir, logPath } = await createTooling();

        const result = await runInstaller(skillDir, binDir);

        expect(result.exitCode).toBe(0);
        expect(await readFile(join(skillDir, "bin", "consensus"), "utf8")).toBe(
            "released binary\n",
        );
        expect(
            (await stat(join(skillDir, "bin", "consensus"))).mode & 0o111,
        ).toBeGreaterThan(0);
        expect(await readFile(logPath, "utf8")).toContain(
            "consensus-darwin-arm64",
        );
    });

    it("aborts on checksum mismatch without installing the executable", async () => {
        const skillDir = await createCopiedSkill();
        const { binDir } = await createTooling({ checksum: "invalid" });

        const result = await runInstaller(skillDir, binDir);

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("checksum");
        await expect(
            stat(join(skillDir, "bin", "consensus")),
        ).rejects.toThrow();
    });

    it("supports --prefix and --no-verify without downloading checksums", async () => {
        const skillDir = await createCopiedSkill();
        const prefix = await tempDir("chorus-prefix");
        const { binDir, logPath } = await createTooling();

        const result = await runInstaller(skillDir, binDir, [
            "--prefix",
            prefix,
            "--no-verify",
        ]);

        expect(result.exitCode).toBe(0);
        expect(await readFile(join(prefix, "consensus"), "utf8")).toBe(
            "released binary\n",
        );
        expect(await readFile(logPath, "utf8")).not.toContain(
            "checksums.sha256",
        );
    });

    it("strips macOS quarantine attributes from temporary and final binary paths", async () => {
        const skillDir = await createCopiedSkill();
        const { binDir, logPath } = await createTooling();

        const result = await runInstaller(skillDir, binDir);

        expect(result.exitCode).toBe(0);
        const log = await readFile(logPath, "utf8");
        expect(log).toContain("xattr -d com.apple.quarantine");
        expect(log).toContain(join(skillDir, "bin", "consensus"));
    });

    it("fails clearly for unsupported platforms", async () => {
        const skillDir = await createCopiedSkill();
        const { binDir } = await createTooling({ platform: "FreeBSD" });

        const result = await runInstaller(skillDir, binDir);

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Unsupported platform");
    });
});
