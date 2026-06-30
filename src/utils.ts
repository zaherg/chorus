export const getErrorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

export const estimateTokenCount = (text: string): number =>
    text.length === 0 ? 0 : Math.ceil(text.length / 4);
