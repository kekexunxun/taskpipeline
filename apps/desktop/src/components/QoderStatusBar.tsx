import { CircleDot, RefreshCw } from "lucide-react";
import type { QoderStatus } from "../api";
import { formatTokens } from "../utils/format";

export function QoderStatusBar({ status, refreshing, onRefresh }: { status: QoderStatus; refreshing: boolean; onRefresh(): void }) {
  const quotaUsed = status.usage?.userQuota?.used ?? status.usage?.orgResourcePackage?.used;
  const quotaTotal = status.usage?.userQuota?.total ?? status.usage?.orgResourcePackage?.cap;
  const quotaUnit = status.usage?.userQuota?.unit ?? status.usage?.orgResourcePackage?.unit;
  const percentage = status.usage?.totalUsagePercentage ?? status.usage?.userQuota?.percentage;
  const tier = status.account?.subscriptionType ?? status.usage?.userType ?? "Qoder";
  const defaultModel = status.models.find((model) => model.isDefault)?.displayName;
  return (
    <footer className={`qoder-statusbar ${status.connected ? "connected" : "disconnected"}`}>
      <div className="qoder-status-items">
        <span className="qoder-connection" title={status.error}>
          <CircleDot size={10} />{status.connected ? status.running ? "Qoder 执行中" : "Qoder 已连接" : "Qoder 未连接"}
        </span>
        <span>档位 <b>{tier}</b></span>
        {defaultModel && <span>默认模型 <b>{defaultModel}</b></span>}
        {quotaUsed !== undefined && (
          <span>用量 <b>{formatTokens(quotaUsed)}{quotaTotal !== undefined ? ` / ${formatTokens(quotaTotal)}` : ""}{quotaUnit ? ` ${quotaUnit}` : ""}</b></span>
        )}
        {percentage !== undefined && (
          <>
            <span className="qoder-quota-bar"><i style={{ width: `${Math.min(100, Math.max(0, percentage))}%` }} /></span>
            <span><b>{percentage.toFixed(1)}%</b></span>
          </>
        )}
        {status.usage?.addOnQuota?.remaining !== undefined && <span>加量包剩余 <b>{formatTokens(status.usage.addOnQuota.remaining)}</b></span>}
        {status.usage?.isQuotaExceeded && <span className="quota-warning">配额已用尽</span>}
      </div>
      <button className="qoder-refresh" type="button" title={refreshing ? "正在刷新 Qoder 状态" : "刷新 Qoder 状态"} aria-label="刷新 Qoder 状态" disabled={refreshing} onClick={onRefresh}>
        <RefreshCw className={refreshing ? "spinning" : ""} size={12} />
      </button>
    </footer>
  );
}
