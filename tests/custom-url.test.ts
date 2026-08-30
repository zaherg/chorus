import { describe, expect, test } from "bun:test";

import { createSafeCustomFetch, type DnsResolveFn, resolveAndValidateHostname } from "@/providers/custom-url";

describe("resolveAndValidateHostname", () => {
    test("allows loopback hosts without DNS calls", async () => {
        const dns: DnsResolveFn = async () => {
            throw new Error("should not be called");
        };

        for (const hostname of ["localhost", "::1"]) {
            const result = await resolveAndValidateHostname(hostname, dns);
            expect(result).toEqual([hostname]);
        }
    });

    test("rejects private IPv4 literal", async () => {
        const dns: DnsResolveFn = async () => {
            throw new Error("should not be called");
        };
        await expect(resolveAndValidateHostname("192.168.1.1", dns)).rejects.toThrow("custom_url host is not allowed");
    });

    test("rejects private IPv4-mapped IPv6 literal", async () => {
        const dns: DnsResolveFn = async () => {
            throw new Error("should not be called");
        };
        await expect(resolveAndValidateHostname("::ffff:10.0.0.1", dns)).rejects.toThrow(
            "custom_url host is not allowed",
        );
    });

    test("rejects public hostname resolving to private IP", async () => {
        const dns: DnsResolveFn = async () => {
            return ["10.0.0.5"];
        };
        await expect(resolveAndValidateHostname("evil.internal-proxy.com", dns)).rejects.toThrow(
            "custom_url host is not allowed",
        );
    });

    test("allows public hostname resolving to public IPs", async () => {
        const dns: DnsResolveFn = async () => {
            return ["1.2.3.4"];
        };
        const result = await resolveAndValidateHostname("api.example.com", dns);
        expect(result).toEqual(["1.2.3.4"]);
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

describe("createSafeCustomFetch", () => {
    test("creates a fetch function that validates hostname before request", async () => {
        const dns: DnsResolveFn = async () => {
            return ["1.2.3.4"];
        };
        const safeFetch = createSafeCustomFetch(dns);

        // Injected fetch determines if we made it past validation.
        let wasCalled = false;
        const request = new Request("https://valid.example.com/test");
        const response = new Response("ok", { status: 200 });

        // Use Reflect.set to replace the global fetch used internally.
        const origFetch = globalThis.fetch;
        globalThis.fetch = Object.assign(
            async () => {
                wasCalled = true;
                return response;
            },
            { preconnect: () => {} },
        );

        try {
            const result = await safeFetch(request);
            expect(wasCalled).toBeTrue();
            expect(await result.text()).toBe("ok");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("rejects request before calling fetch when hostname resolves to private IP", async () => {
        const dns: DnsResolveFn = async () => {
            return ["10.0.0.1"];
        };
        const safeFetch = createSafeCustomFetch(dns);

        let fetchCalled = false;
        const origFetch = globalThis.fetch;
        globalThis.fetch = Object.assign(
            async () => {
                fetchCalled = true;
                return new Response("ok");
            },
            { preconnect: () => {} },
        );

        try {
            await expect(safeFetch("https://evil.internal/test")).rejects.toThrow("custom_url host is not allowed");
            expect(fetchCalled).toBeFalse();
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("rejects redirects before following target", async () => {
        const dns: DnsResolveFn = async () => {
            return ["1.2.3.4"];
        };
        const safeFetch = createSafeCustomFetch(dns);

        let redirectMode: string | undefined;
        const origFetch = globalThis.fetch;
        globalThis.fetch = Object.assign(
            async (_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
                redirectMode = init?.redirect;
                return new Response(null, {
                    status: 302,
                    headers: { location: "https://1.2.3.4/final" },
                });
            },
            { preconnect: () => {} },
        );

        try {
            await expect(safeFetch("https://example.com/start")).rejects.toThrow(
                "custom_url redirects are not allowed",
            );
            expect(redirectMode).toBe("manual");
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});
