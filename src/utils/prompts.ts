import type { ParticipantResponse, Stance } from "@/types/consensus";

const serializeSafeJson = (value: unknown): string =>
    (JSON.stringify(value, null, 2) ?? "null").replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");

const escapeEmbeddedFilesTag = (fileText: string): string =>
    fileText.replace(/<(\s*\/?\s*embedded-files\b)/gi, "&lt;$1");

export const buildConsensusPrompt = ({
    step,
    findings,
    stance,
    fileText,
    priorResponses,
}: {
    step: string;
    findings: string;
    stance?: Stance;
    fileText: string;
    priorResponses?: ParticipantResponse[];
}) => {
    const header =
        stance !== undefined
            ? `Consensus review for stance: ${stance}`
            : "Consensus review (no assigned stance; form an independent evaluation):";
    const sections = [header, `Proposal:\n${step}`, `Current findings:\n${findings}`];
    if (priorResponses?.length) {
        sections.push(`<previous-model-responses>\n${serializeSafeJson(priorResponses)}\n</previous-model-responses>`);
    }
    if (fileText) {
        sections.push(`<embedded-files>\n${escapeEmbeddedFilesTag(fileText)}\n</embedded-files>`);
    }
    return sections.join("\n\n");
};

export const buildSynthesisPrompt = ({
    step,
    findings,
    successfulResponses,
    fileText,
}: {
    step: string;
    findings: string;
    successfulResponses: ParticipantResponse[];
    fileText: string;
}) => {
    const sections = [
        "Synthesize the following model perspectives into a single recommendation.",
        `Proposal:\n${step}`,
        `Independent findings:\n${findings}`,
        `<model-responses>\n${serializeSafeJson(successfulResponses)}\n</model-responses>`,
    ];
    if (fileText) {
        sections.push(`<embedded-files>\n${escapeEmbeddedFilesTag(fileText)}\n</embedded-files>`);
    }
    return sections.join("\n\n");
};
