import { XIcon, DollarSignIcon, ClockIcon, CpuIcon, AlertTriangleIcon, BrainIcon } from 'lucide-react'
import type { AgentSpan } from '@task-pipeline/core'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'

const TYPE_LABELS: Record<string, string> = {
  'session.start': '会话开始',
  'task.run': '任务执行',
  'agent.run': 'Agent 运行',
  'llm.generate': 'LLM 调用',
  'tool.execute': '工具调用',
  'subtask.run': '子任务'
}

function formatJson(value: unknown): string {
  if (value === undefined) return '—'
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * LLM span 的输出可能是 { thinking, text } 对象 —— 将 thinking 拆到独立折叠区
 * （默认折叠），text 作为 Completions 主体，避免用户看到未加工的 JSON。
 */
function OutputWithThinking({ span }: { span: AgentSpan }) {
  const outputObj =
    span.output && typeof span.output === 'object' && !Array.isArray(span.output)
      ? (span.output as Record<string, unknown>)
      : undefined
  const thinking = typeof outputObj?.thinking === 'string' && outputObj.thinking ? outputObj.thinking : undefined
  const text =
    typeof outputObj?.text === 'string' && outputObj.text
      ? outputObj.text
      : typeof span.output === 'string' && span.output
        ? span.output
        : undefined
  return (
    <>
      <CollapsibleSection title="Prompt（发送给模型）" defaultOpen>
        <JsonBlock value={span.input} />
      </CollapsibleSection>
      <CollapsibleSection title="Completions（模型返回）" defaultOpen>
        {thinking ? (
          <CollapsibleSection title="思考过程" defaultOpen={false}>
            <div className="flex items-start gap-1.5 rounded-md border border-border/40 bg-muted/20 p-2 text-[10px] leading-5">
              <BrainIcon size={12} className="mt-0.5 shrink-0 text-muted-foreground" />
              <pre className="m-0 font-sans whitespace-pre-wrap">{thinking}</pre>
            </div>
          </CollapsibleSection>
        ) : null}
        {text ? <JsonBlock value={text} /> : <JsonBlock value={span.output} />}
      </CollapsibleSection>
    </>
  )
}

/**
 * 负载详情面板（Payload Inspector）—— 点击瀑布图色块后右侧滑出。
 * 展示 LLM Prompt / Completions、工具参数 / 原始结果、成本与用量标签。
 */
export function PayloadInspector({ span, onClose }: { span: AgentSpan | null; onClose(): void }) {
  if (!span) return null
  const hasError = span.error !== undefined

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l bg-card">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-semibold">{span.name}</span>
            <Badge variant={span.status === 'error' ? 'destructive' : 'outline'} className="px-1 py-0 text-[10px]">
              {span.status}
            </Badge>
          </div>
          <div className="truncate text-[10px] text-muted-foreground">
            {TYPE_LABELS[span.type] ?? span.type} · {span.spanId}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
          <XIcon size={13} />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-[10px] text-muted-foreground tabular-nums">
        <span className="flex items-center gap-1">
          <ClockIcon size={11} />
          {formatDuration(span.durationMs)}
        </span>
        {span.model && (
          <span className="flex items-center gap-1">
            <CpuIcon size={11} />
            {span.model}
          </span>
        )}
        {span.usage?.costUsd !== undefined && (
          <span className="flex items-center gap-1 text-amber-500">
            <DollarSignIcon size={11} />${span.usage.costUsd.toFixed(6)}
          </span>
        )}
        {span.usage && (
          <span>
            ↑{span.usage.inputTokens.toLocaleString()} ↓{span.usage.outputTokens.toLocaleString()} tok
          </span>
        )}
      </div>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
        {hasError && (
          <div className="mb-3 flex items-start gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-300">
            <AlertTriangleIcon size={13} className="mt-0.5 shrink-0" />
            <div className="min-w-0 break-all">{span.error?.message ?? '执行失败'}</div>
          </div>
        )}

        {span.type === 'llm.generate' ? (
          <OutputWithThinking span={span} />
        ) : (
          <>
            <CollapsibleSection title="输入参数" defaultOpen>
              <JsonBlock value={span.input} />
            </CollapsibleSection>
            <CollapsibleSection title="原始结果" defaultOpen>
              <JsonBlock value={span.output} />
            </CollapsibleSection>
          </>
        )}

        {span.meta && Object.keys(span.meta).length > 0 && (
          <CollapsibleSection title="元信息" defaultOpen={false}>
            <JsonBlock value={span.meta} />
          </CollapsibleSection>
        )}
      </div>
    </aside>
  )
}

function CollapsibleSection({
  title,
  defaultOpen,
  children
}: {
  title: string
  defaultOpen: boolean
  children: React.ReactNode
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="mb-2">
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[11px] font-medium hover:bg-accent/60">
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function JsonBlock({ value }: { value: unknown }) {
  if (value === undefined) return <div className="px-2 py-1 text-[10px] text-muted-foreground">无数据</div>
  const text = formatJson(value)
  return (
    <pre className="thin-scrollbar max-h-72 overflow-auto rounded-md border bg-background p-2 font-mono text-[10px] leading-relaxed break-all whitespace-pre-wrap">
      {text}
    </pre>
  )
}
