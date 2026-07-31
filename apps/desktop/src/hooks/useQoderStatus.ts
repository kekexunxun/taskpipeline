import { useCallback, useEffect, useRef, useState } from "react";
import { api, type QoderStatus } from "../api";

export type QoderStatusSnapshot = {
  status?: QoderStatus;
  refreshing: boolean;
  refresh(): Promise<void>;
};

export function useQoderStatus(): QoderStatusSnapshot {
  const [status, setStatus] = useState<QoderStatus>();
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      setStatus(await api.getQoderStatus());
    } catch (reason) {
      setStatus({ enabled: true, connected: false, running: false, models: [], error: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { status, refreshing, refresh };
}
