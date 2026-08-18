import { useEffect, useState } from 'react'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
type UiRequest = {
  id: string
  method: 'confirm' | 'select' | 'input' | 'editor' | 'ask-user'
  title?: string
  message?: string
  options?: string[]
  /** ask-user 富选项（label + description），单问题时使用 */
  optionDetails?: { label: string; description?: string }[]
  /** ask-user 多问题列表 */
  questions?: {
    header: string
    question: string
    options: { label: string; description?: string }[]
  }[]
  placeholder?: string
  prefill?: string
}
/**
 * 执行器 UI 请求对话框。
 *
 * 主进程 pendingUi 是 Map（支持并发等待），渲染进程用队列逐个展示：
 * 并发到达的确认请求排队显示，避免新请求覆盖旧请求导致旧的只能等超时（默认拒绝）。
 * 协议字段以主进程 requestUi 为准：事件带 `id`（响应时回传）与 `title/message/options`。
 */
export function UiRequestDialog() {
  const [queue, setQueue] = useState<UiRequest[]>([])
  const [responding, setResponding] = useState(false)
  const request = queue[0]
  useEffect(() => {
    const ask = (event: Event) => {
      const detail = (event as CustomEvent<UiRequest>).detail
      if (!detail?.id) return
      setQueue((items) => [...items, detail])
    }
    // 任务中止 / 会话结束时清空残留的确认请求（主进程 stopPi 已全部按取消处理）。
    const clear = () => setQueue([])
    window.addEventListener('task:ui-request', ask)
    window.addEventListener('task:ui-clear', clear)
    return () => {
      window.removeEventListener('task:ui-request', ask)
      window.removeEventListener('task:ui-clear', clear)
    }
  }, [])
  const respond = async (response: Record<string, unknown>) => {
    if (!request || responding) return
    setResponding(true)
    try {
      await api.respondTaskUi({ id: request.id, ...response })
    } finally {
      setResponding(false)
      setQueue((items) => items.slice(1))
    }
  }
  if (!request) return null
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void respond({ confirmed: false })
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{request.title ?? '执行器请求'}</DialogTitle>
          <DialogDescription className="max-h-[40vh] overflow-auto break-all whitespace-pre-wrap">
            {request.message ?? '执行器需要你的选择才能继续。'}
          </DialogDescription>
        </DialogHeader>
        {request.method === 'select' && (
          <div className="flex flex-wrap gap-2 px-6 pb-6">
            {request.options?.map((option) => (
              <Button variant="secondary" key={option} onClick={() => void respond({ value: option })}>
                {option}
              </Button>
            ))}
          </div>
        )}
        {request.method === 'ask-user' && (
          <AskUserModalContent key={request.id} request={request} onRespond={respond} />
        )}
        {request.method === 'input' && (
          <div className="px-6 pb-6">
            <InputRequest
              key={request.id}
              placeholder={request.placeholder}
              onSubmit={(value) => void respond({ value })}
            />
          </div>
        )}
        {request.method === 'editor' && (
          <div className="px-6 pb-6">
            <EditorRequest key={request.id} prefill={request.prefill} onSubmit={(value) => void respond({ value })} />
          </div>
        )}
        {request.method === 'confirm' && (
          <DialogFooter>
            <Button variant="secondary" onClick={() => void respond({ confirmed: false })}>
              拒绝
            </Button>
            <Button onClick={() => void respond({ confirmed: true })}>允许</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
function InputRequest({ placeholder, onSubmit }: { placeholder?: string; onSubmit(value: string): void }) {
  const [value, setValue] = useState('')
  return (
    <div className="flex w-full gap-2">
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSubmit(value)
        }}
      />
      <Button disabled={!value.trim()} onClick={() => onSubmit(value)}>
        确认
      </Button>
    </div>
  )
}
function EditorRequest({ prefill, onSubmit }: { prefill?: string; onSubmit(value: string): void }) {
  const [value, setValue] = useState(prefill ?? '')
  return (
    <div className="flex w-full flex-col gap-2">
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={8}
        className="thin-scrollbar w-full resize-y rounded-md border bg-background p-2 font-mono text-xs"
        placeholder="在此编辑内容…"
      />
      <Button disabled={!value.trim()} onClick={() => onSubmit(value)}>
        保存
      </Button>
    </div>
  )
}

/** AskUserQuestion 模态内容：支持单问题（立即响应）和多问题（逐个选择 + 提交）。 */
function AskUserModalContent({
  request,
  onRespond
}: {
  request: UiRequest
  onRespond(response: Record<string, unknown>): void
}) {
  const multiQuestions = request.questions ?? []
  const isMulti = multiQuestions.length > 1
  const [selections, setSelections] = useState<Record<number, string>>({})

  if (isMulti) {
    const allAnswered = multiQuestions.every((_, i) => selections[i] !== undefined)
    return (
      <div className="flex flex-col gap-2 px-6 pb-6">
        {multiQuestions.map((q, qi) => (
          <div key={qi} className="flex items-center gap-2">
            <span className="shrink-0 text-sm font-medium text-muted-foreground">{q.header}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {q.options.map((opt) => {
                const selected = selections[qi] === opt.label
                return (
                  <Button
                    key={opt.label}
                    variant={selected ? 'default' : 'secondary'}
                    className={`h-7 px-2.5 text-sm ${selected ? 'pointer-events-none' : ''}`}
                    onClick={() => setSelections((prev) => ({ ...prev, [qi]: opt.label }))}
                    title={opt.description}
                  >
                    {opt.label}
                  </Button>
                )
              })}
            </div>
          </div>
        ))}
        {allAnswered && (
          <Button
            className="self-end"
            onClick={() => {
              // 多问题：发送 string[]（每个问题的回答按 questions 顺序），
              // 主进程 handleAskUserQuestion 据此构造 answers keyed by question text。
              // allAnswered 保证每个 selections[i] 已赋值，用 ! 断言。
              const answerList = multiQuestions.map((_, i) => selections[i]!)
              onRespond({ value: answerList })
            }}
          >
            提交
          </Button>
        )}
      </div>
    )
  }

  // 单问题：点击选项立即响应
  const singleQ = multiQuestions[0]! // length === 1 分支安全
  const items: { label: string; description?: string }[] =
    request.optionDetails ??
    (multiQuestions.length === 1 ? singleQ.options : (request.options ?? []).map((l) => ({ label: l })))
  return (
    <div className="flex flex-col gap-1.5 px-6 pb-6">
      {items.map((opt) => (
        <Button
          variant="secondary"
          key={opt.label}
          className="h-auto flex-col items-start gap-0.5 px-3 py-2 text-left"
          onClick={() => onRespond({ value: opt.label })}
        >
          <span>{opt.label}</span>
          {opt.description && <span className="text-[11px] text-muted-foreground">{opt.description}</span>}
        </Button>
      ))}
    </div>
  )
}
