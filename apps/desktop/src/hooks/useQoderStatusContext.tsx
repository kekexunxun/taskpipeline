import { createContext, useContext } from "react";
import type { QoderStatusSnapshot } from "./useQoderStatus";

const QoderStatusContext = createContext<QoderStatusSnapshot | null>(null);

export const QoderStatusProvider = QoderStatusContext.Provider;

export function useQoderStatusContext(): QoderStatusSnapshot {
  const value = useContext(QoderStatusContext);
  if (!value) throw new Error("useQoderStatusContext must be used inside <QoderStatusProvider>");
  return value;
}
