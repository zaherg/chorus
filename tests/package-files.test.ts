import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;

describe("package files", () => {
  it("keeps npm CLI bin on the built runtime instead of the skill-local installer", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));

    expect(pkg.bin).toEqual({ consensus: "dist/cli.js" });
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("skills");
  });

  it("ignores downloaded skill-local binaries while keeping installer files publishable", async () => {
    const gitignore = await readFile(join(repoRoot, ".gitignore"), "utf8");
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));

    expect(gitignore).toContain("skills/**/bin/");
    expect(pkg.files).not.toContain("skills/**/bin");
    expect(pkg.files).toContain("skills");
  });
});
