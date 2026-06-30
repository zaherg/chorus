import { describe, expect, test } from "bun:test";

import {
    getModelsDevProviderKey,
    isCatalogBackedProvider,
} from "@/providers/provider-map";
import type { ProviderId } from "@/types/providers";

const CATALOG_BACKED: ReadonlyArray<ProviderId> = [
    "alibaba",
    "amazon-bedrock",
    "anthropic",
    "azure",
    "baseten",
    "cerebras",
    "cohere",
    "deepinfra",
    "deepseek",
    "fireworks",
    "google",
    "google-vertex",
    "groq",
    "huggingface",
    "mistral",
    "openai",
    "openrouter",
    "perplexity",
    "togetherai",
    "vercel",
    "xai",
];

const EXPECTED_KEYS: Readonly<Record<ProviderId, string | undefined>> = {
    alibaba: "alibaba",
    "amazon-bedrock": "amazon-bedrock",
    anthropic: "anthropic",
    azure: "azure",
    baseten: "baseten",
    cerebras: "cerebras",
    cohere: "cohere",
    custom: undefined,
    deepinfra: "deepinfra",
    deepseek: "deepseek",
    fireworks: "fireworks-ai",
    gateway: undefined,
    google: "google",
    "google-vertex": "google-vertex",
    groq: "groq",
    huggingface: "huggingface",
    mistral: "mistral",
    openai: "openai",
    openrouter: "openrouter",
    perplexity: "perplexity",
    togetherai: "togetherai",
    vercel: "vercel",
    xai: "xai",
};

const PASSTHROUGH: ReadonlyArray<ProviderId> = ["custom", "gateway"];

describe("provider-map", () => {
    describe("getModelsDevProviderKey", () => {
        test("returns the spec key for each catalog-backed provider", () => {
            for (const id of CATALOG_BACKED) {
                expect(getModelsDevProviderKey(id)).toBe(EXPECTED_KEYS[id]);
            }
        });

        test("returns undefined for passthrough providers", () => {
            expect(getModelsDevProviderKey("custom")).toBeUndefined();
            expect(getModelsDevProviderKey("gateway")).toBeUndefined();
        });
    });

    describe("isCatalogBackedProvider", () => {
        test("returns true for the 21 catalog-backed providers", () => {
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
