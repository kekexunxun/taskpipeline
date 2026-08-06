import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentProfile } from "@coding-agent/core";
import { api } from "../api";

export type AgentsSnapshot = {
  agents: AgentProfile[];
  loading: boolean;
  refresh(): Promise<void>;
};

/**
 * 全局 Agent 列表 hook。
 *
 * - 挂载时自动拉一次（保证 SettingsDialog 之外的使用方也能立即拿到数据）。
 * - 暴露 `refresh()`，由上层在 Agent 增删改/导入导出/仓库删除等场景手动触发，
 *   替代之前在每个组件里手写 `setAgents(await api.listAgents())` 的模式。
 * - 失败时静默保留旧数据，避免一次抖动把已经展示的列表清空。
 */
export function useAgents(): AgentsSnapshot {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      setAgents(await api.listAgents());
    } catch {
      // 静默失败，保留旧数据
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { agents, loading, refresh };
}
