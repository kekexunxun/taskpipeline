import { useState } from "react";
import type { SessionUsage, Task, TaskCard } from "@coding-agent/core";
import { Activity, Bot } from "lucide-react";
import { formatDuration, formatTokens } from "../../../utils/format";

export function UsageSection({ task, card, model, onChangeModel, modelOptions, running, hasModelSelector }: {
  task?: Task;
  card?: TaskCard;
  model?: string;
  onChangeModel?(value: string | undefined): void;
  modelOptions: Array<{ value: string; displayName: string; isDefault?: boolean; isReasoning?: boolean; priceFactor?: number }>;
  running: boolean;
  hasModelSelector: boolean;
}) {
  const usage: SessionUsage | undefined = task?.sessionUsage ?? card?.sessionUsage;
  const [localModel, setLocalModel] = useState(model);
  return (
    <section className="usage-section">
      <div className="section-title">
        <span><Activity size={13} />会话消耗</span>
        <small>{usage?.provider === "qoder" ? "Qoder" : usage ? "OpenAI-Compatible" : "等待数据"}</small>
      </div>
      {hasModelSelector && modelOptions.length > 0 && (
        <label className="task-model-select">
          <span><Bot size={12} />任务模型</span>
          <select
            value={localModel ?? ""}
            disabled={running || card?.boardColumn === "done" || ["implementing", "reviewing", "delivering"].includes(card?.state ?? "")}
            onChange={(event) => { const next = event.target.value || undefined; setLocalModel(next); onChangeModel?.(next); }}
          >
            <option value="">默认（{modelOptions.find((m) => m.isDefault)?.displayName ?? "Qoder"}）</option>
            {modelOptions.map((m) => <option value={m.value} key={m.value}>{m.displayName}{m.isReasoning ? " · 推理" : ""}{m.priceFactor !== undefined ? ` · ${m.priceFactor}x` : ""}</option>)}
          </select>
        </label>
      )}
      {usage ? (
        <div className="usage-grid">
          <span><small>总 Token</small><b>{formatTokens(usage.totalTokens)}</b></span>
          <span><small>输入</small><b>{formatTokens(usage.inputTokens)}</b></span>
          <span><small>输出</small><b>{formatTokens(usage.outputTokens)}</b></span>
          {usage.costUsd !== undefined && <span><small>费用</small><b>${usage.costUsd.toFixed(usage.costUsd < 0.01 ? 4 : 2)}</b></span>}
          {usage.cacheReadTokens > 0 && <span><small>缓存读取</small><b>{formatTokens(usage.cacheReadTokens)}</b></span>}
          {usage.cacheWriteTokens > 0 && <span><small>缓存写入</small><b>{formatTokens(usage.cacheWriteTokens)}</b></span>}
          {usage.durationMs !== undefined && <span><small>耗时</small><b>{formatDuration(usage.durationMs)}</b></span>}
          {usage.turns !== undefined && <span><small>轮次</small><b>{usage.turns}</b></span>}
        </div>
      ) : (
        <div className="overview-empty">执行器返回用量后将在这里显示</div>
      )}
    </section>
  );
}
