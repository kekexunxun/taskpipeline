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
    compacted.push(item);
  }
  return { items: compacted, hiddenCount };
}

export function Timeline({ items }: { items: TimelineItem[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  const lastItem = items.at(-1);
  const taskId = items[0]?.taskId;
  const [showAll, setShowAll] = useState(false);
  const compacted = useMemo(() => compactTimelineItems(items), [items]);
  const visibleItems = showAll ? items : compacted.items;

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "auto", block: "end" }); }, [visibleItems.length, lastItem?.detail]);
  useEffect(() => { setShowAll(false); }, [taskId]);

  return <div className="px-5 py-4 pb-16">
    {items.length === 0 && <div className="flex min-h-44 flex-col items-center justify-center gap-2 text-muted-foreground"><BotIcon size={24} /><strong className="text-xs">暂无执行记录</strong></div>}
    {items.length > 0 && compacted.hiddenCount > 0 && <div className="mb-3 flex justify-end"><Button size="sm" variant="outline" onClick={() => setShowAll((value) => !value)} title={showAll ? "仅显示摘要" : "显示全部执行事件"}>
      {showAll ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
      {showAll ? "显示摘要" : `显示全部（${items.length}）`}
    </Button></div>}
    {visibleItems.map((item) => { const Icon = icons[item.kind]; return <article className="mb-4 grid grid-cols-[26px_minmax(0,1fr)] gap-2" key={item.id}><div className={cn("grid size-6 place-items-center rounded-full border bg-muted text-muted-foreground", item.kind === "error" && "border-red-500/30 text-red-300")}><Icon size={12} /></div><div className="min-w-0 pt-0.5"><div className="flex items-center justify-between gap-3"><strong className="text-xs font-medium">{localizedEventTitle(item.title)}</strong><time className="shrink-0 text-xs text-muted-foreground">{formatTime(item.createdAt)}</time></div>{item.detail && <pre className="thin-scrollbar mt-1.5 overflow-x-auto whitespace-pre-wrap rounded-md border bg-background p-2 font-mono text-xs leading-4 text-muted-foreground">{item.detail}</pre>}</div></article>; })}
    <div ref={endRef} />
  </div>;
}
