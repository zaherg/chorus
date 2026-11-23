import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";

import {
    createPinnedLookup,
    createSafeCustomFetch,
    customProviderBaseUrl,
    type DnsResolveFn,
    defaultDnsResolve,
    isBlockedHost,
    type PinnedTransportFn,
    pinnedHttpTransport,
    resolveAndValidateHostname,
} from "@/providers/custom-url";

const neverCallDns: DnsResolveFn = async () => {
    throw new Error("DNS should not be called for literal hosts");
};

const BLOCKED_IPV4_LITERALS = [
    "0.0.0.0",
    "10.0.0.1",
    "100.100.100.200",
    "127.0.0.2",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
] as const;

const BLOCKED_IPV6_LITERALS = [
    "::",
    "::a9fe:a9fe",
    "::ffff:0:0:1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:192.168.1.1",
    "::ffff:a9fe:a9fe",
    "::ffff:c0a8:101",
    "2001::a9fe:a9fe",
    "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
    "2001:2::1",
    "0064:ff9b::169.254.169.254",
    "64:ff9b:1::1",
    "100::1",
    "2001:db8::1",
    "2002:a9fe:a9fe::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "0000:0000:0000:0000:0000:ffff:a9fe:a9fe",
] as const;

const listenOnLoopback = async (
    host: "127.0.0.1" | "::1",
    handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> => {
    const server = http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, () => {
            server.off("error", reject);
            resolve();
        });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
        server.close();
        throw new Error("Failed to bind local test server");
    }

    return { server, port: address.port };
};

const closeServer = async (server: http.Server): Promise<void> => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
        server.close((err) => {
            if (err) {
                reject(err);
                return;
            }
            resolve();
        });
    });
};

afterEach(() => {
    mock.restore();
});

describe("customProviderBaseUrl and isBlockedHost", () => {
    test("returns default custom API URL for undefined and empty values", async () => {
        expect(await customProviderBaseUrl(undefined, false)).toBe("http://localhost:11434/v1");
        expect(await customProviderBaseUrl("", false)).toBe("http://localhost:11434/v1");
    });

    test("rejects invalid URL syntax", async () => {
        for (const rawUrl of ["not-a-url", "://missing-scheme", "http://[::1"]) {
            await expect(customProviderBaseUrl(rawUrl, false)).rejects.toThrow("custom_url must be a valid URL");
        }
    });

    test("rejects non-http(s) protocols", async () => {
        for (const rawUrl of ["file:///etc/passwd", "ftp://example.com/v1"]) {
            await expect(customProviderBaseUrl(rawUrl, false)).rejects.toThrow(
                "custom_url must use http:// or https://",
            );
        }
    });

    test("rejects URLs with embedded credentials", async () => {
        for (const rawUrl of [
            "https://user:pass@example.com/v1",
            "https://user@example.com/v1",
            "https://:pass@example.com/v1",
        ]) {
            await expect(customProviderBaseUrl(rawUrl, false)).rejects.toThrow(
                "custom_url must not contain credentials",
            );
        }
    });

    test("rejects URLs with fragments", async () => {
        await expect(customProviderBaseUrl("https://example.com/v1#frag", false)).rejects.toThrow(
            "custom_url must not contain a fragment",
        );
    });

    test("allows http to public IP literals only when allow_insecure_custom is true", async () => {
        await expect(customProviderBaseUrl("http://93.184.216.34/v1", false)).rejects.toThrow(
            "custom_url must use https:// unless allow_insecure_custom is set to true",
        );
        expect(await customProviderBaseUrl("http://93.184.216.34/v1", true)).toBe("http://93.184.216.34/v1");
    });

    test("allows valid public IPv6 literal without DNS", async () => {
        const url = await customProviderBaseUrl("https://[2606:4700:4700::1111]/v1", false);
        expect(url).toBe("https://[2606:4700:4700::1111]/v1");
        expect(await isBlockedHost("[2606:4700:4700::1111]")).toBeFalse();
    });

    test("allows literal loopback URLs on http without allow_insecure_custom", async () => {
        expect(await customProviderBaseUrl("http://localhost:11434/v1", false)).toBe("http://localhost:11434/v1");
        expect(await customProviderBaseUrl("http://[::1]:11434/v1", false)).toBe("http://[::1]:11434/v1");
        expect(await customProviderBaseUrl("http://[::ffff:127.0.0.1]/v1", false)).toBe("http://[::ffff:7f00:1]/v1");
        expect(await isBlockedHost("[::1]")).toBeFalse();
    });

    test("rejects .localhost subdomains and multi-dot trailing variants in isBlockedHost", async () => {
        for (const host of [
            "evil.localhost",
            "sub.evil.localhost",
            "evil.localhost.",
            "evil.localhost..",
            "EVIL.LOCALHOST...",
        ]) {
            expect(await isBlockedHost(host)).toBeTrue();
        }

        for (const url of ["https://evil.localhost/v1", "https://evil.localhost../v1"]) {
            await expect(customProviderBaseUrl(url, false)).rejects.toThrow("custom_url host is not allowed");
        }
    });

    test("rejects non-globally-reachable RFC 6890 IPv4 literals", async () => {
        for (const ip of BLOCKED_IPV4_LITERALS) {
            expect(await isBlockedHost(ip)).toBeTrue();
            await expect(customProviderBaseUrl(`https://${ip}/v1`, false)).rejects.toThrow(
                "custom_url host is not allowed",
            );
        }
    });

    test("rejects blocked IPv6 bypass notations", async () => {
        for (const ip of BLOCKED_IPV6_LITERALS) {
            expect(await isBlockedHost(`[${ip}]`)).toBeTrue();
            await expect(customProviderBaseUrl(`https://[${ip}]/v1`, false)).rejects.toThrow(
                "custom_url host is not allowed",
            );
        }
    });
});

describe("resolveAndValidateHostname", () => {
    test("allows loopback hosts without DNS calls", async () => {
        for (const hostname of ["localhost", "127.0.0.1", "::1"]) {
            const result = await resolveAndValidateHostname(hostname, neverCallDns);
            expect(result).toEqual([hostname]);
        }

        expect(await resolveAndValidateHostname("[::1]", neverCallDns)).toEqual(["::1"]);
        expect(await resolveAndValidateHostname("[::ffff:7f00:1]", neverCallDns)).toEqual(["::ffff:7f00:1"]);
    });

    test("allows valid public IPv6 literal without DNS calls", async () => {
        expect(await resolveAndValidateHostname("[2606:4700:4700::1111]", neverCallDns)).toEqual([
            "2606:4700:4700::1111",
        ]);
        expect(await resolveAndValidateHostname("2606:4700:4700::1111", neverCallDns)).toEqual([
            "2606:4700:4700::1111",
        ]);
    });

    test("rejects .localhost subdomains and multi-dot trailing variants", async () => {
        for (const host of ["evil.localhost", "a.b.localhost", "evil.localhost.", "evil.localhost.."]) {
            await expect(resolveAndValidateHostname(host, neverCallDns)).rejects.toThrow(
                "custom_url host is not allowed",
            );
        }
    });

    test("rejects private and RFC 6890 non-global IPv4 literals", async () => {
        for (const ip of BLOCKED_IPV4_LITERALS) {
            await expect(resolveAndValidateHostname(ip, neverCallDns)).rejects.toThrow(
                "custom_url host is not allowed",
            );
        }
    });

    test("rejects blocked IPv6 literals without calling DNS", async () => {
        for (const ip of BLOCKED_IPV6_LITERALS) {
            await expect(resolveAndValidateHostname(ip, neverCallDns)).rejects.toThrow(
                "custom_url host is not allowed",
            );
        }
    });

    test("rejects external hostname resolving to loopback or private IPs", async () => {
        for (const resolved of [
            ["127.0.0.1"],
            ["::1"],
            ["::ffff:127.0.0.1"],
            ["10.0.0.5"],
            ["100.100.100.200"],
            ["1.1.1.1", "127.0.0.1"],
            ["2606:4700:4700::1111", "::1"],
        ]) {
            const dns: DnsResolveFn = async () => resolved;
            await expect(resolveAndValidateHostname("evil.example", dns)).rejects.toThrow(
                "custom_url host is not allowed",
            );
        }
    });

    test("allows public hostname resolving to public IPs", async () => {
        const dns: DnsResolveFn = async () => {
            return ["1.2.3.4", "2606:4700:4700::1111"];
        };
        const result = await resolveAndValidateHostname("api.example.com", dns);
        expect(result).toEqual(["1.2.3.4", "2606:4700:4700::1111"]);
    });

    test("rejects empty DNS result", async () => {
        const dns: DnsResolveFn = async () => {
            return [];
        };
        await expect(resolveAndValidateHostname("unknown.example.com", dns)).rejects.toThrow(
            "custom_url host is not allowed",
        );
    });
});

describe("createPinnedLookup", () => {
    test("returns only pinned addresses for all and single lookup modes", async () => {
        const pinnedLookup = createPinnedLookup([
            { address: "93.184.216.34", family: 4 },
            { address: "2606:4700:4700::1111", family: 6 },
        ]);

        const allResult = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
            pinnedLookup("rebind.example", { all: true }, (err, addresses) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(addresses as unknown as Array<{ address: string; family: number }>);
            });
        });

        expect(allResult).toEqual([
            { address: "93.184.216.34", family: 4 },
            { address: "2606:4700:4700::1111", family: 6 },
        ]);

        const v6Only = await new Promise<{ address: string; family: number | undefined }>((resolve, reject) => {
            pinnedLookup("rebind.example", { family: 6 }, (err, address, family) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve({ address: address as unknown as string, family });
            });
        });

        expect(v6Only).toEqual({ address: "2606:4700:4700::1111", family: 6 });
    });

    test("returns ENOTFOUND when requested family has no pinned address", async () => {
        const pinnedLookup = createPinnedLookup([{ address: "93.184.216.34", family: 4 }]);

        await expect(
            new Promise<void>((resolve, reject) => {
                pinnedLookup("rebind.example", { family: 6 }, (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            }),
        ).rejects.toThrow("ENOTFOUND");
    });
});

describe("createSafeCustomFetch", () => {
    test("validates hostname and passes resolved IPs to transport", async () => {
        const dns: DnsResolveFn = async () => {
            return ["1.2.3.4"];
        };

        let capturedAddresses: string[] = [];
        let capturedUrl = "";
        const transport: PinnedTransportFn = async (request, resolvedAddresses) => {
            capturedUrl = request.url;
            capturedAddresses = resolvedAddresses;
            return new Response("ok", { status: 200 });
        };

        const safeFetch = createSafeCustomFetch(dns, { transport });
        const result = await safeFetch(new Request("https://valid.example.com/test"));

        expect(capturedUrl).toBe("https://valid.example.com/test");
        expect(capturedAddresses).toEqual(["1.2.3.4"]);
        expect(await result.text()).toBe("ok");
    });

    test("rejects request before calling transport when hostname resolves to private or loopback IP", async () => {
        for (const resolved of [["10.0.0.1"], ["127.0.0.1"], ["::1"]]) {
            const dns: DnsResolveFn = async () => resolved;
            let transportCalled = false;
            const transport: PinnedTransportFn = async () => {
                transportCalled = true;
                return new Response("ok");
            };

            const safeFetch = createSafeCustomFetch(dns, { transport });
            await expect(safeFetch("https://evil.internal/test")).rejects.toThrow("custom_url host is not allowed");
            expect(transportCalled).toBeFalse();
        }
    });

    test("rejects redirects returned by transport", async () => {
        const dns: DnsResolveFn = async () => {
            return ["1.2.3.4"];
        };

        const transport: PinnedTransportFn = async () => {
            return new Response(null, {
                status: 302,
                headers: { location: "https://1.2.3.4/final" },
            });
        };

        const safeFetch = createSafeCustomFetch(dns, { transport });
        await expect(safeFetch("https://example.com/start")).rejects.toThrow("custom_url redirects are not allowed");
    });

    test("pins socket connection to validated IP via pinnedHttpTransport while preserving Host header", async () => {
        const { server, port } = await listenOnLoopback("127.0.0.1", (req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                    JSON.stringify({
                        body: Buffer.concat(chunks).toString("utf8"),
                        host: req.headers.host ?? "",
                        method: req.method ?? "",
                        path: req.url ?? "",
                        token: req.headers["x-test-token"] ?? "",
                    }),
                );
            });
        });

        try {
            const request = new Request(`http://pinned.invalid:${port}/v1/chat/completions?stream=false`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-test-token": "abc123",
                },
                body: JSON.stringify({ model: "test" }),
            });

            // pinned.invalid does not exist in DNS; connecting succeeds only because the socket pins to 127.0.0.1.
            const response = await pinnedHttpTransport(request, ["127.0.0.1"]);
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                body: '{"model":"test"}',
                host: `pinned.invalid:${port}`,
                method: "POST",
                path: "/v1/chat/completions?stream=false",
                token: "abc123",
            });
        } finally {
            await closeServer(server);
        }
    });

    test("connects end-to-end to local loopback IPv4, localhost, and IPv6 servers and blocks redirects", async () => {
        let redirectTargetHit = false;
        const { server: v4Server, port: v4Port } = await listenOnLoopback("127.0.0.1", (req, res) => {
            if (req.url === "/redirect") {
                res.writeHead(302, { location: `http://127.0.0.1:${v4Port}/target` });
                res.end();
                return;
            }
            if (req.url === "/target") {
                redirectTargetHit = true;
                res.writeHead(200);
                res.end("should not follow");
                return;
            }
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(`host=${req.headers.host ?? ""}`);
        });

        const { server: v6Server, port: v6Port } = await listenOnLoopback("::1", (req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(`v6=${req.headers.host ?? ""}`);
        });

        try {
            const safeFetch = createSafeCustomFetch(defaultDnsResolve);

            const v4Response = await safeFetch(`http://127.0.0.1:${v4Port}/ping`);
            expect(v4Response.status).toBe(200);
            expect(await v4Response.text()).toBe(`host=127.0.0.1:${v4Port}`);

            const localhostResponse = await safeFetch(`http://localhost:${v4Port}/ping`);
            expect(localhostResponse.status).toBe(200);
            expect(await localhostResponse.text()).toBe(`host=localhost:${v4Port}`);

            const v6Response = await safeFetch(`http://[::1]:${v6Port}/ping`);
            expect(v6Response.status).toBe(200);
            expect(await v6Response.text()).toBe(`v6=[::1]:${v6Port}`);

            await expect(safeFetch(`http://127.0.0.1:${v4Port}/redirect`)).rejects.toThrow(
                "custom_url redirects are not allowed",
            );
            expect(redirectTargetHit).toBeFalse();
        } finally {
            await closeServer(v4Server);
            await closeServer(v6Server);
        }
    });

    test("honors AbortSignal before connecting", async () => {
        const controller = new AbortController();
        controller.abort(new DOMException("Cancelled", "AbortError"));

        const safeFetch = createSafeCustomFetch(defaultDnsResolve);
        await expect(safeFetch("http://127.0.0.1:1/test", { signal: controller.signal })).rejects.toThrow("Cancelled");
    });

    test("rejects non-http(s) URLs in createSafeCustomFetch and pinnedHttpTransport", async () => {
        const safeFetch = createSafeCustomFetch(neverCallDns);
        for (const rawUrl of ["file:///etc/passwd", "ftp://example.com/v1"]) {
            await expect(safeFetch(rawUrl)).rejects.toThrow("custom_url must use http:// or https://");
            await expect(pinnedHttpTransport(new Request(rawUrl), ["93.184.216.34"])).rejects.toThrow(
                "custom_url must use http:// or https://",
            );
        }
    });

    test("aborts an in-flight request before response headers arrive", async () => {
        let markRequestArrived: (() => void) | undefined;
        const requestArrived = new Promise<void>((resolve) => {
            markRequestArrived = resolve;
        });
        const { server, port } = await listenOnLoopback("127.0.0.1", (_req, _res) => {
            markRequestArrived?.();
        });

        try {
            const controller = new AbortController();
            const safeFetch = createSafeCustomFetch(defaultDnsResolve);
            const pending = safeFetch(`http://127.0.0.1:${port}/slow-headers`, {
                signal: controller.signal,
            });

            await requestArrived;
            controller.abort(new DOMException("Aborted before headers", "AbortError"));

            await expect(pending).rejects.toThrow("Aborted before headers");
        } finally {
            await closeServer(server);
        }
    });

    test("aborts an in-flight response body stream mid-response", async () => {
        const { server, port } = await listenOnLoopback("127.0.0.1", (_req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.flushHeaders();
            res.write("first-chunk");
        });

        try {
            const controller = new AbortController();
            const safeFetch = createSafeCustomFetch(defaultDnsResolve);
            const response = await safeFetch(`http://127.0.0.1:${port}/stream`, {
                signal: controller.signal,
            });
            expect(response.status).toBe(200);

            const reader = response.body?.getReader();
            expect(reader).toBeDefined();
            if (!reader) {
                throw new Error("Expected readable response body");
            }

            const first = await reader.read();
            expect(first.done).toBeFalse();
            expect(new TextDecoder().decode(first.value)).toBe("first-chunk");

            controller.abort(new DOMException("Aborted mid-stream", "AbortError"));
            await expect(reader.read()).rejects.toThrow("Aborted mid-stream");
        } finally {
            await closeServer(server);
        }
    });

    test("returns empty body without hanging for 204 responses and HEAD requests", async () => {
        const { server, port } = await listenOnLoopback("127.0.0.1", (req, res) => {
            if (req.url === "/no-content") {
                res.writeHead(204, { "x-status": "empty" });
                res.end();
                return;
            }
            if (req.method === "HEAD") {
                res.writeHead(200, { "content-length": "42", "x-method": "HEAD" });
                res.end();
                return;
            }
            res.writeHead(404);
            res.end();
        });

        try {
            const safeFetch = createSafeCustomFetch(defaultDnsResolve);

            const noContent = await safeFetch(`http://127.0.0.1:${port}/no-content`);
            expect(noContent.status).toBe(204);
            expect(noContent.headers.get("x-status")).toBe("empty");
            expect(noContent.body).toBeNull();
            expect(await noContent.text()).toBe("");

            const headResponse = await safeFetch(`http://127.0.0.1:${port}/head`, { method: "HEAD" });
            expect(headResponse.status).toBe(200);
            expect(headResponse.headers.get("x-method")).toBe("HEAD");
            expect(headResponse.body).toBeNull();
            expect(await headResponse.text()).toBe("");
        } finally {
            await closeServer(server);
        }
    });

    test("rejects body reading when a chunked response socket closes prematurely", async () => {
        const { server, port } = await listenOnLoopback("127.0.0.1", (_req, res) => {
            res.writeHead(200, {
                "content-type": "text/plain",
                "transfer-encoding": "chunked",
            });
            res.write("partial-body", () => {
                res.socket?.destroy();
            });
        });

        try {
            const safeFetch = createSafeCustomFetch(defaultDnsResolve);
            const response = await safeFetch(`http://127.0.0.1:${port}/truncated`);
            expect(response.status).toBe(200);
            await expect(response.text()).rejects.toThrow(/aborted|Response stream closed prematurely/i);
        } finally {
            await closeServer(server);
        }
    });

    test("rejects body reading with premature close error when response closes with complete false", async () => {
        const requestSpy = spyOn(http, "request").mockImplementation((() => {
            const reqEmitter = new EventEmitter() as EventEmitter & {
                destroy: () => void;
                end: () => void;
            };
            reqEmitter.destroy = () => undefined;
            reqEmitter.end = () => {
                queueMicrotask(() => {
                    const resEmitter = new EventEmitter() as EventEmitter & {
                        complete: boolean;
                        destroy: () => void;
                        pause: () => void;
                        rawHeaders: string[];
                        resume: () => void;
                        statusCode: number;
                        statusMessage: string;
                    };
                    resEmitter.statusCode = 200;
                    resEmitter.statusMessage = "OK";
                    resEmitter.rawHeaders = ["content-type", "text/plain"];
                    resEmitter.complete = false;
                    resEmitter.pause = () => undefined;
                    resEmitter.resume = () => undefined;
                    resEmitter.destroy = () => undefined;

                    reqEmitter.emit("response", resEmitter);
                    queueMicrotask(() => {
                        resEmitter.emit("data", Buffer.from("partial"));
                        resEmitter.emit("close");
                    });
                });
            };
            return reqEmitter as unknown as http.ClientRequest;
        }) as typeof http.request);

        try {
            const response = await pinnedHttpTransport(new Request("http://127.0.0.1:8080/truncated"), ["127.0.0.1"]);
            expect(response.status).toBe(200);
            await expect(response.text()).rejects.toThrow("Response stream closed prematurely");
        } finally {
            requestSpy.mockRestore();
        }
    });

    test("passes TLS servername for hostnames and omits it for IP literals on https requests", async () => {
        const capturedOptions: https.RequestOptions[] = [];
        const requestSpy = spyOn(https, "request").mockImplementation(((options: unknown) => {
            capturedOptions.push(options as https.RequestOptions);
            const emitter = new EventEmitter() as EventEmitter & {
                destroy: () => void;
                end: () => void;
            };
            emitter.destroy = () => undefined;
            emitter.end = () => {
                queueMicrotask(() => {
                    emitter.emit("error", new Error("intercepted tls request"));
                });
            };
            return emitter as unknown as http.ClientRequest;
        }) as typeof https.request);

        try {
            await expect(
                pinnedHttpTransport(new Request("https://api.example.com/v1/models"), ["93.184.216.34"]),
            ).rejects.toThrow("intercepted tls request");

            await expect(
                pinnedHttpTransport(new Request("https://93.184.216.34/v1/models"), ["93.184.216.34"]),
            ).rejects.toThrow("intercepted tls request");

            await expect(
                pinnedHttpTransport(new Request("https://[2606:4700:4700::1111]/v1/models"), ["2606:4700:4700::1111"]),
            ).rejects.toThrow("intercepted tls request");

            expect(requestSpy).toHaveBeenCalledTimes(3);
            expect(capturedOptions[0]?.servername).toBe("api.example.com");
            expect(capturedOptions[0]?.port).toBe(443);
            expect(capturedOptions[1]).not.toHaveProperty("servername");
            expect(capturedOptions[2]).not.toHaveProperty("servername");
        } finally {
            requestSpy.mockRestore();
        }
    });
});
