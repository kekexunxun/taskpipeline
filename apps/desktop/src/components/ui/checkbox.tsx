import * as React from 'react'
import { CheckIcon, MinusIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

export type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked'> & {
  checked?: boolean | 'indeterminate'
  onCheckedChange?(checked: boolean | 'indeterminate'): void
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, checked = false, onCheckedChange, disabled, ...props }, ref) => {
    const indeterminate = checked === 'indeterminate'
    const isOn = checked === true
    return (
      <span
        className={cn(
          'relative inline-grid size-3.5 shrink-0 place-items-center rounded border transition-colors',
          isOn && 'border-input bg-input text-foreground',
          !isOn && !indeterminate && 'border-input bg-background',
          indeterminate && 'border-input bg-input/70 text-foreground',
          disabled && 'cursor-not-allowed opacity-50',
          className
        )}
        aria-disabled={disabled || undefined}
      >
        <input
          ref={ref}
          type="checkbox"
          className="absolute inset-0 cursor-pointer opacity-0"
          checked={isOn}
          disabled={disabled}
          onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
          {...props}
        />
        {indeterminate ? (
          <MinusIcon size={10} strokeWidth={3} />
        ) : isOn ? (
          <CheckIcon size={10} strokeWidth={3} />
        ) : null}
      </span>
    )
  }
)
Checkbox.displayName = 'Checkbox'
