import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";

const DEFAULT_CUSTOM_API_URL = "http://localhost:11434/v1";

interface IpValidationOptions {
    allowLiteralLoopback: boolean;
}

interface PinnedAddress {
    address: string;
    family: 4 | 6;
}

export const customProviderBaseUrl = async (customUrl: string | undefined, allowInsecure: boolean) => {
    if (typeof customUrl !== "string" || !customUrl) {
        return DEFAULT_CUSTOM_API_URL;
    }

    return validateCustomApiUrl(customUrl, allowInsecure);
};

const validateCustomApiUrl = async (rawUrl: string, allowInsecure: boolean) => {
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

    if (url.protocol === "http:" && !allowInsecure && !isLoopbackHost(url.hostname)) {
        throw new Error("custom_url must use https:// unless allow_insecure_custom is set to true");
    }

    if (await isBlockedHost(url.hostname)) {
        throw new Error("custom_url host is not allowed");
    }

    return url.toString();
};

export const normalizeHostname = (hostname: string): string => {
    return hostname
        .toLowerCase()
        .replace(/^\[(.*)\]$/u, "$1")
        .replace(/\.+$/u, "");
};

const ipv4FromOctets = (a: number, b: number, c: number, d: number): number => {
    return (((a & 0xff) << 24) | ((b & 0xff) << 16) | ((c & 0xff) << 8) | (d & 0xff)) >>> 0;
};

const parseIpv4ToUint32 = (input: string): number | undefined => {
    if (isIP(input) !== 4) {
        return undefined;
    }

    const parts = input.split(".");
    if (parts.length !== 4) {
        return undefined;
    }

    let value = 0;
    for (const part of parts) {
        if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) {
            return undefined;
        }
        const octet = Number(part);
        if (octet < 0 || octet > 255) {
            return undefined;
        }
        value = ((value << 8) | octet) >>> 0;
    }

    return value;
};

const parseIpv6ToBigInt = (input: string): bigint | undefined => {
    if (isIP(input) !== 6) {
        return undefined;
    }

    const lower = input.toLowerCase();
    const doubleColonParts = lower.split("::");
    if (doubleColonParts.length > 2) {
        return undefined;
    }

    const expandSide = (side: string, allowEmbeddedIpv4: boolean): number[] | undefined => {
        if (side === "") {
            return [];
        }

        const segments = side.split(":");
        const hextets: number[] = [];

        for (let i = 0; i < segments.length; i += 1) {
            const segment = segments[i] ?? "";
            if (allowEmbeddedIpv4 && i === segments.length - 1 && segment.includes(".")) {
                const ipv4 = parseIpv4ToUint32(segment);
                if (ipv4 === undefined) {
                    return undefined;
                }
                hextets.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
                continue;
            }
            if (!/^[0-9a-f]{1,4}$/u.test(segment)) {
                return undefined;
            }
            hextets.push(Number.parseInt(segment, 16));
        }

        return hextets;
    };

    let words: number[];
    if (doubleColonParts.length === 2) {
        const left = expandSide(doubleColonParts[0] ?? "", false);
        const right = expandSide(doubleColonParts[1] ?? "", true);
        if (!left || !right) {
            return undefined;
        }
        const missing = 8 - (left.length + right.length);
        if (missing < 1) {
            return undefined;
        }
        words = [...left, ...Array<number>(missing).fill(0), ...right];
    } else {
        const full = expandSide(lower, true);
        if (full?.length !== 8) {
            return undefined;
        }
        words = full;
    }

    let value = 0n;
    for (const word of words) {
        value = (value << 16n) | BigInt(word);
    }
    return value;
};

const mustParseIpv6 = (literal: string): bigint => {
    const parsed = parseIpv6ToBigInt(literal);
    if (parsed === undefined) {
        throw new Error(`Invalid static IPv6 CIDR literal: ${literal}`);
    }
    return parsed;
};

const isInIpv4Cidr = (ip: number, network: number, prefixLen: number): boolean => {
    if (prefixLen === 0) {
        return true;
    }
    const mask = (0xffffffff << (32 - prefixLen)) >>> 0;
    return (ip & mask) >>> 0 === (network & mask) >>> 0;
};

const isInIpv6Cidr = (ip: bigint, network: bigint, prefixLen: number): boolean => {
    const shift = BigInt(128 - prefixLen);
    return ip >> shift === network >> shift;
};

const EXACT_LOOPBACK_IPV4 = ipv4FromOctets(127, 0, 0, 1);
const LOOPBACK_IPV4_NETWORK = ipv4FromOctets(127, 0, 0, 0);

// Non-globally-reachable IANA RFC 6890 IPv4 ranges (excluding 127.0.0.0/8, handled explicitly).
const BLOCKED_IPV4_CIDRS: ReadonlyArray<readonly [number, number]> = [
    [ipv4FromOctets(0, 0, 0, 0), 8], // This network
    [ipv4FromOctets(10, 0, 0, 0), 8], // RFC 1918 private
    [ipv4FromOctets(100, 64, 0, 0), 10], // RFC 6598 CGNAT / Tailscale / Alibaba IMDS
    [ipv4FromOctets(169, 254, 0, 0), 16], // Link-local / cloud IMDS
    [ipv4FromOctets(172, 16, 0, 0), 12], // RFC 1918 private
    [ipv4FromOctets(192, 0, 0, 0), 24], // IETF protocol assignments
    [ipv4FromOctets(192, 0, 2, 0), 24], // TEST-NET-1
    [ipv4FromOctets(192, 168, 0, 0), 16], // RFC 1918 private
    [ipv4FromOctets(198, 18, 0, 0), 15], // Benchmarking
    [ipv4FromOctets(198, 51, 100, 0), 24], // TEST-NET-2
    [ipv4FromOctets(203, 0, 113, 0), 24], // TEST-NET-3
    [ipv4FromOctets(224, 0, 0, 0), 4], // Multicast
    [ipv4FromOctets(240, 0, 0, 0), 4], // Reserved + 255.255.255.255
];

const IPV6_LOOPBACK = 1n;
const IPV4_MAPPED_IPV6_PREFIX = mustParseIpv6("::ffff:0:0");

// Non-globally-reachable IANA RFC 6890 IPv6 ranges (::1/128 and ::ffff:0:0/96 handled explicitly first).
const BLOCKED_IPV6_CIDRS: ReadonlyArray<readonly [bigint, number]> = [
    [mustParseIpv6("::"), 96], // Unspecified (::/128) and deprecated IPv4-compatible (::/96)
    [mustParseIpv6("::ffff:0:0:0"), 96], // IPv4-translated (RFC 2765)
    [mustParseIpv6("64:ff9b::"), 96], // NAT64 well-known prefix (RFC 6052)
    [mustParseIpv6("64:ff9b:1::"), 48], // NAT64 local-use prefix (RFC 8215)
    [mustParseIpv6("100::"), 64], // Discard-only (RFC 6666)
    [mustParseIpv6("2001::"), 32], // Teredo (RFC 4380)
    [mustParseIpv6("2001:2::"), 48], // Benchmarking (RFC 5180)
    [mustParseIpv6("2001:db8::"), 32], // Documentation (RFC 3849)
    [mustParseIpv6("2002::"), 16], // 6to4 (RFC 3056)
    [mustParseIpv6("fc00::"), 7], // Unique-local (RFC 4193)
    [mustParseIpv6("fe80::"), 10], // Link-local (RFC 4291)
    [mustParseIpv6("fec0::"), 10], // Site-local deprecated (RFC 3879)
    [mustParseIpv6("ff00::"), 8], // Multicast (RFC 4291)
];

const isBlockedIpv4 = (ip: number, options: IpValidationOptions): boolean => {
    if (isInIpv4Cidr(ip, LOOPBACK_IPV4_NETWORK, 8)) {
        return !(options.allowLiteralLoopback && ip === EXACT_LOOPBACK_IPV4);
    }

    return BLOCKED_IPV4_CIDRS.some(([network, prefixLen]) => isInIpv4Cidr(ip, network, prefixLen));
};

const isBlockedIpv6 = (ip: bigint, options: IpValidationOptions): boolean => {
    if (ip === IPV6_LOOPBACK) {
        return !options.allowLiteralLoopback;
    }

    if (isInIpv6Cidr(ip, IPV4_MAPPED_IPV6_PREFIX, 96)) {
        const embeddedIpv4 = Number(ip & 0xffffffffn) >>> 0;
        return isBlockedIpv4(embeddedIpv4, options);
    }

    return BLOCKED_IPV6_CIDRS.some(([network, prefixLen]) => isInIpv6Cidr(ip, network, prefixLen));
};

const isBlockedIpAddress = (address: string, options: IpValidationOptions): boolean => {
    const normalized = normalizeHostname(address);
    const family = isIP(normalized);
    if (family === 4) {
        const ipv4 = parseIpv4ToUint32(normalized);
        return ipv4 === undefined || isBlockedIpv4(ipv4, options);
    }
    if (family === 6) {
        const ipv6 = parseIpv6ToBigInt(normalized);
        return ipv6 === undefined || isBlockedIpv6(ipv6, options);
    }
    return true;
};

const isLoopbackHost = (hostname: string): boolean => {
    const normalized = normalizeHostname(hostname);
    if (normalized === "localhost") {
        return true;
    }

    const ipv4 = parseIpv4ToUint32(normalized);
    if (ipv4 !== undefined) {
        return ipv4 === EXACT_LOOPBACK_IPV4;
    }

    const ipv6 = parseIpv6ToBigInt(normalized);
    if (ipv6 !== undefined) {
        if (ipv6 === IPV6_LOOPBACK) {
            return true;
        }
        if (isInIpv6Cidr(ipv6, IPV4_MAPPED_IPV6_PREFIX, 96)) {
            const embeddedIpv4 = Number(ipv6 & 0xffffffffn) >>> 0;
            return embeddedIpv4 === EXACT_LOOPBACK_IPV4;
        }
    }

    return false;
};

const createAbortError = (signal?: AbortSignal): unknown => {
    if (signal?.reason !== undefined) {
        return signal.reason;
    }
    return new DOMException("The operation was aborted", "AbortError");
};

const lookupAll = async (hostname: string, signal?: AbortSignal): Promise<string[]> => {
    if (signal?.aborted) {
        throw createAbortError(signal);
    }

    const lookupPromise = lookup(hostname, { all: true, verbatim: true }).then((entries) =>
        entries.map((entry) => entry.address),
    );

    if (!signal) {
        return lookupPromise;
    }

    return new Promise<string[]>((resolve, reject) => {
        const onAbort = () => {
            reject(createAbortError(signal));
        };

        signal.addEventListener("abort", onAbort, { once: true });
        lookupPromise.then(
            (addresses) => {
                signal.removeEventListener("abort", onAbort);
                resolve(addresses);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
};

// === Connection-time hostname resolution and pinned safe fetch transport ===
//
// Exported utilities for the custom provider factory to validate every
// DNS answer, pin the validated IP at socket connection time, and reject
// every redirect hop.

export type DnsResolveFn = (hostname: string, options?: { signal?: AbortSignal }) => Promise<string[]>;

export const defaultDnsResolve: DnsResolveFn = async (hostname, options) => {
    try {
        return await lookupAll(hostname, options?.signal);
    } catch (error: unknown) {
        if (options?.signal?.aborted) {
            throw error;
        }
        return [];
    }
};

export const resolveAndValidateHostname = async (
    hostname: string,
    dnsResolve: DnsResolveFn,
    signal?: AbortSignal,
): Promise<string[]> => {
    const normalized = normalizeHostname(hostname);

    if (!normalized || normalized.endsWith(".localhost")) {
        throw new Error("custom_url host is not allowed");
    }

    if (normalized === "localhost") {
        return [hostname];
    }

    const literalFamily = isIP(normalized);
    if (literalFamily === 4) {
        const ipv4 = parseIpv4ToUint32(normalized);
        if (ipv4 === undefined || isBlockedIpv4(ipv4, { allowLiteralLoopback: true })) {
            throw new Error("custom_url host is not allowed");
        }
        return [normalized];
    }

    if (literalFamily === 6) {
        const ipv6 = parseIpv6ToBigInt(normalized);
        if (ipv6 === undefined || isBlockedIpv6(ipv6, { allowLiteralLoopback: true })) {
            throw new Error("custom_url host is not allowed");
        }
        return [normalized];
    }

    // DNS resolution for symbolic hostnames; never allow loopback from DNS answers.
    const addresses = await dnsResolve(normalized, { signal });
    if (addresses.length === 0) {
        throw new Error("custom_url host is not allowed");
    }

    for (const addr of addresses) {
        if (isBlockedIpAddress(addr, { allowLiteralLoopback: false })) {
            throw new Error("custom_url host is not allowed");
        }
    }

    return addresses;
};

export const isBlockedHost = async (hostname: string): Promise<boolean> => {
    try {
        await resolveAndValidateHostname(hostname, defaultDnsResolve);
        return false;
    } catch {
        return true;
    }
};

const selectPinnedAddresses = (
    pinned: readonly PinnedAddress[],
    family: number | string | undefined,
): PinnedAddress[] => {
    if (family === 4 || family === 6) {
        return pinned.filter((entry) => entry.family === family);
    }
    return [...pinned];
};

const createNotFoundLookupError = (hostname: string): NodeJS.ErrnoException => {
    const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    error.code = "ENOTFOUND";
    return error;
};

type SingleLookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
type AllLookupCallback = (err: NodeJS.ErrnoException | null, addresses: PinnedAddress[]) => void;

export const createPinnedLookup = (pinned: readonly PinnedAddress[]): LookupFunction => {
    const pinnedLookup = (
        hostname: string,
        optionsOrCallback: number | { family?: number | string; all?: boolean } | SingleLookupCallback,
        maybeCallback?: SingleLookupCallback | AllLookupCallback,
    ): void => {
        if (typeof optionsOrCallback === "function") {
            const first = pinned[0];
            process.nextTick(() => {
                if (!first) {
                    optionsOrCallback(createNotFoundLookupError(hostname), "", 4);
                    return;
                }
                optionsOrCallback(null, first.address, first.family);
            });
            return;
        }

        if (!maybeCallback) {
            return;
        }

        const isAll = typeof optionsOrCallback === "object" && optionsOrCallback !== null && optionsOrCallback.all;
        const requestedFamily =
            typeof optionsOrCallback === "number"
                ? optionsOrCallback
                : typeof optionsOrCallback === "object" && optionsOrCallback !== null
                  ? optionsOrCallback.family
                  : undefined;

        const selected = selectPinnedAddresses(pinned, requestedFamily);

        process.nextTick(() => {
            if (isAll) {
                const allCallback = maybeCallback as AllLookupCallback;
                if (selected.length === 0) {
                    allCallback(createNotFoundLookupError(hostname), []);
                    return;
                }
                allCallback(null, selected);
                return;
            }

            const singleCallback = maybeCallback as SingleLookupCallback;
            const first = selected[0];
            if (!first) {
                singleCallback(createNotFoundLookupError(hostname), "", 4);
                return;
            }
            singleCallback(null, first.address, first.family);
        });
    };

    return pinnedLookup as LookupFunction;
};

const resolvePinnedAddresses = async (
    resolvedAddresses: readonly string[],
    signal?: AbortSignal,
): Promise<PinnedAddress[]> => {
    const pinned: PinnedAddress[] = [];

    for (const rawAddress of resolvedAddresses) {
        const normalized = normalizeHostname(rawAddress);
        if (normalized === "localhost") {
            const localhostAddresses = await lookupAll("localhost", signal);
            if (localhostAddresses.length === 0) {
                throw new Error("custom_url host is not allowed");
            }
            for (const candidate of localhostAddresses) {
                if (isBlockedIpAddress(candidate, { allowLiteralLoopback: true })) {
                    throw new Error("custom_url host is not allowed");
                }
                const family = isIP(candidate);
                if (family === 4 || family === 6) {
                    pinned.push({ address: candidate, family });
                }
            }
            continue;
        }

        const family = isIP(normalized);
        if (family !== 4 && family !== 6) {
            throw new Error("custom_url host is not allowed");
        }
        pinned.push({ address: normalized, family });
    }

    if (pinned.length === 0) {
        throw new Error("custom_url host is not allowed");
    }

    return pinned;
};

const isNullBodyStatus = (status: number): boolean => {
    return status === 101 || status === 204 || status === 205 || status === 304;
};

export type PinnedTransportFn = (request: Request, resolvedAddresses: string[]) => Promise<Response>;

export const pinnedHttpTransport: PinnedTransportFn = async (request, resolvedAddresses) => {
    const url = new URL(request.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("custom_url must use http:// or https://");
    }

    const signal = request.signal;
    if (signal?.aborted) {
        throw createAbortError(signal);
    }

    const pinnedAddresses = await resolvePinnedAddresses(resolvedAddresses, signal);
    const rawHostname = normalizeHostname(url.hostname);
    const headers: Record<string, string> = {};

    request.headers.forEach((value, key) => {
        headers[key] = value;
    });

    if (!request.headers.has("host")) {
        headers.host = url.host;
    }

    if (!request.headers.has("accept-encoding")) {
        headers["accept-encoding"] = "identity";
    }

    let bodyBuffer: Buffer | undefined;
    if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
        bodyBuffer = Buffer.from(await request.arrayBuffer());
        if (!request.headers.has("content-length") && !request.headers.has("transfer-encoding")) {
            headers["content-length"] = String(bodyBuffer.byteLength);
        }
    }

    const isHttps = url.protocol === "https:";
    const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
    const path = `${url.pathname}${url.search}`;
    const pinnedLookup = createPinnedLookup(pinnedAddresses);

    return new Promise<Response>((resolve, reject) => {
        if (signal?.aborted) {
            reject(createAbortError(signal));
            return;
        }

        let settled = false;
        let activeResponse: http.IncomingMessage | undefined;

        const onAbort = () => {
            const abortError = createAbortError(signal);
            if (!settled) {
                settled = true;
                req.destroy();
                reject(abortError);
                return;
            }
            activeResponse?.destroy(abortError instanceof Error ? abortError : new Error("The operation was aborted"));
        };

        const cleanupAbort = () => {
            signal?.removeEventListener("abort", onAbort);
        };

        const baseOptions: http.RequestOptions = {
            agent: false,
            headers,
            hostname: rawHostname,
            lookup: pinnedLookup,
            method: request.method,
            path,
            port,
        };

        const req = isHttps
            ? https.request({
                  ...baseOptions,
                  ...(isIP(rawHostname) === 0 ? { servername: rawHostname } : {}),
              })
            : http.request(baseOptions);

        signal?.addEventListener("abort", onAbort, { once: true });

        req.on("error", (error: Error) => {
            cleanupAbort();
            if (!settled) {
                settled = true;
                reject(signal?.aborted ? createAbortError(signal) : error);
            }
        });

        req.on("response", (res: http.IncomingMessage) => {
            if (settled) {
                res.destroy();
                return;
            }
            settled = true;
            activeResponse = res;

            const status = res.statusCode ?? 200;
            const statusText = res.statusMessage ?? "";
            const responseHeaders = new Headers();

            for (let i = 0; i < res.rawHeaders.length; i += 2) {
                const name = res.rawHeaders[i];
                const value = res.rawHeaders[i + 1];
                if (name !== undefined && value !== undefined) {
                    responseHeaders.append(name, value);
                }
            }

            if ((status >= 300 && status < 400) || isNullBodyStatus(status) || request.method === "HEAD") {
                cleanupAbort();
                res.destroy();
                resolve(new Response(null, { headers: responseHeaders, status, statusText }));
                return;
            }

            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    let closed = false;

                    const closeStream = () => {
                        cleanupAbort();
                        if (!closed) {
                            closed = true;
                            controller.close();
                        }
                    };

                    const errorStream = (err: unknown) => {
                        cleanupAbort();
                        if (!closed) {
                            closed = true;
                            controller.error(err);
                        }
                    };

                    res.on("data", (chunk: Buffer | Uint8Array | string) => {
                        if (closed) {
                            return;
                        }
                        const bytes =
                            typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
                        controller.enqueue(bytes);
                        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                            res.pause();
                        }
                    });

                    res.on("end", closeStream);
                    res.on("error", (err: Error) => {
                        errorStream(signal?.aborted ? createAbortError(signal) : err);
                    });
                    res.on("close", () => {
                        if (!closed) {
                            if (res.complete) {
                                closeStream();
                            } else {
                                errorStream(
                                    signal?.aborted
                                        ? createAbortError(signal)
                                        : new Error("Response stream closed prematurely"),
                                );
                            }
                        }
                    });
                },
                pull() {
                    res.resume();
                },
                cancel() {
                    cleanupAbort();
                    res.destroy();
                },
            });

            resolve(new Response(stream, { headers: responseHeaders, status, statusText }));
        });

        if (bodyBuffer) {
            req.end(bodyBuffer);
        } else {
            req.end();
        }
    });
};

type CustomFetch = typeof fetch;

export interface SafeCustomFetchOptions {
    transport?: PinnedTransportFn;
}

export const createSafeCustomFetch = (dnsResolve: DnsResolveFn, options?: SafeCustomFetchOptions): CustomFetch => {
    const transport = options?.transport ?? pinnedHttpTransport;

    const safeFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const requestInput = input instanceof URL ? input.toString() : input;
        const request =
            requestInput instanceof Request
                ? init
                    ? new Request(requestInput, { ...init, redirect: "manual" })
                    : requestInput
                : new Request(requestInput, { ...init, redirect: "manual" });

        const url = new URL(request.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("custom_url must use http:// or https://");
        }

        const signal = request.signal ?? undefined;
        const resolvedAddresses = await resolveAndValidateHostname(url.hostname, dnsResolve, signal);

        const response = await transport(request, resolvedAddresses);

        if ((response.status >= 300 && response.status < 400) || response.redirected) {
            throw new Error("custom_url redirects are not allowed");
        }

        return response;
    };

    return safeFetch as unknown as CustomFetch;
};
