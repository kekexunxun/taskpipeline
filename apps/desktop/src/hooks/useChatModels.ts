import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ChatModelGroup } from "../api";

export type ChatModelsSnapshot = {
  modelGroups: ChatModelGroup[];
  loading: boolean;
  refresh(): Promise<void>;
};

export function useChatModels(): ChatModelsSnapshot {
  const [modelGroups, setModelGroups] = useState<ChatModelGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const groups = await api.listChatModels();
      setModelGroups(groups);
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

  return { modelGroups, loading, refresh };
}
