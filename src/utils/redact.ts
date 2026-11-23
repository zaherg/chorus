const MIN_REGISTERED_SECRET_LENGTH = 8;

const SECRET_REDACTION_PATTERNS: Array<{
    pattern: RegExp;
    replacement: string;
}> = [
    {
        pattern: /\bsk-ant-[a-zA-Z0-9_-]{20,}(?![a-zA-Z0-9_-])/gi,
        replacement: "sk-ant-[REDACTED]",
    },
    {
        pattern: /\bsk-or-v1-[a-zA-Z0-9_-]{20,}(?![a-zA-Z0-9_-])/gi,
        replacement: "sk-or-v1-[REDACTED]",
    },
    {
        pattern: /\b(sk|pk)-[a-zA-Z0-9_-]{16,}(?![a-zA-Z0-9_-])/gi,
        replacement: "$1-[REDACTED]",
    },
    {
        pattern: /\b(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}(?![a-zA-Z0-9])/gi,
        replacement: "$1_[REDACTED]",
    },
    {
        pattern: /\b(xox[abpsr]?)-[a-zA-Z0-9-]{20,}(?![a-zA-Z0-9-])/gi,
        replacement: "$1-[REDACTED]",
    },
    {
        pattern: /\bBearer\s+[a-zA-Z0-9._+/=-]{20,}/gi,
        replacement: "Bearer [REDACTED]",
    },
    {
        pattern: /(Authorization\s*[:=]\s*Basic\s+)[A-Za-z0-9+/=]{8,}/gi,
        replacement: "$1[REDACTED]",
    },
    {
        pattern: /\bBasic\s+(?=[A-Za-z0-9+/=]{16,}(?![A-Za-z0-9+/=]))(?=[A-Za-z0-9+/=]*[0-9+/=])[A-Za-z0-9+/=]+/g,
        replacement: "Basic [REDACTED]",
    },
    { pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, replacement: "[REDACTED]" },
    { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: "[REDACTED]" },
    { pattern: /\bABSK[a-zA-Z0-9+/=_-]{16,}(?![a-zA-Z0-9+/=_-])/g, replacement: "ABSK[REDACTED]" },
    { pattern: /\bgsk_[a-zA-Z0-9]{20,}(?![a-zA-Z0-9])/g, replacement: "[REDACTED]" },
    { pattern: /\bhf_[a-zA-Z]{20,}(?![a-zA-Z])/g, replacement: "[REDACTED]" },
    {
        pattern: /(x-api-key|api-key)(\s*[:=]\s*)(?:[^\s"',;}\]]*\[REDACTED\]|[^\s"',;}\]]+)/gi,
        replacement: "$1$2[REDACTED]",
    },
    {
        pattern: /([?&](?:api[_-]?key|key|token|access_token)=)([^&\s"'#]+)/gi,
        replacement: "$1[REDACTED]",
    },
];

const registeredSecrets = new Set<string>();
let sortedRegisteredSecrets: string[] = [];

export const registerRedactedSecrets = (values: Iterable<string | undefined>): void => {
    let changed = false;
    for (const raw of values) {
        if (typeof raw !== "string") continue;
        const secret = raw.trim();
        if (secret.length < MIN_REGISTERED_SECRET_LENGTH) continue;
        if (!registeredSecrets.has(secret)) {
            registeredSecrets.add(secret);
            changed = true;
        }
    }
    if (changed) {
        sortedRegisteredSecrets = [...registeredSecrets].sort((a, b) => b.length - a.length);
    }
};

export const clearRedactedSecrets = (): void => {
    registeredSecrets.clear();
    sortedRegisteredSecrets = [];
};

export const redactSecrets = (text: string): string => {
    let out = text;
    for (const { pattern, replacement } of SECRET_REDACTION_PATTERNS) {
        out = out.replace(pattern, replacement);
    }
    for (const secret of sortedRegisteredSecrets) {
        out = out.replaceAll(secret, "[REDACTED]");
    }
    return out;
};
