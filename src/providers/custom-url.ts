import { resolve4, resolve6 } from "node:dns/promises";

const DEFAULT_CUSTOM_API_URL = "http://localhost:11434/v1";

export const customProviderBaseUrl = async (
    customUrl: string | undefined,
    allowInsecure: boolean,
): Promise<string> => {
    if (typeof customUrl !== "string" || !customUrl) {
        return DEFAULT_CUSTOM_API_URL;
    }

    return validateCustomApiUrl(customUrl, allowInsecure);
};

const validateCustomApiUrl = async (
    rawUrl: string,
    allowInsecure: boolean,
): Promise<string> => {
    let url: URL;

    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error("custom_url must be a valid URL");
    }

    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("custom_url must use http:// or https://");
    }

    if (url.username || url.password) {
        throw new Error("custom_url must not contain credentials");
    }

    if (url.hash) {
        throw new Error("custom_url must not contain a fragment");
    }

    if (
        url.protocol === "http:" &&
        !allowInsecure &&
        !isLoopbackHost(url.hostname)
    ) {
        throw new Error(
            "custom_url must use https:// unless allow_insecure_custom is set to true",
        );
    }

    if (await isBlockedHost(url.hostname)) {
        throw new Error("custom_url host is not allowed");
    }

    return url.toString();
};

const isBlockedHost = async (hostname: string): Promise<boolean> => {
    const normalized = normalizeHostname(hostname);

    if (normalized === "localhost") {
        return false;
    }

    if (normalized.endsWith(".localhost")) {
        return true;
    }

    const mappedIpv4 = parseIpv4MappedIpv6(normalized);
    if (mappedIpv4) {
        return isBlockedIpv4(mappedIpv4);
    }

    const ipv4 = parseIpv4(normalized);
    if (ipv4) {
        return isBlockedIpv4(ipv4);
    }

    const ipv6Blocked = isBlockedIpv6(normalized);
    if (ipv6Blocked) {
        return true;
    }

    // DNS resolution for hostnames that pass syntactic checks.
    // Prevents SSRF bypass via domains resolving to private IPs.
    try {
        const [v4, v6] = await Promise.all([
            resolve4(normalized).catch(() => [] as string[]),
            resolve6(normalized).catch(() => [] as string[]),
        ]);
        const addresses = [...v4, ...v6];
        if (addresses.length === 0) {
            return true;
        }
        for (const address of addresses) {
            const dnsMappedIpv4 = parseIpv4MappedIpv6(address);
            if (dnsMappedIpv4 && isBlockedIpv4(dnsMappedIpv4)) return true;
            const dnsIpv4 = parseIpv4(address);
            if (dnsIpv4 && isBlockedIpv4(dnsIpv4)) return true;
            if (isBlockedIpv6(address)) return true;
        }
        return false;
    } catch {
        // DNS resolution failed -- block for safety.
        return true;
    }
};

const isLoopbackHost = (hostname: string): boolean => {
    const normalized = normalizeHostname(hostname);
    const mappedIpv4 = parseIpv4MappedIpv6(normalized);

    return (
        normalized === "localhost" ||
        normalized === "127.0.0.1" ||
        normalized === "::1" ||
        Boolean(mappedIpv4 && isExactLoopbackIpv4(mappedIpv4))
    );
};

const normalizeHostname = (hostname: string): string => {
    return hostname
        .toLowerCase()
        .replace(/^\[(.*)\]$/u, "$1")
        .replace(/\.$/u, "");
};

const parseIpv4 = (
    hostname: string,
): [number, number, number, number] | undefined => {
    const parts = hostname.split(".");
    if (parts.length !== 4) return undefined;

    const octets = parts.map((part) => {
        if (!/^\d{1,3}$/u.test(part)) return undefined;
        const value = Number(part);
        return value >= 0 && value <= 255 ? value : undefined;
    });

    if (octets.some((octet) => octet === undefined)) return undefined;
    return octets as [number, number, number, number];
};

const parseIpv4MappedIpv6 = (
    hostname: string,
): [number, number, number, number] | undefined => {
    const lowered = hostname.toLowerCase();
    const prefixIdx = lowered.startsWith("::ffff:")
        ? "::ffff:".length
        : lowered.startsWith("0:0:0:0:0:ffff:")
          ? "0:0:0:0:0:ffff:".length
          : -1;
    if (prefixIdx === -1) return undefined;

    const suffix = lowered.slice(prefixIdx);
    const dotted = parseIpv4(suffix);
    if (dotted) return dotted;

    const parts = suffix.split(":");
    if (parts.length !== 2) return undefined;

    const words = parts.map((part) => {
        if (!/^[0-9a-f]{1,4}$/u.test(part)) return undefined;
        return Number.parseInt(part, 16);
    });

    if (words.some((word) => word === undefined)) return undefined;
    const [high, low] = words as [number, number];
    return [high >> 8, high & 0xff, low >> 8, low & 0xff];
};

const isExactLoopbackIpv4 = ([a, b, c, d]: [
    number,
    number,
    number,
    number,
]): boolean => a === 127 && b === 0 && c === 0 && d === 1;

const isBlockedIpv4 = ([a, b, c, d]: [
    number,
    number,
    number,
    number,
]): boolean => {
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;

    return a === 127 && !isExactLoopbackIpv4([a, b, c, d]);
};

const isBlockedIpv6 = (hostname: string): boolean => {
    if (hostname === "::1") return false;

    const normalized = hostname.toLowerCase();
    const parts = normalized.split(":");
    const firstHex = parts[0];
    if (firstHex === "" || !/^[0-9a-f]{1,4}$/u.test(firstHex)) return false;

    const value = Number.parseInt(firstHex, 16);

    // Unique-local: fc00::/7 (fc00-fdff)
    if ((value & 0xfe00) === 0xfc00) return true;
    // Link-local: fe80::/10 (fe80-febf)
    if ((value & 0xffc0) === 0xfe80) return true;
    // Site-local (deprecated): fec0::/10 (fec0-feff)
    if ((value & 0xffc0) === 0xfec0) return true;
    // 6to4: 2002::/16
    if (value === 0x2002) return true;
    // Teredo: 2001:0000::/32
    if (value === 0x2001 && parts[1] === "0") return true;
    // RFC 6052: 64:ff9b::/96
    if (parts[0] === "64" && parts[1] === "ff9b") return true;

    return false;
};

// === Connection-time hostname resolution and safe fetch transport ===
//
// Exported utilities for the custom provider factory to validate every
// DNS answer and every redirect hop at connection time.

export type DnsResolveFn = (
    hostname: string,
    options?: { signal?: AbortSignal },
) => Promise<string[]>;

export const defaultDnsResolve = async (
    hostname: string,
    options?: { signal?: AbortSignal },
): Promise<string[]> => {
    const signal = options?.signal;
    const [v4, v6] = await Promise.all([
        resolve4(hostname).catch(() => [] as string[]),
        resolve6(hostname).catch(() => [] as string[]),
    ]);
    if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
    }
    return [...v4, ...v6];
};

export const resolveAndValidateHostname = async (
    hostname: string,
    dnsResolve: DnsResolveFn,
    signal?: AbortSignal,
): Promise<string[]> => {
    const normalized = normalizeHostname(hostname);

    if (normalized === "localhost" || normalized === "::1") {
        return [hostname];
    }

    const mappedIpv4 = parseIpv4MappedIpv6(normalized);
    if (mappedIpv4) {
        if (isBlockedIpv4(mappedIpv4)) {
            throw new Error("custom_url host is not allowed");
        }
        return [hostname];
    }

    const ipv4 = parseIpv4(normalized);
    if (ipv4) {
        if (isBlockedIpv4(ipv4)) {
            throw new Error("custom_url host is not allowed");
        }
        return [hostname];
    }

    if (isBlockedIpv6(normalized)) {
        throw new Error("custom_url host is not allowed");
    }

    // DNS resolution for symbolic hostnames
    const addresses = await dnsResolve(normalized, { signal });
    if (addresses.length === 0) {
        throw new Error("custom_url host is not allowed");
    }

    for (const addr of addresses) {
        const aMapped = parseIpv4MappedIpv6(addr);
        if (aMapped && isBlockedIpv4(aMapped)) {
            throw new Error("custom_url host is not allowed");
        }
        const aIpv4 = parseIpv4(addr);
        if (aIpv4 && isBlockedIpv4(aIpv4)) {
            throw new Error("custom_url host is not allowed");
        }
        if (isBlockedIpv6(addr)) {
            throw new Error("custom_url host is not allowed");
        }
    }

    return addresses;
};

type CustomFetch = typeof fetch;

export const createSafeCustomFetch = (
    dnsResolve: DnsResolveFn,
): CustomFetch => {
    const safeFetch = async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
        const requestUrl =
            typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url;
        const url = new URL(requestUrl);
        const signal = init?.signal ?? undefined;

        await resolveAndValidateHostname(url.hostname, dnsResolve, signal);

        const response = await fetch(input, {
            ...init,
            redirect: "manual",
        });

        if (
            (response.status >= 300 && response.status < 400) ||
            response.redirected
        ) {
            throw new Error("custom_url redirects are not allowed");
        }

        return response;
    };

    // ponytail: DNS-rebind TOCTOU remains between validation and connection.
    // Bun/Node fetch re-resolves DNS internally. Full pinning requires a
    // custom TCP connector; upgrade if SSRF threat model demands it.
    return safeFetch as unknown as CustomFetch;
};
