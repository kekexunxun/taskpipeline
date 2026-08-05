import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIcon, BotIcon, Code2Icon, EyeIcon, EyeOffIcon, FileDiffIcon, MessageSquareTextIcon, ShieldIcon, TerminalIcon, XIcon } from "lucide-react";
import type { AgentEvent } from "@coding-agent/core";
import { cn } from "@/lib/utils";
import { formatTime } from "@/utils/format";
import { localizedEventTitle } from "@/utils/status";
import { Button } from "@/components/ui/button";

export type TimelineItem = AgentEvent | { id: string; taskId: string; kind: AgentEvent["kind"]; title: string; detail?: string; createdAt: string };
const icons = { message: MessageSquareTextIcon, tool: Code2Icon, permission: ShieldIcon, command: TerminalIcon, diff: FileDiffIcon, review: ShieldIcon, error: XIcon, status: ActivityIcon } as const;
const agentMessageTitle = /^(?:qoder agent|openai agent|ai)$/i;
const outcomeMarker = /\n?\s*<!--\s*coding-agent-outcome:(?:needs_input|already_satisfied|completed)\s*-->/gi;

function isAgentMessage(item: TimelineItem): boolean {
  return item.kind === "message" && agentMessageTitle.test(item.title.trim());
}

function mergeAgentText(current: string | undefined, next: string | undefined): string | undefined {
  if (!current) return next;
  if (!next || next === current) return current;
  if (next.startsWith(current)) return next;
  if (current.startsWith(next)) return current;

  const maxOverlap = Math.min(current.length, next.length);
  for (let length = maxOverlap; length >= 24; length -= 1) {
    if (current.endsWith(next.slice(0, length))) return `${current}${next.slice(length)}`;
  }
  return `${current}\n\n${next}`;
}

function visibleDetail(detail: string | undefined): string | undefined {
  const cleaned = detail?.replace(outcomeMarker, "").trim();
  return cleaned || undefined;
}

function duplicateKey(item: TimelineItem): string {
  const title = isAgentMessage(item) ? "agent" : item.title.trim().toLowerCase();
  return `${item.kind}\u0000${title}\u0000${visibleDetail(item.detail) ?? ""}`;
}

export function normalizeTimelineItems(items: TimelineItem[]): TimelineItem[] {
  const sorted = items
    .map((item, index) => ({ item: { ...item, detail: visibleDetail(item.detail) }, index }))
    .sort((left, right) => {
      const byTime = Date.parse(left.item.createdAt) - Date.parse(right.item.createdAt);
      return (Number.isNaN(byTime) ? 0 : byTime) || left.index - right.index;
    });
  const seen = new Map<string, number>();
  return sorted.flatMap(({ item }) => {
    const key = duplicateKey(item);
    const time = Date.parse(item.createdAt);
    const previousTime = seen.get(key);
    if (previousTime !== undefined && Math.abs(time - previousTime) < 5_000) return [];
    seen.set(key, time);
    return [item];
  });
}

function isProtocolStatus(item: TimelineItem): boolean {
  return item.kind === "status" && /^Qoder\s+/i.test(item.title.trim());
}

export function compactTimelineItems(items: TimelineItem[]): { items: TimelineItem[]; hiddenCount: number } {
  const compacted: TimelineItem[] = [];
  let hiddenCount = 0;
  let agentIndex: number | undefined;

  for (const item of items) {
    if (isProtocolStatus(item)) {
      hiddenCount += 1;
      continue;
    }
    if (isAgentMessage(item)) {
      if (agentIndex !== undefined) {
        const previous = compacted[agentIndex]!;
        compacted[agentIndex] = { ...previous, detail: mergeAgentText(previous.detail, item.detail) };
        hiddenCount += 1;
        continue;
      }
      agentIndex = compacted.length;
    } else {
      agentIndex = undefined;
    }
    const previous = compacted.at(-1);
    const repeatsAgentDetail = item.kind === "status" && item.detail && previous && isAgentMessage(previous) && Boolean(previous.detail?.includes(item.detail));
    compacted.push(repeatsAgentDetail ? { ...item, detail: undefined } : item);
  }
  return { items: compacted, hiddenCount };
}

export function Timeline({ items }: { items: TimelineItem[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  const [showAll, setShowAll] = useState(false);
  const normalized = useMemo(() => normalizeTimelineItems(items), [items]);
  const lastItem = normalized.at(-1);
  const taskId = normalized[0]?.taskId;
  const compacted = useMemo(() => compactTimelineItems(normalized), [normalized]);
  const visibleItems = showAll ? normalized : compacted.items;
  const onlyInternalEvents = normalized.length > 0 && compacted.items.length === 0;

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "auto", block: "end" }); }, [visibleItems.length, lastItem?.detail]);
  useEffect(() => { setShowAll(false); }, [taskId]);

  return <div className="px-5 py-4 pb-16">
    {normalized.length === 0 && <div className="flex min-h-44 flex-col items-center justify-center gap-2 text-muted-foreground"><BotIcon size={24} /><strong className="text-xs">暂无执行记录</strong></div>}
    {normalized.length > 0 && compacted.hiddenCount > 0 && <div className="mb-3 flex justify-end"><Button size="sm" variant="outline" onClick={() => setShowAll((value) => !value)} title={showAll ? "仅显示摘要" : "显示全部执行事件"}>
      {showAll ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
      {showAll ? "显示摘要" : `显示全部（${normalized.length}）`}
    </Button></div>}
    {!showAll && onlyInternalEvents && <div className="flex min-h-44 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
      <BotIcon size={24} />
      <strong className="text-xs">暂无执行摘要</strong>
      <span className="text-xs">已折叠 {compacted.hiddenCount} 条内部运行记录，可通过“显示全部”查看</span>
    </div>}
    {visibleItems.map((item) => { const Icon = icons[item.kind]; return <article className="mb-4 grid grid-cols-[26px_minmax(0,1fr)] gap-2" key={item.id}><div className={cn("grid size-6 place-items-center rounded-full border bg-muted text-muted-foreground", item.kind === "error" && "border-red-500/30 text-red-300")}><Icon size={12} /></div><div className="min-w-0 pt-0.5"><div className="flex items-center justify-between gap-3"><strong className="text-xs font-medium">{localizedEventTitle(item.title)}</strong><time className="shrink-0 text-xs text-muted-foreground">{formatTime(item.createdAt)}</time></div>{item.detail && <pre className="thin-scrollbar mt-1.5 overflow-x-auto whitespace-pre-wrap rounded-md border bg-background p-2 font-mono text-xs leading-4 text-muted-foreground">{item.detail}</pre>}</div></article>; })}
    <div ref={endRef} />
  </div>;
}
