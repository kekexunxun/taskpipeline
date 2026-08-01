import { useEffect, useRef } from "react";
import { ActivityIcon, BotIcon, Code2Icon, FileDiffIcon, MessageSquareTextIcon, ShieldIcon, TerminalIcon, XIcon } from "lucide-react";
import type { AgentEvent } from "@coding-agent/core";
import { cn } from "@/lib/utils";
import { formatTime } from "@/utils/format";
import { localizedEventTitle } from "@/utils/status";

export type TimelineItem = AgentEvent | { id: string; taskId: string; kind: AgentEvent["kind"]; title: string; detail?: string; createdAt: string };
const icons = { message: MessageSquareTextIcon, tool: Code2Icon, permission: ShieldIcon, command: TerminalIcon, diff: FileDiffIcon, review: ShieldIcon, error: XIcon, status: ActivityIcon } as const;
export function Timeline({ items }: { items: TimelineItem[] }) {
  const endRef = useRef<HTMLDivElement>(null); const lastItem = items.at(-1);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "auto", block: "end" }); }, [items.length, lastItem?.detail]);
  return <div className="px-5 py-4 pb-16">{items.length === 0 && <div className="flex min-h-44 flex-col items-center justify-center gap-2 text-muted-foreground"><BotIcon size={24} /><strong className="text-xs">暂无执行记录</strong></div>}{items.map((item) => { const Icon = icons[item.kind]; return <article className="mb-4 grid grid-cols-[26px_minmax(0,1fr)] gap-2" key={item.id}><div className={cn("grid size-6 place-items-center rounded-full border bg-muted text-muted-foreground", item.kind === "error" && "border-red-500/30 text-red-300")}><Icon size={12} /></div><div className="min-w-0 pt-0.5"><div className="flex items-center justify-between gap-3"><strong className="text-xs font-medium">{localizedEventTitle(item.title)}</strong><time className="shrink-0 text-xs text-muted-foreground">{formatTime(item.createdAt)}</time></div>{item.detail && <pre className="thin-scrollbar mt-1.5 overflow-x-auto whitespace-pre-wrap rounded-md border bg-background p-2 font-mono text-xs leading-4 text-muted-foreground">{item.detail}</pre>}</div></article>; })}<div ref={endRef} /></div>;
}
