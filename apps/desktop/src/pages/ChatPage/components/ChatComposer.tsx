import type { ReactNode } from 'react'
import { Composer } from '@/components/Composer'
import type { UserFileAttachment } from '@/api'

export function ChatComposer(props: {
  value: string
  onChange(value: string): void
  onSend(value: string, files?: UserFileAttachment[]): void
  onStop?(): void
  disabled?: boolean
  streaming?: boolean
  placeholder?: string
  leftSlot?: ReactNode
  showHitlMode?: boolean
  hitlContextType?: 'conversation' | 'task'
  hitlContextId?: string
  modelSupportsVision?: boolean
  chatId?: string
}) {
  return <Composer {...props} />
}
