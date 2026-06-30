import { z } from "zod/v4";

import type { ChorusConfig } from "@/config";
import { BrokerModelInfoSchema, type ProviderId } from "@/types/providers";

export const testConfig = (
    overrides: Partial<ChorusConfig> = {},
): ChorusConfig => {
    return {
        cli_timeout_ms: 30_000,
        provider_timeout_ms: 120_000,
        log_level: "info",
        max_concurrent_processes: 5,
        ...overrides,
    };
};

export const testModel = (input: {
    id?: string;
    route_id?: string;
    provider: ProviderId;
    provider_model_id?: string;
    display_name?: string;
}): ReturnType<typeof BrokerModelInfoSchema.parse> => {
    const routeId =
        input.route_id ??
        `${input.provider}/${input.provider_model_id ?? input.id ?? "model"}`;
    return BrokerModelInfoSchema.parse({
        route_id: routeId,
        provider: input.provider,
        provider_model_id:
            input.provider_model_id ??
            input.id ??
            routeId.split("/").slice(1).join("/"),
        display_name: input.display_name ?? input.id ?? routeId,
    });
};

const pushChunk = (lines: string[], chunk: string | Uint8Array): void => {
    lines.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
};

export const captureOutput = async <T>(
    run: () => Promise<T>,
): Promise<{ result: T; stderr: string; stdout: string }> => {
    const stderrLines: string[] = [];
    const stdoutLines: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);

    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        pushChunk(stderrLines, chunk);
        return true;
    }) as typeof process.stderr.write;

    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        pushChunk(stdoutLines, chunk);
        return true;
    }) as typeof process.stdout.write;

    try {
        return {
            result: await run(),
            stderr: stderrLines.join(""),
            stdout: stdoutLines.join(""),
        };
    } finally {
        process.stderr.write = originalStderrWrite;
        process.stdout.write = originalStdoutWrite;
    }
};

export const captureStdout = async <T>(
    run: () => Promise<T>,
): Promise<{ output: string; result: T }> => {
    const { result, stdout } = await captureOutput(run);
    return { result, output: stdout };
};

// Touch zod import to keep the runtime import even if no test file imports
// the schema directly (this helper file is the de-facto shared test surface).
void z;
