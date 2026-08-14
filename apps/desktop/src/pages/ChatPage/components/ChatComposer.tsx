import type { ReactNode } from 'react'
import { Composer } from '@/components/Composer'

export function ChatComposer(props: {
  value: string
  onChange(value: string): void
  onSend(value: string): void
  onStop?(): void
  disabled?: boolean
  streaming?: boolean
  placeholder?: string
  leftSlot?: ReactNode
  showHitlMode?: boolean
  hitlContextType?: 'conversation' | 'task'
  hitlContextId?: string
}) {
  return <Composer {...props} />
}
