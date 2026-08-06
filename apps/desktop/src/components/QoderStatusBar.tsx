import { AlertCircleIcon, CircleDotIcon, RefreshCwIcon } from "lucide-react";
import type { QoderStatus } from "../api";
import { formatTokens } from "../utils/format";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function QoderStatusBar({ status, refreshing, onRefresh }: { status: QoderStatus; refreshing: boolean; onRefresh(): void }) {
  const quotaUsed = status.usage?.userQuota?.used ?? status.usage?.orgResourcePackage?.used;
  const quotaTotal = status.usage?.userQuota?.total ?? status.usage?.orgResourcePackage?.cap;
  const quotaUnit = status.usage?.userQuota?.unit ?? status.usage?.orgResourcePackage?.unit;
  const percentage = status.usage?.totalUsagePercentage ?? status.usage?.userQuota?.percentage;
  const tier = status.account?.subscriptionType ?? status.usage?.userType ?? "Qoder";
  const defaultModel = status.models.find((model) => model.isDefault)?.displayName;
  const hasError = !status.connected && status.error;
  return (
    <footer className="flex h-[26px] min-w-0 items-center gap-3 overflow-hidden border-t bg-card/80 px-2 text-xs text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden">
        {hasError ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0 cursor-help items-center gap-1 text-amber-400">
                <AlertCircleIcon size={10} />Qoder 连接异常
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-xs">{status.error}</TooltipContent>
          </Tooltip>
        ) : (
          <span className={cn("inline-flex shrink-0 items-center gap-1", status.connected ? "text-emerald-400" : "text-muted-foreground")}>
            <CircleDotIcon size={10} />{status.connected ? status.running ? "Qoder 执行中" : "Qoder 已连接" : "Qoder 未连接"}
          </span>
        )}
        <span className="shrink-0">档位 <b className="text-foreground">{tier}</b></span>
        {defaultModel && <span className="shrink-0">默认模型 <b className="text-foreground">{defaultModel}</b></span>}
        {quotaUsed !== undefined && (
          <span className="shrink-0">用量 <b className="text-foreground">{formatTokens(quotaUsed)}{quotaTotal !== undefined ? ` / ${formatTokens(quotaTotal)}` : ""}{quotaUnit ? ` ${quotaUnit}` : ""}</b></span>
        )}
        {percentage !== undefined && (
          <>
            <span className="h-1 w-20 overflow-hidden rounded-full bg-muted"><i className="block h-full bg-emerald-400" style={{ width: `${Math.min(100, Math.max(0, percentage))}%` }} /></span>
            <span><b className="text-foreground">{percentage.toFixed(1)}%</b></span>
          </>
        )}
        {status.usage?.addOnQuota?.remaining !== undefined && <span>加量包剩余 <b>{formatTokens(status.usage.addOnQuota.remaining)}</b></span>}
        {status.usage?.isQuotaExceeded && <span className="text-red-300">配额已用尽</span>}
      </div>
      <Button variant="ghost" size="icon-sm" title={refreshing ? "正在刷新 Qoder 状态" : "刷新 Qoder 状态"} aria-label="刷新 Qoder 状态" disabled={refreshing} onClick={onRefresh}><RefreshCwIcon className={refreshing ? "animate-spin-slow" : ""} size={12} /></Button>
    </footer>
  );
}
