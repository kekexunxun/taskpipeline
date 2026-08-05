const outcomeMarker = /<!--\s*coding-agent-outcome:(needs_input|already_satisfied|completed)\s*-->/i;
export const implementationOutcomeInstruction = [
    "本轮结束前必须明确当前执行结果，并在最终回复最后一行输出且只输出以下标记之一：",
    "<!-- coding-agent-outcome:needs_input -->：信息不足、存在阻塞、需要用户回答，或实现尚未完成；即使已经修改了部分文件也使用此项。",
    "<!-- coding-agent-outcome:already_satisfied -->：已核实当前仓库满足任务要求且无需修改任何文件。",
    "<!-- coding-agent-outcome:completed -->：要求的代码修改已经全部完成，可以进入校验。",
    "不要把一次对话结束当作实现完成。无法确定时必须使用 needs_input。"
].join("\n");
export function parseImplementationDecision(texts) {
    const candidates = [...texts].map((text) => text.trim()).filter(Boolean).reverse();
    for (const text of candidates) {
        const marker = text.match(outcomeMarker)?.[1];
        if (marker)
            return { outcome: marker, content: text.replace(outcomeMarker, "").trim() };
        const start = text.lastIndexOf("{");
        const end = text.lastIndexOf("}");
        if (start >= 0 && end > start) {
            try {
                const value = JSON.parse(text.slice(start, end + 1));
                if (["needs_input", "already_satisfied", "completed"].includes(value.outcome ?? "")) {
                    return {
                        outcome: value.outcome,
                        content: String(value.summary || value.question || text).trim()
                    };
                }
            }
            catch { /* Compatibility fallback for agents that return natural language. */ }
        }
    }
    for (const content of candidates) {
        if (/(?:需要|请)(?:你|您)?(?:补充|提供|确认|说明|澄清)|信息(?:不足|缺失|不完整)|无法(?:开始|继续|确定)|等待(?:你|您)?(?:回复|确认)|before I can (?:start|continue|proceed)|(?:need|require)(?:s|ed)? (?:more |additional )?(?:information|details|requirements|clarification)|could you (?:share|provide|clarify|confirm)|acceptance criteria (?:appears? )?(?:empty|missing)/i.test(content)) {
            return { outcome: "needs_input", content };
        }
    }
    for (const content of candidates) {
        if (/(?:该任务|当前代码|代码|仓库)?(?:已经|已)(?:满足|实现)(?:任务|需求|要求)|无需(?:任何)?(?:代码)?修改|无需改动|already satisfied|no (?:code )?changes? (?:are )?required/i.test(content)) {
            return { outcome: "already_satisfied", content };
        }
    }
    return { outcome: "unknown", content: candidates[0] ?? "" };
}
export function nextStepForImplementation(outcome, changedFileCount) {
    if (outcome === "needs_input")
        return "await_input";
    if (outcome === "already_satisfied" && changedFileCount === 0)
        return "complete_without_changes";
    if (outcome === "completed" && changedFileCount > 0)
        return "validate";
    return "await_confirmation";
}
export function nextStepForPlan(outcome, changedFileCount) {
    return outcome === "already_satisfied" && changedFileCount === 0
        ? "complete_without_changes"
        : "await_plan_approval";
}
export function isExplicitNoChangeCompletionRequest(message) {
    const normalized = message.trim().replace(/\s+/g, " ");
    const noWorkRequested = /(?:什么|任何事情|任何东西|任何)?都?(?:不用|不需要|无需|不要)(?:再)?(?:做|进行)?(?:任何)?(?:改|修改|改动|处理|操作|实现)?|(?:nothing|no changes?|no modifications?|no work)\s+(?:(?:is|are)\s+)?(?:needed|required|necessary)|don['’]?t (?:change|modify|do) anything/i.test(normalized);
    const completionRequested = /(?:直接|就)(?:完成|结束)|(?:可以|请)?(?:完成|结束|关闭)(?:这个|该)?任务|(?:complete|finish|close|end)(?:\s+this|\s+the)?\s+task/i.test(normalized);
    return noWorkRequested && completionRequested;
}
//# sourceMappingURL=task-readiness.js.map