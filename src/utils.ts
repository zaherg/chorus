export const getErrorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const estimateTokenCount = (text: string) => (text.length === 0 ? 0 : Math.ceil(text.length / 4));
