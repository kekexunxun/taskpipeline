import { Composer } from "@/components/Composer";
import type { ReactNode } from "react";

export function TaskComposer(props: {
  value: string;
  onChange(value: string): void;
  onSend(value: string): void;
  onStop?(): void;
  disabled?: boolean;
  streaming?: boolean;
  placeholder?: string;
  leftSlot?: ReactNode;
}) {
  return <Composer {...props} />;
}
