import { useState } from 'react'
import { ShieldAlertIcon, CheckIcon, XIcon, MessageCircleQuestionIcon, LockIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * 工具调用 HITL 确认请求（对话板块 / 任务板块共用协议形态）。
 * 字段与主进程 requestUi 事件对齐（main.ts onToolPermission / onPermissionRequest 的 payload）。
 */
export type ChatApprovalRequest = {
  id: string
  method: 'confirm' | 'select' | 'input' | 'editor' | 'ask-user'
  title?: string
  message?: string
  options?: string[]
  /** ask-user 方法的富选项（label + description），单问题时使用 */
  optionDetails?: { label: string; description?: string }[]
  /** ask-user 多问题列表（每个问题含 header/question/options） */
  questions?: {
    header: string
    question: string
    options: { label: string; description?: string }[]
  }[]
  placeholder?: string
  prefill?: string
  timeout?: number
  conversationId?: string
  taskId?: string
  /** 工具名称（用于专用卡片渲染） */
  toolName?: string
  /** 工具输入参数（用于专用卡片渲染） */
  toolInput?: Record<string, unknown>
}

/**
 * 已回答的 AskUserQuestion（保留在对话流中展示已选结果）。
 */
export type AnsweredApproval = {
  id: string
  approval: ChatApprovalRequest
  /** 每个问题的已选标签（questionIndex → option label） */
  selections: Record<number, string>
}

/**
 * 工具调用 HITL 确认卡片（内联卡片风格）。
 *
 * 以对话流内联卡片形式展示确认请求，不阻断用户操作，
 * 用户可在对话流中直接允许/拒绝。
 * 响应走现有 respondTaskUi 通道（与 UiRequestDialog 同一协议）。
 *
 * 只显示操作按钮，工具详情在消息流中已展示，避免重复渲染。
 */
export function ToolApprovalCard({
  approval,
  onRespond,
  widthClass = 'w-[78%]'
}: {
  approval: ChatApprovalRequest
  onRespond(confirmed: boolean): void
  /** 宽度 class，默认 'w-[78%]' 与消息气泡对齐 */
  widthClass?: string
}) {
  // 简洁操作条：只显示工具名 + 确认/取消按钮
  return (
    <div
      className={`flex ${widthClass} items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 dark:border-amber-500/15 dark:bg-amber-500/[0.03]`}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <ShieldAlertIcon size={12} className="shrink-0 text-amber-500" />
        <span className="truncate font-medium">{approval.title ?? '需要确认'}</span>
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onRespond(false)}
          className="h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive"
        >
          <XIcon size={10} className="mr-0.5" />
          拒绝
        </Button>
        <Button size="sm" onClick={() => onRespond(true)} className="h-6 px-2 text-[11px]">
          <CheckIcon size={10} className="mr-0.5" />
          允许
        </Button>
      </div>
    </div>
  )
}

/**
 * AskUserQuestion 内联卡片（对话流内联展示）。
 *
 * agent 向用户提问时，在对话流中以卡片形式展示问题和选项按钮，
 * 用户点击选项后把选择结果反馈给 agent。
 * 支持多问题：questions 数组包含多个问题时，逐一展示，全部选完后提交。
 *
 * 已回答状态（selections 非 undefined）：卡片保留在对话流中，
 * 显示已选结果（带 ✓ 标记），不可再交互。
 */
export function AskUserQuestionCard({
  approval,
  onRespond,
  selections: externalSelections,
  widthClass = 'w-[78%]'
}: {
  approval: ChatApprovalRequest
  onRespond?(value: string | string[]): void
  /** 已回答时的选中结果（传入后卡片进入只读状态） */
  selections?: Record<number, string>
  widthClass?: string
}) {
  const multiQuestions = approval.questions ?? []
  const isMulti = multiQuestions.length > 1
  const isAnswered = externalSelections !== undefined

  // ── 多问题模式：按索引追踪每个问题的选择 ──────────────────────
  // useState 必须在所有条件分支之前调用（React Hooks 规则）
  const [selections, setSelections] = useState<Record<number, string>>({})

  // ── 已回答：只读展示已选结果 ──────────────────────────────────
  if (isAnswered) {
    return <AnsweredCard approval={approval} selections={externalSelections} widthClass={widthClass} />
  }

  if (isMulti) {
    const allAnswered = multiQuestions.every((_, i) => selections[i] !== undefined)
    return (
      <div className={`flex ${widthClass} flex-col gap-3 rounded-md border border-border/40 bg-muted/20 px-3 py-2.5`}>
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <MessageCircleQuestionIcon size={13} className="shrink-0 text-blue-500" />
          <span>{approval.title ?? `${multiQuestions.length} 个问题`}</span>
        </div>
        {multiQuestions.map((q, qi) => (
          <div key={qi} className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-foreground">{q.header}</p>
            {q.question && <p className="text-[11px] text-muted-foreground">{q.question}</p>}
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((opt) => {
                const selected = selections[qi] === opt.label
                return (
                  <Button
                    key={opt.label}
                    variant={selected ? 'secondary' : 'outline'}
                    size="sm"
                    className={`h-auto flex-col items-start gap-0.5 px-2.5 py-1.5 text-[11px] font-normal transition-colors ${
                      selected ? 'pointer-events-none' : 'hover:bg-accent hover:text-accent-foreground'
                    }`}
                    onClick={() => setSelections((prev) => ({ ...prev, [qi]: opt.label }))}
                  >
                    <span>{opt.label}</span>
                    {opt.description && <span className="text-[10px] text-muted-foreground">{opt.description}</span>}
                  </Button>
                )
              })}
            </div>
          </div>
        ))}
        {allAnswered && (
          <Button
            size="sm"
            className="self-end text-[11px]"
            onClick={() => {
              const answerList = multiQuestions.map((_, i) => selections[i]!)
              onRespond?.(answerList)
            }}
          >
            <CheckIcon size={10} className="mr-1" />
            提交
          </Button>
        )}
      </div>
    )
  }

  // ── 单问题模式：点击选项立即响应 ──────────────────────────────
  const details = approval.optionDetails ?? []
  const singleQ = multiQuestions[0]! // length === 1 分支安全
  const items: { label: string; description?: string }[] =
    details.length > 0
      ? details
      : multiQuestions.length === 1
        ? singleQ.options
        : (approval.options ?? []).map((label) => ({ label }))
  const questionText = multiQuestions.length === 1 ? singleQ.question : approval.message

  return (
    <div className={`flex ${widthClass} flex-col gap-2 rounded-md border border-border/40 bg-muted/20 px-3 py-2.5`}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <MessageCircleQuestionIcon size={13} className="shrink-0 text-blue-500" />
        <span className="truncate">{multiQuestions.length === 1 ? singleQ.header : (approval.title ?? '问题')}</span>
      </div>
      {questionText && <p className="text-[11px] leading-relaxed text-muted-foreground">{questionText}</p>}
      <div className="flex flex-wrap gap-1.5">
        {items.map((opt) => (
          <Button
            key={opt.label}
            variant="outline"
            size="sm"
            className="h-auto flex-col items-start gap-0.5 px-2.5 py-1.5 text-[11px] font-normal transition-colors hover:bg-accent hover:text-accent-foreground active:scale-[0.98]"
            onClick={() => onRespond?.(opt.label)}
          >
            <span>{opt.label}</span>
            {opt.description && <span className="text-[10px] text-muted-foreground">{opt.description}</span>}
          </Button>
        ))}
      </div>
    </div>
  )
}

/**
 * 已回答的 AskUserQuestion 只读卡片：显示问题 + 已选结果（带 ✓ 标记）。
 * 纵向堆叠，每个问题一行，已选项带 CheckIcon。
 */
function AnsweredCard({
  approval,
  selections,
  widthClass = 'w-[78%]'
}: {
  approval: ChatApprovalRequest
  selections: Record<number, string>
  widthClass?: string
}) {
  const multiQuestions = approval.questions ?? []

  // 多问题：每个问题分两行（header 一行，已选答案一行），问题间加大间距
  if (multiQuestions.length > 1) {
    return (
      <div className={`flex ${widthClass} flex-col gap-3 rounded-md border border-border/30 bg-muted/10 px-3 py-2.5`}>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <LockIcon size={11} className="shrink-0" />
          <span>{approval.title ?? `${multiQuestions.length} 个问题`}</span>
        </div>
        {multiQuestions.map((q, qi) => (
          <div key={qi} className="flex flex-col gap-0.5">
            <span className="text-[11px] text-muted-foreground">{q.header}</span>
            <span className="inline-flex items-center gap-0.5 text-xs font-medium text-foreground">
              <CheckIcon size={10} className="text-emerald-500" />
              {selections[qi]}
            </span>
          </div>
        ))}
      </div>
    )
  }

  // 单问题：显示 header + 已选标签
  const header = multiQuestions.length === 1 ? multiQuestions[0]!.header : (approval.title ?? '问题')
  const questionText = multiQuestions.length === 1 ? multiQuestions[0]!.question : approval.message

  return (
    <div className={`flex ${widthClass} flex-col gap-1 rounded-md border border-border/30 bg-muted/10 px-3 py-2`}>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <LockIcon size={11} className="shrink-0" />
        <span className="truncate">{header}</span>
      </div>
      {questionText && <p className="text-[11px] text-muted-foreground">{questionText}</p>}
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-foreground">
        <CheckIcon size={11} className="text-emerald-500" />
        {selections[0]}
      </span>
    </div>
  )
}
