import { describe, expect, test } from "bun:test";
import http from "node:http";

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

describe("customProviderBaseUrl and isBlockedHost", () => {
    test("allows valid public IPv6 literal without DNS", async () => {
        const url = await customProviderBaseUrl("https://[2606:4700:4700::1111]/v1", false);
        expect(url).toBe("https://[2606:4700:4700::1111]/v1");
        expect(await isBlockedHost("[2606:4700:4700::1111]")).toBeFalse();
    });

    test("allows literal IPv6 loopback URL on http without allow_insecure_custom", async () => {
        const url = await customProviderBaseUrl("http://[::1]:11434/v1", false);
        expect(url).toBe("http://[::1]:11434/v1");
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
        const blockedIpv4 = [
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
        ];

        for (const ip of blockedIpv4) {
            expect(await isBlockedHost(ip)).toBeTrue();
            await expect(customProviderBaseUrl(`https://${ip}/v1`, false)).rejects.toThrow(
                "custom_url host is not allowed",
            );
        }
    });

    test("rejects blocked IPv6 bypass notations", async () => {
        const blockedIpv6 = [
            "::",
            "::a9fe:a9fe",
            "::ffff:0:0:1",
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
        ];

        for (const ip of blockedIpv6) {
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
        for (const ip of ["192.168.1.1", "100.100.100.200", "198.18.0.1", "192.0.0.1", "224.0.0.1", "240.0.0.1"]) {
            await expect(resolveAndValidateHostname(ip, neverCallDns)).rejects.toThrow(
                "custom_url host is not allowed",
            );
        }
    });

    test("rejects blocked IPv6 literals without calling DNS", async () => {
        const blocked = [
            "::",
            "::a9fe:a9fe",
            "::ffff:10.0.0.1",
            "2001::a9fe:a9fe",
            "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
            "0064:ff9b::169.254.169.254",
            "64:ff9b:1::1",
            "100::1",
            "2001:db8::1",
            "ff02::1",
            "0000:0000:0000:0000:0000:ffff:a9fe:a9fe",
        ];

        for (const ip of blocked) {
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
});
