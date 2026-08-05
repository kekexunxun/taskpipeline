export type PlanDecision = {
    outcome: "changes_required" | "already_satisfied";
    content: string;
};
export declare function sdkResultText(result: unknown, errors?: unknown): string | undefined;
export declare function parsePlanDecision(texts: string[]): PlanDecision;
