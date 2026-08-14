import { useEffect, useState } from 'react'
import { Shield, ShieldAlert, Zap } from 'lucide-react'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'

export type HitlMode = 'ask' | 'auto' | 'yolo'

type HitlModeSwitcherProps = {
  className?: string
  /** 上下文类型：对话或任务 */
  contextType?: 'conversation' | 'task'
  /** 上下文 ID（对话 ID 或任务 ID） */
  contextId?: string
}

const MODES: { value: HitlMode; label: string; icon: typeof Shield; description: string }[] = [
  { value: 'ask', label: '询问', icon: Shield, description: '所有写操作需确认' },
  { value: 'auto', label: '自动', icon: ShieldAlert, description: '仅危险操作需确认' },
  { value: 'yolo', label: 'YOLO', icon: Zap, description: '自动批准所有操作' }
]

export function HitlModeSwitcher({ className, contextType, contextId }: HitlModeSwitcherProps) {
  const [mode, setMode] = useState<HitlMode>('ask')

  useEffect(() => {
    api
      .getHitlMode(contextType, contextId)
      .then(setMode)
      .catch(() => {})
  }, [contextType, contextId])

  const handleChange = async (newMode: HitlMode) => {
    if (newMode === mode) return
    setMode(newMode)
    await api.setHitlMode(newMode, contextType, contextId)
  }

  return (
    <ButtonGroup className={className}>
      {MODES.map((m) => {
        const Icon = m.icon
        const active = mode === m.value
        return (
          <Button
            key={m.value}
            size="sm"
            variant={active ? 'default' : 'outline'}
            onClick={() => void handleChange(m.value)}
            className="gap-1 px-2 text-[11px]"
            title={m.description}
          >
            <Icon className="size-3" />
            {m.label}
          </Button>
        )
      })}
    </ButtonGroup>
  )
}
