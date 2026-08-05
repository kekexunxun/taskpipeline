export type ImplementationOutcome = "needs_input" | "already_satisfied" | "completed" | "unknown";
export type ImplementationNextStep = "await_input" | "complete_without_changes" | "validate" | "await_confirmation";
export type PlanNextStep = "complete_without_changes" | "await_plan_approval";
export type ImplementationDecision = {
    outcome: ImplementationOutcome;
    content: string;
};
export declare const implementationOutcomeInstruction: string;
export declare function parseImplementationDecision(texts: string[]): ImplementationDecision;
export declare function nextStepForImplementation(outcome: ImplementationOutcome, changedFileCount: number): ImplementationNextStep;
export declare function nextStepForPlan(outcome: "changes_required" | "already_satisfied", changedFileCount: number): PlanNextStep;
export declare function isExplicitNoChangeCompletionRequest(message: string): boolean;
