import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const installerPath = join(repoRoot, "skills", "consensus", "scripts", "install.sh");
const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
});

const tempDir = async (name: string): Promise<string> => {
    const dir = await Bun.$`mktemp -d ${join(tmpdir(), `${name}.XXXXXX`)}`.text();
    const trimmed = await realpath(dir.trim());
    tempDirs.push(trimmed);
    return trimmed;
};

const writeExecutable = async (path: string, content: string): Promise<void> => {
    await writeFile(path, content);
    await chmod(path, 0o755);
};

const createCopiedSkill = async (cliVersion = ""): Promise<string> => {
    const dir = await tempDir("chorus-installer");
    await mkdir(join(dir, "scripts"), { recursive: true });
    const installer = await readFile(installerPath, "utf8");
    expect(installer).toContain('\nCLI_VERSION=""\n');
    await writeFile(
        join(dir, "scripts", "install.sh"),
        installer.replace('\nCLI_VERSION=""\n', `\nCLI_VERSION="${cliVersion}"\n`),
    );
    await chmod(join(dir, "scripts", "install.sh"), 0o755);
    return dir;
};

const createTooling = async ({
    platform = "Darwin",
    arch = "arm64",
    binaryName = "consensus-darwin-arm64",
    checksum = "valid",
    latestUrl = "https://github.com/zaherg/chorus/releases/tag/v9.9.9",
    latestFails = false,
}: {
    platform?: string;
    arch?: string;
    binaryName?: string;
    checksum?: "valid" | "invalid" | "duplicate" | "malformed";
    latestUrl?: string;
    latestFails?: boolean;
} = {}): Promise<{ binDir: string; logPath: string }> => {
    const binDir = await tempDir("chorus-tools");
    const logPath = join(binDir, "calls.log");
    const binaryBody = "released binary\n";
    const digest = new Bun.CryptoHasher("sha256").update(binaryBody).digest("hex");
    const checksumLines =
        checksum === "valid"
            ? `${digest}  ${binaryName}\n`
            : checksum === "duplicate"
              ? `${digest}  ${binaryName}\n${digest}  ${binaryName}\n`
              : checksum === "malformed"
                ? `not-a-sha256  ${binaryName}\n`
                : `0000000000000000000000000000000000000000000000000000000000000000  ${binaryName}\n`;

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
    -o | -w | --proto | --connect-timeout | --max-time)
      [ "$1" = -o ] && out="$2"
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
  */releases/latest)
    ${latestFails ? "exit 22" : `printf '%s' '${latestUrl}'`}
    ;;
  */checksums.sha256)
    printf '%s' '${checksumLines}' > "$out"
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
    it("installs the latest released binary under the copied skill directory by default", async () => {
        const skillDir = await createCopiedSkill();
        const { binDir, logPath } = await createTooling();
        const installedPath = join(skillDir, "bin", "consensus");

        const result = await runInstaller(skillDir, binDir);

        expect(result.exitCode).toBe(0);
        expect(await readFile(installedPath, "utf8")).toBe("released binary\n");
        expect((await stat(installedPath)).mode & 0o111).toBeGreaterThan(0);
        const log = await readFile(logPath, "utf8");
        expect(log).toContain("curl https://github.com/zaherg/chorus/releases/latest\n");
        expect(log).toContain(
            "curl https://github.com/zaherg/chorus/releases/download/v9.9.9/consensus-darwin-arm64\n",
        );
        expect(log).toContain("curl https://github.com/zaherg/chorus/releases/download/v9.9.9/checksums.sha256\n");
        const escapedInstalledPath = installedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const xattrCalls = log.split("\n").filter((line) => line.startsWith("xattr "));
        expect(xattrCalls).toEqual([
            expect.stringMatching(/xattr -d com\.apple\.quarantine .+\/consensus-darwin-arm64$/),
            expect.stringMatching(
                new RegExp(`^xattr -d com\\.apple\\.quarantine ${escapedInstalledPath}\\.tmp\\.[^/]+$`),
            ),
            `xattr -d com.apple.quarantine ${installedPath}`,
        ]);
    });

    it("installs the CLI_VERSION release without looking up the latest", async () => {
        const skillDir = await createCopiedSkill("v0.2.0-rc.1");
        const { binDir, logPath } = await createTooling();

        const result = await runInstaller(skillDir, binDir);

        expect(result.exitCode).toBe(0);
        const log = await readFile(logPath, "utf8");
        expect(log).not.toContain("releases/latest");
        expect(log).toContain(
            "curl https://github.com/zaherg/chorus/releases/download/v0.2.0-rc.1/consensus-darwin-arm64\n",
        );
    });

    it("rejects release tags that are not v<major>.<minor>.<patch>", async () => {
        const skillDir = await createCopiedSkill("../v1.2.3");
        const { binDir, logPath } = await createTooling();

        const result = await runInstaller(skillDir, binDir);

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("is not a release tag");
        await expect(readFile(logPath, "utf8")).rejects.toThrow();
    });

    it("never installs a pre-release by default", async () => {
        const skillDir = await createCopiedSkill();
        const { binDir, logPath } = await createTooling({
            latestUrl: "https://github.com/zaherg/chorus/releases/tag/v1.0.0-rc.1",
        });

        const result = await runInstaller(skillDir, binDir);

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("is not a stable release tag");
        expect(await readFile(logPath, "utf8")).not.toContain("releases/download");
        await expect(stat(join(skillDir, "bin", "consensus"))).rejects.toThrow();
    });

    it("fails without installing when no published release exists", async () => {
        const skillDir = await createCopiedSkill();
        // GitHub redirects /releases/latest to /releases when there is no published release.
        const { binDir, logPath } = await createTooling({ latestUrl: "https://github.com/zaherg/chorus/releases" });

        const result = await runInstaller(skillDir, binDir);

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("latest release lookup");
        expect(await readFile(logPath, "utf8")).not.toContain("releases/download");
        await expect(stat(join(skillDir, "bin", "consensus"))).rejects.toThrow();
    });

    it("fails without installing when the latest release lookup fails", async () => {
        const skillDir = await createCopiedSkill();
        const { binDir, logPath } = await createTooling({ latestFails: true });

        const result = await runInstaller(skillDir, binDir);

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("could not look up the latest release");
        expect(await readFile(logPath, "utf8")).not.toContain("releases/download");
        await expect(stat(join(skillDir, "bin", "consensus"))).rejects.toThrow();
    });

    it("aborts on checksum mismatch without installing the executable", async () => {
        const skillDir = await createCopiedSkill();
        const { binDir, logPath } = await createTooling({ checksum: "invalid" });

        const result = await runInstaller(skillDir, binDir);

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("checksum");
        await expect(stat(join(skillDir, "bin", "consensus"))).rejects.toThrow();
        const log = await readFile(logPath, "utf8");
        const xattrCalls = log.split("\n").filter((line) => line.startsWith("xattr "));
        expect(xattrCalls).toEqual([]);
    });

    it("aborts when checksums.sha256 has duplicate or malformed entries for the artifact", async () => {
        for (const mode of ["duplicate", "malformed"] as const) {
            const skillDir = await createCopiedSkill();
            const { binDir, logPath } = await createTooling({ checksum: mode });

            const result = await runInstaller(skillDir, binDir);

            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain("checksum");
            await expect(stat(join(skillDir, "bin", "consensus"))).rejects.toThrow();
            const log = await readFile(logPath, "utf8");
            const xattrCalls = log.split("\n").filter((line) => line.startsWith("xattr "));
            expect(xattrCalls).toEqual([]);
        }
    });

    it("supports --prefix and --no-verify without downloading checksums", async () => {
        const skillDir = await createCopiedSkill();
        const prefix = await tempDir("chorus-prefix");
        const { binDir, logPath } = await createTooling();

        const result = await runInstaller(skillDir, binDir, ["--prefix", prefix, "--no-verify"]);

        expect(result.exitCode).toBe(0);
        expect(await readFile(join(prefix, "consensus"), "utf8")).toBe("released binary\n");
        expect(await readFile(logPath, "utf8")).not.toContain("checksums.sha256");
    });

    it("fails clearly for unsupported platforms", async () => {
        const skillDir = await createCopiedSkill();
        const { binDir } = await createTooling({ platform: "FreeBSD" });

        const result = await runInstaller(skillDir, binDir);

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Unsupported platform");
    });
});
