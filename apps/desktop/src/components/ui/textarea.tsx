import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
      <textarea
        className={cn(
          "flex min-h-[60px] text-foreground w-full rounded-md border border-border/80 bg-background px-2.5 py-1.5 text-xs leading-5 placeholder:text-muted-foreground focus:border-foreground/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
