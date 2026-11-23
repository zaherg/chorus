const [targetPath, expectedVersion] = process.argv.slice(2);

if (!targetPath || !expectedVersion) {
    process.stderr.write("Usage: bun scripts/smoke-test-cli.ts <cli-binary-or-js> <expected-version>\n");
    process.exit(2);
}

const commandPrefix =
    targetPath.endsWith(".js") || targetPath.endsWith(".ts") ? [process.execPath, targetPath] : [targetPath];

const runCli = async (args: string[]) => {
    const proc = Bun.spawn([...commandPrefix, ...args], {
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

const versionRun = await runCli(["--version"]);
const actualVersion = versionRun.stdout.trim();
const expectedLine = `consensus ${expectedVersion}`;
if (versionRun.exitCode !== 0 || actualVersion !== expectedLine) {
    process.stderr.write(
        `${targetPath} --version failed (exit ${versionRun.exitCode}): got '${actualVersion}', expected '${expectedLine}'\n${versionRun.stderr}`,
    );
    process.exit(1);
}

const schemaRun = await runCli(["--schema"]);
if (schemaRun.exitCode !== 0) {
    process.stderr.write(`${targetPath} --schema failed (exit ${schemaRun.exitCode})\n${schemaRun.stderr}`);
    process.exit(1);
}

let doc: unknown;
try {
    doc = JSON.parse(schemaRun.stdout);
} catch (err) {
    process.stderr.write(`${targetPath} --schema did not emit valid JSON: ${String(err)}\n`);
    process.exit(1);
}

const schemaObj = doc as {
    $schema?: unknown;
    anyOf?: Array<{ properties?: { schema?: { const?: unknown } } }>;
};
const schemas = Array.isArray(schemaObj.anyOf)
    ? schemaObj.anyOf.map((variant) => variant?.properties?.schema?.const)
    : [];

if (
    typeof schemaObj.$schema !== "string" ||
    !schemas.includes("cli.consensus/2") ||
    !schemas.includes("cli.consensus.error/1")
) {
    process.stderr.write(`unexpected --schema JSON Schema output from ${targetPath}\n`);
    process.exit(1);
}

process.stdout.write(`${targetPath}: ${actualVersion}\n`);
