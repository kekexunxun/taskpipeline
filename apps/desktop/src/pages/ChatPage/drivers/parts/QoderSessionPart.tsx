import { Link2Icon } from "lucide-react";
import type { DriverPart } from "@/api";

/**
 * Qoder `qoder.session` part — Qoder 续接用的 session id。
 * 这是元信息,通常不会单独显眼展示;用一个轻量 badge 形式呈现即可。
 */
export function QoderSessionPart({ part }: { part: Extract<DriverPart, { type: "qoder.session" }> }) {
  return (
    <div className="not-prose my-1 inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
      <Link2Icon size={10} className="text-muted-foreground" />
      <span>session {part.sessionId.slice(0, 12)}</span>
    </div>
  );
}
