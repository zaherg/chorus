export interface CliOptionSpec<TBool extends string, TScalar extends string = never, TRepeat extends string = never> {
    booleans: readonly TBool[];
    shortAliases?: Readonly<Record<string, TBool>>;
    scalars?: readonly TScalar[];
    repeatables?: readonly TRepeat[];
}

export type CliOptionParseError =
    | { ok: false; kind: "separator"; token: "--" }
    | { ok: false; kind: "unknown_option"; option: string; token: string }
    | { ok: false; kind: "invalid_boolean_value"; option: string; token: string }
    | { ok: false; kind: "negated_boolean_value"; option: string; token: string };

export interface CliOptionParseSuccess<TBool extends string, TScalar extends string, TRepeat extends string> {
    ok: true;
    booleans: Record<TBool, boolean>;
    scalars: Record<TScalar, string[]>;
    repeatables: Record<TRepeat, string[]>;
    valueOptionOrder: (TScalar | TRepeat)[];
    positionals: string[];
}

export type CliOptionParseResult<TBool extends string, TScalar extends string, TRepeat extends string> =
    | CliOptionParseSuccess<TBool, TScalar, TRepeat>
    | CliOptionParseError;

/**
 * Single-pass strict CLI option parser.
 *
 * - Long boolean options accept `--flag`, `--flag=true`, `--flag=false`, and `--no-flag` (last wins).
 * - Short aliases (such as `-h`) only match single-dash exact forms, never `--h` or `--no-h`.
 * - Value options (scalar and repeatable) accept `--opt value` (when `value` does not start with `-`)
 *   and `--opt=value` (which allows hyphen-prefixed values).
 * - Negated value options (`--no-<value-opt>`) and undeclared flags are rejected as `unknown_option`.
 * - A `--` separator token is rejected immediately as `separator`.
 */
export const parseCliOptions = <TBool extends string, TScalar extends string = never, TRepeat extends string = never>(
    args: readonly string[],
    spec: CliOptionSpec<TBool, TScalar, TRepeat>,
): CliOptionParseResult<TBool, TScalar, TRepeat> => {
    const boolSet = new Set<string>(spec.booleans);
    const scalarSet = new Set<string>(spec.scalars ?? []);
    const repeatSet = new Set<string>(spec.repeatables ?? []);
    const shortAliases = spec.shortAliases ?? {};

    const booleans = Object.create(null) as Record<TBool, boolean>;
    for (const name of spec.booleans) {
        booleans[name] = false;
    }

    const scalars = Object.create(null) as Record<TScalar, string[]>;
    for (const name of spec.scalars ?? []) {
        scalars[name] = [];
    }

    const repeatables = Object.create(null) as Record<TRepeat, string[]>;
    for (const name of spec.repeatables ?? []) {
        repeatables[name] = [];
    }

    const valueOptionOrder: (TScalar | TRepeat)[] = [];
    const positionals: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const token = args[i];

        if (token === "--") {
            return { ok: false, kind: "separator", token: "--" };
        }

        if (token.startsWith("--")) {
            const rawBody = token.slice(2);
            const equalsIndex = rawBody.indexOf("=");
            const rawName = equalsIndex === -1 ? rawBody : rawBody.slice(0, equalsIndex);
            const hasEquals = equalsIndex !== -1;
            const assignedValue = hasEquals ? rawBody.slice(equalsIndex + 1) : undefined;

            if (rawName.startsWith("no-")) {
                const targetName = rawName.slice(3);
                if (boolSet.has(targetName)) {
                    if (hasEquals) {
                        return {
                            ok: false,
                            kind: "negated_boolean_value",
                            option: `--${rawName}`,
                            token,
                        };
                    }
                    booleans[targetName as TBool] = false;
                    continue;
                }
                return { ok: false, kind: "unknown_option", option: `--${rawName}`, token };
            }

            if (boolSet.has(rawName)) {
                if (!hasEquals) {
                    booleans[rawName as TBool] = true;
                    continue;
                }
                if (assignedValue === "true" || assignedValue === "false") {
                    booleans[rawName as TBool] = assignedValue === "true";
                    continue;
                }
                return { ok: false, kind: "invalid_boolean_value", option: `--${rawName}`, token };
            }

            if (scalarSet.has(rawName) || repeatSet.has(rawName)) {
                let value: string;
                if (hasEquals) {
                    value = assignedValue ?? "";
                } else {
                    const next = args[i + 1];
                    if (next === undefined || (next.startsWith("-") && next.length > 1)) {
                        value = "";
                    } else {
                        value = next;
                        i++;
                    }
                }

                if (scalarSet.has(rawName)) {
                    const name = rawName as TScalar;
                    scalars[name].push(value);
                    valueOptionOrder.push(name);
                } else {
                    const name = rawName as TRepeat;
                    repeatables[name].push(value);
                    valueOptionOrder.push(name);
                }
                continue;
            }

            return { ok: false, kind: "unknown_option", option: `--${rawName}`, token };
        }

        if (token.startsWith("-") && token.length > 1) {
            const shortName = token.slice(1);
            const mapped = Object.hasOwn(shortAliases, shortName) ? shortAliases[shortName] : undefined;
            if (mapped !== undefined) {
                booleans[mapped] = true;
                continue;
            }
            return { ok: false, kind: "unknown_option", option: token, token };
        }

        positionals.push(token);
    }

    return {
        ok: true,
        booleans,
        scalars,
        repeatables,
        valueOptionOrder,
        positionals,
    };
};
