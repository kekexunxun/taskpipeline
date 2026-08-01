import type { HTMLAttributes, LabelHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Field({
  className,
  label,
  children,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement> & {
  label?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <label
      className={cn("grid gap-1.5 text-xs text-muted-foreground", className)}
      {...props}
    >
      {label && <span className="text-xs font-medium text-foreground/80">{label}</span>}
      {children}
    </label>
  );
}

export function FieldGroup({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid gap-3", className)} {...props} />;
}
