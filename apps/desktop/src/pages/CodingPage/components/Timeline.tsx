import { useEffect, useRef } from "react";
import { Activity, Bot, Code2, FileDiff, MessageSquareText, Shield, Terminal, X } from "lucide-react";
import type { AgentEvent } from "@coding-agent/core";
import { localizedEventTitle } from "../../../utils/status";
import { formatTime } from "../../../utils/format";

export type TimelineItem = AgentEvent | {
  id: string;
  taskId: string;
  kind: AgentEvent["kind"];
  title: string;
  detail?: string;
  createdAt: string;
};

const icons = {
  message: MessageSquareText,
  tool: Code2,
  permission: Shield,
  command: Terminal,
  diff: FileDiff,
  review: Shield,
  error: X,
  status: Activity
} as const;

export function Timeline({ items }: { items: TimelineItem[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  const lastItem = items[items.length - 1];
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "auto", block: "end" }); }, [items.length, lastItem?.detail]);
  return (
    <div className="timeline">
      {items.length === 0 && <div className="empty-timeline"><Bot size={28} /><strong>暂无执行记录</strong></div>}
      {items.map((item) => {
        const Icon = icons[item.kind];
        return (
          <article className={`timeline-item ${item.kind}`} key={item.id}>
            <div className="timeline-icon"><Icon size={14} /></div>
            <div className="timeline-body">
              <div>
                <strong>{localizedEventTitle(item.title)}</strong>
                <time>{formatTime(item.createdAt)}</time>
              </div>
              {item.detail && <pre>{item.detail}</pre>}
            </div>
          </article>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
