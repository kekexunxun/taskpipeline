export type ImplementationOutcome = "needs_input" | "already_satisfied" | "completed" | "unknown";
export type ImplementationNextStep = "await_input" | "complete_without_changes" | "validate" | "await_confirmation";
export type PlanNextStep = "complete_without_changes" | "await_plan_approval";

export type ImplementationDecision = {
  outcome: ImplementationOutcome;
  content: string;
};

const outcomeMarker = /<!--\s*task-pipeline-outcome:(needs_input|already_satisfied|completed)\s*-->/i;

export const implementationOutcomeInstruction = [
  "本轮结束前必须明确当前执行结果，并在最终回复最后一行输出且只输出以下标记之一：",
  "<!-- task-pipeline-outcome:needs_input -->：信息不足、存在阻塞、需要用户回答，或实现尚未完成；即使已经修改了部分文件也使用此项。",
  "<!-- task-pipeline-outcome:already_satisfied -->：已核实当前仓库满足任务要求且无需修改任何文件。",
  "<!-- task-pipeline-outcome:completed -->：要求的代码修改已经全部完成，可以进入校验。",
  "不要把一次对话结束当作实现完成。无法确定时必须使用 needs_input。"
].join("\n");

export function parseImplementationDecision(texts: string[]): ImplementationDecision {
  // 先把流式增量片段按顺序拼成完整文本再解析(兼容消息粒度与 delta 碎片粒度):
  // outcome marker 或 JSON 可能横跨多条碎片,逐条解析会漏判,导致实现结果被误判。
  const full = texts.join("").trim();
  const marker = full.match(outcomeMarker)?.[1] as Exclude<ImplementationOutcome, "unknown"> | undefined;
  if (marker) return { outcome: marker, content: full.replace(outcomeMarker, "").trim() };

  const start = full.lastIndexOf("{");
  const end = full.lastIndexOf("}");
  let parsedValue: { outcome?: string; summary?: string; question?: string } | undefined;
  if (start >= 0 && end > start) {
    try {
      parsedValue = JSON.parse(full.slice(start, end + 1));
    } catch {
      // 模型常见瑕疵:尾逗号。修复后重试。
      try {
        parsedValue = JSON.parse(full.replace(/,\s*([}\]])/g, "$1").slice(start, end + 1));
      } catch { /* fall through to natural-language heuristics */ }
    }
  }
  if (parsedValue && ["needs_input", "already_satisfied", "completed"].includes(parsedValue.outcome ?? "")) {
    return {
      outcome: parsedValue.outcome as Exclude<ImplementationOutcome, "unknown">,
      content: String(parsedValue.summary || parsedValue.question || full).trim()
    };
  }

  if (/(?:需要|请)(?:你|您)?(?:补充|提供|确认|说明|澄清)|信息(?:不足|缺失|不完整)|无法(?:开始|继续|确定)|等待(?:你|您)?(?:回复|确认)|before I can (?:start|continue|proceed)|(?:need|require)(?:s|ed)? (?:more |additional )?(?:information|details|requirements|clarification)|could you (?:share|provide|clarify|confirm)|acceptance criteria (?:appears? )?(?:empty|missing)/i.test(full)) {
    return { outcome: "needs_input", content: full };
  }
  if (/(?:该任务|当前代码|代码|仓库)?(?:已经|已)(?:满足|实现)(?:任务|需求|要求)|无需(?:任何)?(?:代码)?修改|无需改动|already satisfied|no (?:code )?changes? (?:are )?required/i.test(full)) {
    return { outcome: "already_satisfied", content: full };
  }
  return { outcome: "unknown", content: full };
}

export function nextStepForImplementation(outcome: ImplementationOutcome, changedFileCount: number): ImplementationNextStep {
  if (outcome === "needs_input") return "await_input";
  if (outcome === "already_satisfied" && changedFileCount === 0) return "complete_without_changes";
  if (outcome === "completed" && changedFileCount > 0) return "validate";
  return "await_confirmation";
}

export function nextStepForPlan(outcome: "changes_required" | "already_satisfied", changedFileCount: number): PlanNextStep {
  return outcome === "already_satisfied" && changedFileCount === 0
    ? "complete_without_changes"
    : "await_plan_approval";
}

export function isExplicitNoChangeCompletionRequest(message: string): boolean {
  const normalized = message.trim().replace(/\s+/g, " ");
  const noWorkRequested = /(?:什么|任何事情|任何东西|任何)?都?(?:不用|不需要|无需|不要)(?:再)?(?:做|进行)?(?:任何)?(?:改|修改|改动|处理|操作|实现)?|(?:nothing|no changes?|no modifications?|no work)\s+(?:(?:is|are)\s+)?(?:needed|required|necessary)|don['’]?t (?:change|modify|do) anything/i.test(normalized);
  const completionRequested = /(?:直接|就)(?:完成|结束)|(?:可以|请)?(?:完成|结束|关闭)(?:这个|该)?任务|(?:complete|finish|close|end)(?:\s+this|\s+the)?\s+task/i.test(normalized);
  return noWorkRequested && completionRequested;
}
