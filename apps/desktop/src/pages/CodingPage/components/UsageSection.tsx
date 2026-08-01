import type { SessionUsage, Task, TaskCard } from "@coding-agent/core";
import { ActivityIcon, BotIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDuration, formatTokens } from "@/utils/format";
import { ChatModelSelector } from "../../ChatPage/components/ChatModelSelector";
import type { ChatModelGroup } from "../../../api";

export function UsageSection({ task, card, model, onChangeModel, modelGroups, running, hasModelSelector }: { task?: Task; card?: TaskCard; model?: string; onChangeModel?(value: string | undefined): void; modelGroups: ChatModelGroup[]; running: boolean; hasModelSelector: boolean }) {
  const usage: SessionUsage | undefined = task?.sessionUsage ?? card?.sessionUsage; const locked = running || card?.boardColumn === "done" || ["implementing", "reviewing", "delivering"].includes(card?.state ?? "");
  const stats = usage ? [["总 Token", formatTokens(usage.totalTokens)], ["输入", formatTokens(usage.inputTokens)], ["输出", formatTokens(usage.outputTokens)], ...(usage.costUsd !== undefined ? [["费用", `$${usage.costUsd.toFixed(usage.costUsd < .01 ? 4 : 2)}`]] : []), ...(usage.durationMs !== undefined ? [["耗时", formatDuration(usage.durationMs)]] : []), ...(usage.turns !== undefined ? [["轮次", String(usage.turns)]] : [])] : [];
  return <section className="border-b px-5 py-3"><div className="mb-2 flex items-center justify-between text-xs font-semibold text-muted-foreground"><span className="flex items-center gap-1.5"><ActivityIcon size={12} />会话消耗</span><Badge variant="outline">{usage?.provider === "qoder" ? "Qoder" : usage ? "OpenAI-Compatible" : "等待数据"}</Badge></div>{hasModelSelector && modelGroups.length > 0 && <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground"><span className="flex items-center gap-1"><BotIcon size={11} />任务模型</span><ChatModelSelector groups={modelGroups} value={model} disabled={locked} onChange={(value) => onChangeModel?.(value)} /></div>}{usage ? <div className="grid grid-cols-4 gap-2">{stats.map(([label, value]) => <span className="min-w-0" key={label}><small className="block text-xs text-muted-foreground">{label}</small><b className="block truncate font-mono text-xs text-foreground">{value}</b></span>)}</div> : <div className="text-xs text-muted-foreground">执行器返回用量后将在这里显示</div>}</section>;
}
