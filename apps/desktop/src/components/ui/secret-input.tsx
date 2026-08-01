import * as React from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const CONFIGURED = "__configured__";

export const SecretInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, value, onChange, placeholder, "aria-label": ariaLabel, ...props }, ref) => {
  const [visible, setVisible] = React.useState(false);
  const configured = value === CONFIGURED;
  const actualValue = configured ? "" : value;
  const canReveal = typeof actualValue === "string" && actualValue.length > 0;
  return <div className="relative">
    <input ref={ref} {...props} aria-label={ariaLabel} type={visible && canReveal ? "text" : "password"} value={actualValue} placeholder={configured ? "已配置，输入新值覆盖" : placeholder} onChange={onChange} className={cn("h-7 w-full rounded-md border border-border/80 bg-background px-2.5 pr-9 text-xs text-foreground placeholder:text-muted-foreground focus:border-foreground/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50", className)} />
    <button type="button" tabIndex={canReveal ? 0 : -1} disabled={!canReveal} aria-label={visible ? `隐藏${ariaLabel ?? "密钥"}` : `显示${ariaLabel ?? "密钥"}`} className="absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-30" onClick={() => setVisible((current) => !current)}>{visible ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}</button>
  </div>;
});
SecretInput.displayName = "SecretInput";
