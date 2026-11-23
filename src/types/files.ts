import { z } from "zod/v4";

export const EmbeddedFileResultSchema = z.object({
    embedded_files: z.array(z.string()),
    embedded_text: z.string(),
    skipped_files: z.array(z.string()),
    total_tokens: z.number(),
});

export type EmbeddedFileResult = z.infer<typeof EmbeddedFileResultSchema>;
