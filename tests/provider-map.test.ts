import { describe, expect, test } from "bun:test";

import {
    getModelsDevProviderKey,
    isCatalogBackedProvider,
} from "@/providers/provider-map";
import { providerIdValues } from "@/types/providers";

describe("provider-map", () => {
    test("retains the public provider set and keeps catalog mapping consistent", () => {
        const expectedModelsDevKeys = [
            ["amazon-bedrock", "amazon-bedrock"],
            ["anthropic", "anthropic"],
            ["azure", "azure"],
            ["google-vertex", "google-vertex"],
            ["openrouter", "openrouter"],
        ] as const;

        expect(providerIdValues).toEqual([
            "amazon-bedrock",
            "anthropic",
            "azure",
            "custom",
            "google-vertex",
            "openrouter",
        ]);

        for (const [providerId, expectedKey] of expectedModelsDevKeys) {
            expect(getModelsDevProviderKey(providerId)).toBe(expectedKey);
            expect(isCatalogBackedProvider(providerId)).toBeTrue();
        }

        expect(getModelsDevProviderKey("custom")).toBeUndefined();
        expect(isCatalogBackedProvider("custom")).toBeFalse();
    });
});
