import { useState } from 'react'
import { BotIcon, DiamondIcon, LightbulbIcon, UserIcon } from 'lucide-react'
import type { TaskDraftFieldKey } from '@task-pipeline/core'
import {
  DRAFT_FIELD_LABELS,
  formatDraftFieldValue,
  type IntakeMessage,
  type PendingDraftSuggestion
} from './draftIntake'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

type Props = {
  messages: IntakeMessage[]
  suggestion?: PendingDraftSuggestion
  /** 一轮澄清在途（那条 IPC 还没回）。这时不给采纳：建议要写的字段正被同一个任务用着。 */
  busy: boolean
  onApply(eventId: string, keys: TaskDraftFieldKey[]): void
  onDiscard(eventId: string): void
}

/**
 * `draft` 的澄清面板：问答记录 + 待采纳建议。
 *
 * 不复用执行流的 `TaskConversationView`：那条链路是 `PartRenderer`，它会把相邻 text part
 * 合并成一段（流式增量需要合并），一问一答会被粘成同一个人说的话。这里的内容也不需要
 * 工具行、子任务卡那套——澄清阶段没有任何动手动作可展示。
 */
export function TaskIntakePanel({ messages, suggestion, busy, onApply, onDiscard }: Props) {
  // 勾选只记「是哪条建议的勾选」：建议一换，下面的 `selected` 自动回到全勾选。
  // 写成 useEffect([suggestion?.eventId]) 既能漏重置也会让人忘掉依赖，派生比副作用便宜。
  const [touched, setTouched] = useState<{ eventId: string; keys: TaskDraftFieldKey[] }>()
  const selected = touched && touched.eventId === suggestion?.eventId ? touched.keys : (suggestion?.keys ?? [])
  const toggleField = (key: TaskDraftFieldKey, on: boolean): void => {
    if (!suggestion) return
    setTouched({
      eventId: suggestion.eventId,
      keys: on ? [...selected, key] : selected.filter((item) => item !== key)
    })
  }

  if (!messages.length && !suggestion) {
    return (
      <div className="flex min-h-44 flex-col items-center justify-center gap-1.5 px-6 text-center text-muted-foreground">
        <BotIcon size={24} />
        <strong className="text-xs">还没有澄清记录</strong>
        <p className="text-[11px] leading-4">描述、验收标准、该在哪些仓库里做，都可以让 Agent 看过代码之后提给你。</p>
      </div>
    )
  }

  return (
    <div className="space-y-2.5 px-5 py-4">
      {messages.map((message) => (
        <div key={message.id} className={`flex gap-2 ${message.me ? 'flex-row-reverse' : ''}`}>
          <span className="mt-1.5 shrink-0 text-muted-foreground">
            {message.me ? <UserIcon size={12} /> : <BotIcon size={12} />}
          </span>
          <div
            className={`max-w-[85%] rounded-lg border px-2.5 py-1.5 text-xs leading-5 whitespace-pre-wrap ${
              message.me ? 'bg-muted/60' : 'bg-card'
            }`}
          >
            {message.text}
          </div>
        </div>
      ))}

      {suggestion ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <LightbulbIcon size={12} className="text-amber-500" />
            Agent 建议补全任务定义
          </div>
          <div className="mt-2 space-y-2">
            {suggestion.keys.map((key) => (
              <label key={key} htmlFor={`draft-field-${key}`} className="flex cursor-pointer items-start gap-2">
                <Checkbox
                  id={`draft-field-${key}`}
                  checked={selected.includes(key)}
                  disabled={busy}
                  aria-label={`采纳${DRAFT_FIELD_LABELS[key]}`}
                  className="mt-1"
                  onCheckedChange={(value) => toggleField(key, value === true)}
                />
                <span className="min-w-0">
                  <span className="block text-[11px] text-muted-foreground">{DRAFT_FIELD_LABELS[key]}</span>
                  <span className="block text-xs leading-5 whitespace-pre-line">
                    {formatDraftFieldValue(key, suggestion)}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="mt-2.5 flex items-center gap-1.5">
            <Button size="sm" disabled={busy || !selected.length} onClick={() => onApply(suggestion.eventId, selected)}>
              采纳勾选项
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDiscard(suggestion.eventId)}>
              全部忽略
            </Button>
          </div>
        </div>
      ) : null}

      {busy && (
        <div className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground">
          <DiamondIcon className="size-3.5 shrink-0 animate-spin" />
          <span>澄清助手正在思考…</span>
        </div>
      )}
    </div>
  )
}
