import type { ParticipantResponse, Stance } from "@/types/consensus";

export const buildConsensusPrompt = ({
    step,
    findings,
    stance,
    fileText,
    priorResponses,
}: {
    step: string;
    findings: string;
    stance: Stance;
    fileText: string;
    priorResponses?: ParticipantResponse[];
}) => {
    const sections = [`Consensus review for stance: ${stance}`, `Proposal:\n${step}`, `Current findings:\n${findings}`];
    if (priorResponses?.length) {
        sections.push(
            `<previous-model-responses>\n${JSON.stringify(priorResponses, null, 2)}\n</previous-model-responses>`,
        );
    }
    if (fileText) {
        sections.push(`Embedded files:\n${fileText}`);
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
        `<model-responses>\n${JSON.stringify(successfulResponses, null, 2)}\n</model-responses>`,
    ];
    if (fileText) {
        sections.push(`Embedded files:\n${fileText}`);
    }
    return sections.join("\n\n");
};
