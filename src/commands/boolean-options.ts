import type { BooleanTokenValidation } from "@/types/boolean-options";

/**
 * Validates the long-form syntax of declared boolean options before minimist
 * collapses assigned values other than the literal "false" to `true`.
 */
export const validateKnownBooleanTokens = (
    rawArgs: readonly string[],
    optionNames: readonly string[],
): BooleanTokenValidation => {
    const knownOptions = new Set(optionNames);

    for (const token of rawArgs) {
        if (token === "--") {
            return { ok: true, separatorPresent: true };
        }
        if (!token.startsWith("--")) {
            continue;
        }

        const optionToken = token.slice(2);
        const negated = optionToken.startsWith("no-");
        const optionAndValue = negated ? optionToken.slice(3) : optionToken;
        const equalsIndex = optionAndValue.indexOf("=");
        const optionName = equalsIndex === -1 ? optionAndValue : optionAndValue.slice(0, equalsIndex);

        if (!knownOptions.has(optionName)) continue;
        if (negated && equalsIndex !== -1) return { ok: false, option: `--no-${optionName}`, token };
        if (equalsIndex === -1) continue;

        const assignedValue = optionAndValue.slice(equalsIndex + 1);
        if (assignedValue !== "true" && assignedValue !== "false") {
            return { ok: false, option: `--${optionName}`, token };
        }
    }

    return { ok: true, separatorPresent: false };
};

/**
 * Finds the first negated long-form token (`--no-<option>`) that targets a
 * declared value-bearing option before `--`, so callers can reject it before
 * minimist silently coerces it to `false`.
 */
export const findNegatedValueOption = (
    rawArgs: readonly string[],
    valueOptionNames: readonly string[],
): string | undefined => {
    const valueOptions = new Set(valueOptionNames);

    for (const token of rawArgs) {
        if (token === "--") {
            return undefined;
        }
        if (!token.startsWith("--no-")) {
            continue;
        }

        const optionAndValue = token.slice(5);
        const equalsIndex = optionAndValue.indexOf("=");
        const optionName = equalsIndex === -1 ? optionAndValue : optionAndValue.slice(0, equalsIndex);
        if (valueOptions.has(optionName)) {
            return `--no-${optionName}`;
        }
    }

    return undefined;
};
