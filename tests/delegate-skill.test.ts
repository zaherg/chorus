import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillPath = join(repoRoot, "skills/delegate/SKILL.md");
const skill = readFileSync(skillPath, "utf8");

function frontmatter(source: string): Record<string, string> {
    const match = source.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) return {};
    const result: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
        const idx = line.indexOf(":");
        if (idx > 0) {
            result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
    }
    return result;
}

function extractPiSection(source: string): string {
    const heading = "### Pi Coding Agent";
    const start = source.indexOf(heading);
    if (start === -1) return "";
    const rest = source.slice(start + heading.length);
    const next = rest.search(/\n### /);
    return next === -1 ? rest : rest.slice(0, next);
}

interface ShellBlock {
    body: string;
    heading: string | null;
    invocation: string;
}

function shellBlocks(section: string): ShellBlock[] {
    const blocks: ShellBlock[] = [];
    const fence = /```(?:bash|sh|shell|zsh)\r?\n([\s\S]*?)```/g;

    for (const match of section.matchAll(fence)) {
        const body = match[1];
        const prefix = section.slice(0, match.index);
        const headings = [...prefix.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)];
        const heading = headings.at(-1)?.[1] ?? null;
        const joined = body.replace(/\\\r?\n/g, " ");

        for (const raw of joined.split(/\r?\n/)) {
            const trimmed = raw.trim();
            if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
            blocks.push({ body, heading, invocation: trimmed });
        }
    }

    return blocks;
}

type PiKind = "task" | "discovery" | "readiness";

interface PiInvocation {
    command: string;
    heading: string | null;
    kind: PiKind;
    tokens: string[];
}

interface ParsedCommand {
    options: Map<string, Array<string | null>>;
    positionals: string[];
}

const VALUE_OPTIONS = new Set(["--model", "--thinking", "--tools"]);

type TaskRole = "implementation" | "review";

function assertNoUnquotedShellExecution(command: string): void {
    let quote: "'" | '"' | null = null;
    let escaped = false;

    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (character === "\\" && quote !== "'") {
            escaped = true;
            continue;
        }

        if (character === "'" || character === '"') {
            if (quote === character) {
                quote = null;
            } else if (quote === null) {
                quote = character;
            }
            continue;
        }

        if (quote === "'") continue;

        if (
            character === "`" ||
            (character === "$" && command[index + 1] === "(")
        ) {
            throw new Error(
                `Command substitution is not allowed in: ${command}`,
            );
        }

        if (quote === null && /[;|&<>()]/.test(character)) {
            throw new Error(
                `Unquoted shell operator is not allowed in: ${command}`,
            );
        }
    }
}

function shellTokens(command: string): string[] {
    assertNoUnquotedShellExecution(command);

    const tokens: string[] = [];
    let current = "";
    let quote: "'" | '"' | null = null;
    let escaped = false;

    const pushCurrent = () => {
        if (current.length === 0) return;
        tokens.push(current);
        current = "";
    };

    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];

        if (escaped) {
            current += character;
            escaped = false;
            continue;
        }

        if (character === "\\" && quote !== "'") {
            escaped = true;
            continue;
        }

        if (quote !== null) {
            if (character === quote) {
                quote = null;
            } else {
                current += character;
            }
            continue;
        }

        if (character === "'" || character === '"') {
            quote = character;
            continue;
        }

        if (/\s/.test(character)) {
            pushCurrent();
            continue;
        }

        current += character;
    }

    if (escaped || quote !== null) {
        throw new Error(`Unterminated shell token in: ${command}`);
    }

    pushCurrent();
    return tokens;
}

function parseCommandOptions(
    tokens: string[],
    startIndex: number,
): ParsedCommand {
    const options = new Map<string, Array<string | null>>();
    const positionals: string[] = [];

    const addOption = (name: string, value: string | null) => {
        const values = options.get(name) ?? [];
        values.push(value);
        options.set(name, values);
    };

    for (let index = startIndex; index < tokens.length; index += 1) {
        const token = tokens[index];

        if (!token.startsWith("-") || token === "-") {
            positionals.push(token);
            continue;
        }

        if (!token.startsWith("--")) {
            addOption(token, null);
            continue;
        }

        const equals = token.indexOf("=");
        if (equals > 2) {
            addOption(token.slice(0, equals), token.slice(equals + 1));
            continue;
        }

        if (VALUE_OPTIONS.has(token)) {
            const value = tokens[index + 1];
            if (value === undefined || value.startsWith("-")) {
                throw new Error(`Missing value for ${token}`);
            }
            addOption(token, value);
            index += 1;
            continue;
        }

        addOption(token, null);
    }

    return { options, positionals };
}

function expectExactOptions(
    invocation: PiInvocation,
    startIndex: number,
    expected: ReadonlyMap<string, string | null>,
    positionalCount: number,
): ParsedCommand {
    const parsed = parseCommandOptions(invocation.tokens, startIndex);
    expect([...parsed.options.keys()].sort()).toEqual(
        [...expected.keys()].sort(),
    );
    for (const [name, value] of expected) {
        expect(
            parsed.options.get(name),
            `Unexpected values for ${name}`,
        ).toEqual([value]);
    }
    expect(parsed.positionals).toHaveLength(positionalCount);
    return parsed;
}

function taskRole(invocation: PiInvocation): TaskRole | null {
    const heading = invocation.heading?.toLowerCase() ?? "";

    if (heading.startsWith("focused implementation delegation")) {
        return "implementation";
    }

    if (heading.startsWith("tool-restricted review delegation")) {
        return "review";
    }

    return null;
}

function expectMeaningfulPrompt(parsed: ParsedCommand): void {
    expect(parsed.positionals).toHaveLength(1);
    const prompt = parsed.positionals[0].trim();
    expect(prompt.length).toBeGreaterThanOrEqual(20);
    expect(prompt.split(/\s+/).length).toBeGreaterThanOrEqual(4);
    expect(prompt).not.toMatch(/^(?:todo|tbd|prompt|task|review|implement)$/i);
}

function concretePiModelAssignments(section: string): string[] {
    const assignmentPattern =
        /^\s*(?:(?:export|readonly|typeset)(?:\s+-[A-Za-z]+)*\s+)?(?:PI_MODEL\s*=\s*(.*?)|(["'])PI_MODEL\s*=\s*(.*?)\2)\s*$/gm;
    const providerRoute = /\b[A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+\b/;
    const parameterFallback = /\$\{[^}:]+:-([^}]*)\}/g;
    const concrete: string[] = [];

    for (const assignment of section.matchAll(assignmentPattern)) {
        const rhs = assignment[1] ?? assignment[3] ?? "";
        const singleQuoted = assignment[2] === "'" || /^'[^']*'$/.test(rhs);
        const hasExpansion =
            !singleQuoted &&
            /\$(?:\{[^}]+\}|[A-Za-z_0-9][A-Za-z0-9_]*)/.test(rhs);
        const literal = rhs.replace(/^(['"])(.*)\1$/, "$2");
        const hasProviderRoute = providerRoute.test(rhs);
        const hasLiteralFallback = [...rhs.matchAll(parameterFallback)].some(
            (match) =>
                match[1]
                    .replace(/\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)/g, "")
                    .match(/[A-Za-z0-9]/) !== null,
        );
        if (
            literal.length > 0 &&
            (!hasExpansion || hasProviderRoute || hasLiteralFallback)
        ) {
            concrete.push(assignment[0].trim());
        }
    }

    return concrete;
}

function positiveProviderDefaultLines(section: string): string[] {
    const providerRoute = /\b[A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+\b/;
    return section
        .split(/\r?\n/)
        .filter(
            (line) =>
                /\bdefault\b/i.test(line) &&
                providerRoute.test(line) &&
                !/\b(?:never|do not|must not)\b/i.test(line),
        );
}

describe("delegate skill command parser", () => {
    it("classifies direct zsh commands and rejects wrapped or invalid Pi commands", () => {
        const direct = piInvocations(
            '#### Focused implementation delegation\n\n```zsh\npi --print --no-session --model "$PI_MODEL" --thinking "$PI_THINKING" "Review safely"\n```',
        );
        expect(direct).toHaveLength(1);
        expect(direct[0].kind).toBe("task");
        expect(taskRole(direct[0])).toBe("implementation");

        const proseOnly = piInvocations(
            'Focused implementation delegation:\n```zsh\npi --print --no-session --model "$PI_MODEL" --thinking "$PI_THINKING" "Review safely"\n```',
        );
        expect(taskRole(proseOnly[0])).toBeNull();

        const wrappedCommands = [
            'env MODE=review pi --print --no-session "Review"',
            '/opt/homebrew/bin/pi --print --no-session "Review"',
            "sh -c 'pi --print --no-session \"Review\"'",
            "sh -c '/opt/homebrew/bin/pi --print --no-session \"Review\"'",
            "sh -c '$PI_BIN --print --no-session \"Review\"'",
            "nohup sh -c 'pi --print --no-session \"Review\"'",
            'sudo -u root pi --print --no-session "Review"',
            'xargs pi --print --no-session "Review"',
            'eval "pi --print --no-session Review"',
            '$PI_BIN --print --no-session "Review"',
        ];
        for (const command of wrappedCommands) {
            expect(() =>
                piInvocations(`\`\`\`zsh\n${command}\n\`\`\``),
            ).toThrow("Wrapped or compound Pi invocation");
        }

        expect(piInvocations("```zsh\nprintf '%s' pi\n```")).toEqual([]);
        expect(piInvocations("```zsh\nenv printf '%s' pi\n```")).toEqual([]);
        expect(piInvocations("```zsh\nxargs printf '%s' pi\n```")).toEqual([]);
        expect(piInvocations("```zsh\nsh -c 'printf \"%s\" pi'\n```")).toEqual(
            [],
        );
        expect(piInvocations("```zsh\neval 'printf \"%s\" pi'\n```")).toEqual(
            [],
        );

        const compoundCommands = [
            'pi --print --no-session "Review"; echo done',
            'pi --print --no-session "Review" | tee review.log',
            'pi --print --no-session "Review" > review.log',
            'pi --print --no-session "Review" &',
        ];
        for (const command of compoundCommands) {
            expect(() =>
                piInvocations(`\`\`\`zsh\n${command}\n\`\`\``),
            ).toThrow("Unquoted shell operator");
        }

        expect(() =>
            piInvocations(
                '```zsh\npi -p --no-session --model "$PI_MODEL" --thinking "$PI_THINKING" "Review"\n```',
            ),
        ).toThrow("Unclassified Pi invocation");
        expect(() =>
            piInvocations('```zsh\npi --printer "Review"\n```'),
        ).toThrow("Unclassified Pi invocation");
    });

    it("detects duplicate, overriding, and expanded task options", () => {
        const expected = new Map<string, string | null>([
            ["--model", "$PI_MODEL"],
            ["--no-extensions", null],
            ["--no-session", null],
            ["--thinking", "$PI_THINKING"],
            ["--tools", "read,grep,find,ls"],
        ]);
        const unsafe = piInvocations(
            '```zsh\npi --print --no-session --model "$PI_MODEL" --model provider/model --thinking "$PI_THINKING" --no-extensions --tools read,grep,find,ls,bash "Review"\n```',
        )[0];
        expect(() => expectExactOptions(unsafe, 2, expected, 1)).toThrow();

        const unexpectedAliases = [
            "-a",
            "-na",
            "-nc",
            "-c",
            "-r",
            "-ne",
            "-t read,grep,find,ls",
        ];
        for (const alias of unexpectedAliases) {
            const command =
                'pi --print --no-session --model "$PI_MODEL" ' +
                '--thinking "$PI_THINKING" --no-extensions ' +
                "--tools read,grep,find,ls " +
                alias +
                ' "Review this code safely and report findings"';
            const invocation = piInvocations(
                `\`\`\`zsh\n${command}\n\`\`\``,
            )[0];
            expect(() =>
                expectExactOptions(invocation, 2, expected, 1),
            ).toThrow();
        }
    });

    it("detects concrete PI_MODEL assignments in supported shell forms", () => {
        const concrete = [
            'PI_MODEL="provider/model"',
            '  export PI_MODEL="provider/model"',
            "readonly PI_MODEL='provider/model'",
            'typeset -gx PI_MODEL="provider/model"',
            'export -x PI_MODEL="provider/model"',
            "typeset -gx 'PI_MODEL=provider/model'",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: This fixture intentionally contains literal shell expansion syntax.
            "PI_MODEL='${PI_PROVIDER}/model'",
        ].join("\n");
        expect(concretePiModelAssignments(concrete)).toHaveLength(7);

        // biome-ignore lint/suspicious/noTemplateCurlyInString: This fixture intentionally contains literal shell expansion syntax.
        const derived = 'PI_MODEL="${PI_PROVIDER}/${PI_PROVIDER_MODEL}"';
        expect(concretePiModelAssignments(derived)).toEqual([]);

        // biome-ignore lint/suspicious/noTemplateCurlyInString: This fixture intentionally contains literal shell expansion syntax.
        const providerFallback = 'PI_MODEL="${PI_MODEL:-openai/gpt-5.4}"';
        expect(concretePiModelAssignments(providerFallback)).toEqual([
            providerFallback,
        ]);

        const splitFallback = `PI_MODEL="\${PI_MODEL:-openai}/\${MODEL_ID:-gpt-5.4}"`;
        expect(concretePiModelAssignments(splitFallback)).toEqual([
            splitFallback,
        ]);
    });

    it("detects positive provider-specific default statements", () => {
        expect(
            positiveProviderDefaultLines(
                "Use provider/model-id as the default for delegated tasks.",
            ),
        ).toHaveLength(1);
        expect(
            positiveProviderDefaultLines(
                "Never use provider/model-id as the default for delegated tasks.",
            ),
        ).toEqual([]);
    });
});

function piInvocations(section: string): PiInvocation[] {
    const result: PiInvocation[] = [];
    const isAssignment = (token: string): boolean =>
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
    const isPiExecutable = (token: string): boolean =>
        token === "pi" ||
        /(?:^|\/)pi$/.test(token) ||
        /^\$\{?PI(?:_[A-Z0-9_]*)?\}?$/.test(token);

    const findPiCommand = (tokens: string[], startIndex = 0): number => {
        let index = startIndex;
        while (isAssignment(tokens[index] ?? "")) index += 1;

        const executable = tokens[index];
        if (executable === undefined) return -1;
        if (isPiExecutable(executable)) return index;

        if (["bash", "sh", "zsh"].includes(executable)) {
            const commandIndex = tokens.indexOf("-c", index + 1);
            const command =
                commandIndex === -1 ? undefined : tokens[commandIndex + 1];
            if (command === undefined) return -1;
            return findPiCommand(shellTokens(command)) === -1
                ? -1
                : commandIndex + 1;
        }

        if (executable === "eval") {
            const command = tokens.slice(index + 1).join(" ");
            return findPiCommand(shellTokens(command)) === -1 ? -1 : index + 1;
        }

        if (["command", "nohup", "time"].includes(executable)) {
            let next = index + 1;
            while ((tokens[next] ?? "").startsWith("-")) next += 1;
            return findPiCommand(tokens, next);
        }

        if (executable === "env") {
            let next = index + 1;
            while (
                (tokens[next] ?? "").startsWith("-") ||
                isAssignment(tokens[next] ?? "")
            ) {
                next += 1;
            }
            return findPiCommand(tokens, next);
        }

        if (executable === "nice") {
            let next = index + 1;
            if (tokens[next] === "-n") next += 2;
            return findPiCommand(tokens, next);
        }

        if (executable === "xargs") {
            const valueOptions = new Set([
                "--arg-file",
                "--delimiter",
                "--eof",
                "--max-args",
                "--max-chars",
                "--max-lines",
                "--max-procs",
                "--replace",
                "-E",
                "-I",
                "-L",
                "-P",
                "-a",
                "-d",
                "-n",
                "-s",
            ]);
            let next = index + 1;
            while ((tokens[next] ?? "").startsWith("-")) {
                const option = tokens[next];
                next += valueOptions.has(option) ? 2 : 1;
            }
            return findPiCommand(tokens, next);
        }

        if (executable === "sudo") {
            const valueOptions = new Set([
                "--chdir",
                "--close-from",
                "--command-timeout",
                "--group",
                "--host",
                "--prompt",
                "--role",
                "--type",
                "--user",
                "-C",
                "-D",
                "-R",
                "-T",
                "-g",
                "-h",
                "-p",
                "-r",
                "-t",
                "-u",
            ]);
            let next = index + 1;
            while ((tokens[next] ?? "").startsWith("-")) {
                const option = tokens[next];
                next += valueOptions.has(option) ? 2 : 1;
            }
            return findPiCommand(tokens, next);
        }

        return -1;
    };

    for (const block of shellBlocks(section)) {
        const tokens = shellTokens(block.invocation);
        const piIndex = findPiCommand(tokens);
        if (piIndex === -1) continue;

        if (piIndex !== 0 || tokens[0] !== "pi") {
            throw new Error(
                `Wrapped or compound Pi invocation is not allowed: ${block.invocation}`,
            );
        }

        let kind: PiKind;
        if (tokens[1] === "--print") {
            kind = "task";
        } else if (tokens[1] === "--list-models") {
            kind = "discovery";
        } else if (tokens[1] === "auth" && tokens[2] === "check") {
            kind = "readiness";
        } else {
            throw new Error(`Unclassified Pi invocation: ${block.invocation}`);
        }

        result.push({
            command: block.invocation,
            heading: block.heading,
            kind,
            tokens,
        });
    }

    return result;
}

const piSection = extractPiSection(skill);
const tasks = piInvocations(piSection).filter((p) => p.kind === "task");
const meta = frontmatter(skill);

describe("delegate skill metadata", () => {
    it("keeps the delegate frontmatter name and Pi in the description", () => {
        expect(meta.name).toBe("delegate");
        expect(meta.description).toContain("Pi Coding Agent");
    });

    it("contains the Pi section exactly once", () => {
        expect(piSection.length).toBeGreaterThan(0);
        expect(skill.indexOf("### Pi Coding Agent")).toBe(
            skill.lastIndexOf("### Pi Coding Agent"),
        );
    });

    it("documents live catalog discovery", () => {
        expect(piSection).toContain("pi --list-models");
    });

    it("does not publish a provider-specific model as its default", () => {
        expect(concretePiModelAssignments(piSection)).toEqual([]);
        expect(positiveProviderDefaultLines(piSection)).toEqual([]);
    });
});

describe("delegate skill model and thinking contract", () => {
    it("frames explicit selection as delegate policy, not a Pi CLI requirement", () => {
        expect(piSection).toContain("delegate workflow policy");
        expect(piSection).not.toContain("requires explicit model and thinking");
    });

    it("keeps the PI_MODEL presence guard in the examples", () => {
        expect(piSection).toContain(
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax asserted as text
            ': "${PI_MODEL:?Set PI_MODEL to an exact provider-qualified model from pi --list-models}"',
        );
    });

    it("uses an explicit PI_THINKING precedence expression", () => {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax asserted as text
        expect(piSection).toContain('PI_THINKING="${PI_THINKING:-high}"');
    });

    it("contains implementation and restricted-review tasks with exact flags", () => {
        const implementation = tasks.filter(
            (task) => taskRole(task) === "implementation",
        );
        const reviews = tasks.filter((task) => taskRole(task) === "review");
        const unclassified = tasks.filter((task) => taskRole(task) === null);

        expect(tasks).toHaveLength(2);
        expect(implementation).toHaveLength(1);
        expect(reviews).toHaveLength(1);
        expect(unclassified).toEqual([]);

        for (const task of tasks) {
            expect(task.tokens.slice(0, 2)).toEqual(["pi", "--print"]);

            const expected = new Map<string, string | null>([
                ["--model", "$PI_MODEL"],
                ["--no-session", null],
                ["--thinking", "$PI_THINKING"],
            ]);
            if (taskRole(task) === "review") {
                expected.set("--no-extensions", null);
                expected.set("--tools", "read,grep,find,ls");
            }

            const parsed = expectExactOptions(task, 2, expected, 1);
            expectMeaningfulPrompt(parsed);
        }
    });

    it("documents the separately supplied provider normalization rule", () => {
        expect(piSection).toContain(
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax asserted as text
            'PI_MODEL="${PI_PROVIDER}/${PI_PROVIDER_MODEL}"',
        );
        expect(piSection).toContain("provider/model-id");
    });

    it("documents user-requested thinking precedence", () => {
        expect(piSection).toContain(
            "Use the exact thinking level requested by the user",
        );
    });

    it("gives exact user input precedence over established environment state", () => {
        const exactIdx = piSection.indexOf(
            "If the user supplied an exact provider-qualified Pi model, use it unchanged",
        );
        const envIdx = piSection.indexOf(
            "If the user or project already established `PI_MODEL`, use that exact value",
        );
        expect(exactIdx).toBeGreaterThanOrEqual(0);
        expect(envIdx).toBeGreaterThan(exactIdx);
    });

    it("requires live discovery and a user choice when no exact model is established", () => {
        expect(piSection).toContain(
            "run `pi --list-models`, present the relevant live candidates, and ask the user to choose",
        );
    });

    it("prohibits default inference, first fuzzy result, and failure-driven switches", () => {
        expect(piSection).toContain(
            "Never infer a model from Pi's configured default",
        );
        expect(piSection).toContain(
            "Never silently select the first fuzzy-search result",
        );
        expect(piSection).toContain(
            "Never silently switch models after a failure",
        );
    });

    it("states the guard checks presence only and rejects slash counting", () => {
        expect(piSection).toContain("checks presence only");
        expect(piSection).toContain("never by counting slashes");
    });

    it("requires thinking support checks and forbids silent downgrade", () => {
        expect(piSection).toContain("reports thinking support");
        expect(piSection).toContain("report the mismatch and ask the user");
        expect(piSection).toContain(
            "Never silently downgrade a requested thinking level",
        );
    });

    it("permits persistent sessions only on explicit user request", () => {
        expect(piSection).toContain(
            "Use a persistent session only when the user explicitly requests resumable work",
        );
    });
});

describe("delegate skill review safety contract", () => {
    it("keeps the exact restricted review allowlist", () => {
        const reviews = tasks.filter((task) => taskRole(task) === "review");
        expect(reviews).toHaveLength(1);

        const parsed = parseCommandOptions(reviews[0].tokens, 2);
        expect(parsed.options.get("--no-extensions")).toEqual([null]);
        expect(parsed.options.get("--tools")).toEqual(["read,grep,find,ls"]);
    });

    it("states the sandbox limitation and worktree inspection", () => {
        expect(piSection).toContain("not an operating-system sandbox");
        expect(piSection).toContain("external sandbox or container");
        expect(piSection).toContain("Inspect the worktree after any Pi run");
    });
});

describe("delegate skill trust and credential contract", () => {
    it("keeps trust overrides and context disabling out of task commands", () => {
        for (const task of tasks) {
            const options = parseCommandOptions(task.tokens, 2).options;
            expect(options.has("--approve")).toBe(false);
            expect(options.has("--no-approve")).toBe(false);
            expect(options.has("--no-context-files")).toBe(false);
        }
    });

    it("documents both trust flags and the non-interactive fallback", () => {
        expect(piSection).toContain("`--approve`");
        expect(piSection).toContain("`--no-approve`");
        expect(piSection).toContain("do not display a project-trust prompt");
        expect(piSection).toContain(
            "saved trust decision or the configured non-interactive fallback",
        );
    });

    it("keeps context files enabled with named instruction files", () => {
        expect(piSection).toContain("AGENTS.md");
        expect(piSection).toContain("CLAUDE.md");
    });

    it("documents the exact safe readiness command", () => {
        const readiness = piInvocations(piSection).filter(
            (invocation) => invocation.kind === "readiness",
        );
        expect(readiness).toHaveLength(1);
        expect(readiness[0].tokens.slice(0, 3)).toEqual([
            "pi",
            "auth",
            "check",
        ]);
        expectExactOptions(
            readiness[0],
            3,
            new Map<string, string | null>([
                ["--json", null],
                ["--model", "$PI_MODEL"],
                ["--no-refresh", null],
            ]),
            0,
        );
    });

    it("prohibits credential-emitting operations", () => {
        expect(piSection).toContain("--credentials");
        expect(piSection).toContain("print-api-key");
        expect(piSection).toContain("print-bearer-token");
        expect(piSection).toContain("Never run credential-emitting operations");
        for (const block of shellBlocks(piSection)) {
            expect(block.invocation).not.toContain("print-api-key");
            expect(block.invocation).not.toContain("print-bearer-token");
            expect(block.invocation).not.toContain("--credentials");
        }
    });
});

describe("delegate skill failure contract", () => {
    it("requires exit code capture and safe output preservation", () => {
        expect(piSection).toContain("capture the process exit code");
        expect(piSection).toContain("preserve relevant stdout and stderr");
    });

    it("requires exact failure context", () => {
        expect(piSection).toContain("the exact harness");
        expect(piSection).toContain("the exact model");
        expect(piSection).toContain("the exact thinking level");
        expect(piSection).toContain("the working directory");
        expect(piSection).toContain("the failed task stage");
        expect(piSection).toContain("safely redacted equivalent");
    });

    it("requires stopping and authorization before any retry or substitution", () => {
        expect(piSection).toContain("Then stop.");
        expect(piSection).toContain(
            "Do not retry the same command automatically",
        );
        expect(piSection).toContain(
            "Do not retry with another model automatically",
        );
        expect(piSection).toContain(
            "Do not switch to another harness automatically",
        );
        expect(piSection).toContain(
            "Retry or substitute only after explicit user authorization",
        );
    });
});

describe("delegate skill platform contract", () => {
    it("states POSIX shell scope without claiming PowerShell compatibility", () => {
        expect(piSection).toContain("POSIX shell syntax");
        expect(piSection).toContain("variable guards and line continuations");
        expect(piSection).toContain(
            "do not claim native PowerShell compatibility",
        );
    });
});
