import { useQoderStatusContext } from "../hooks/useQoderStatusContext";
import { QoderStatusBar } from "../components/QoderStatusBar";

export function StatusBar() {
  const { status, refreshing, refresh } = useQoderStatusContext();
  if (!status?.enabled) return null;
  return <QoderStatusBar status={status} refreshing={refreshing} onRefresh={() => void refresh()} />;
}
