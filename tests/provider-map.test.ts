import { describe, expect, test } from "bun:test";

import {
    getModelsDevProviderKey,
    isCatalogBackedProvider,
} from "@/providers/provider-map";
import { type ProviderId, providerIdValues } from "@/types/providers";

const CATALOG_BACKED: ReadonlyArray<ProviderId> = [
    "amazon-bedrock",
    "anthropic",
    "azure",
    "google-vertex",
    "openrouter",
];

const EXPECTED_KEYS: Readonly<Record<ProviderId, string | undefined>> = {
    "amazon-bedrock": "amazon-bedrock",
    anthropic: "anthropic",
    azure: "azure",
    custom: undefined,
    "google-vertex": "google-vertex",
    openrouter: "openrouter",
};

const PASSTHROUGH: ReadonlyArray<ProviderId> = ["custom"];

describe("provider-map", () => {
    test("exports exactly the six retained provider IDs", () => {
        expect(providerIdValues).toEqual([
            "amazon-bedrock",
            "anthropic",
            "azure",
            "custom",
            "google-vertex",
            "openrouter",
        ]);
    });

    describe("getModelsDevProviderKey", () => {
        test("returns the spec key for each catalog-backed provider", () => {
            for (const id of CATALOG_BACKED) {
                expect(getModelsDevProviderKey(id)).toBe(EXPECTED_KEYS[id]);
            }
        });

        test("returns undefined for passthrough providers", () => {
            expect(getModelsDevProviderKey("custom")).toBeUndefined();
        });
    });

    describe("isCatalogBackedProvider", () => {
        test("returns true for the 5 catalog-backed providers", () => {
            for (const id of CATALOG_BACKED) {
                expect(isCatalogBackedProvider(id)).toBe(true);
            }
        });

        test("returns false for passthrough providers", () => {
            for (const id of PASSTHROUGH) {
                expect(isCatalogBackedProvider(id)).toBe(false);
            }
        });
    });
});
