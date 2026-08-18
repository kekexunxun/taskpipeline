/**
 * 对话页面工具调用专用渲染器 —— 按工具类型定制展示样式。
 *
 * - Write: 文件名 + 新增/删除行数
 * - Read: "已查看 xxx" 思考过程风格(悬停箭头,可展开)
 * - Grep: "已检索 n 文件" 思考过程风格(展开查看文件列表与行号)
 * - Bash: 终端卡片(命令 + 状态色 + 展开看结果)
 * - WebFetch: 终端卡片(URL + 查询 + 状态色 + 展开看结果)
 */

import {
  ChevronRightIcon,
  FileEditIcon,
  FileIcon,
  FilePlus2Icon,
  FileXIcon,
  GlobeIcon,
  Loader2Icon,
  PuzzleIcon,
  TerminalIcon
} from 'lucide-react'
import { useState, type ComponentType } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** 序列化工具 output 为可展示字符串。 */
function stringifyOutput(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** 从工具 input 提取指定字符串字段。 */
function getInputField(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>)[field]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 从文件路径提取文件名（兼容 Unix `/` 与 Windows `\` 分隔符）。 */
function extractFilename(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return idx >= 0 ? filePath.slice(idx + 1) : filePath
}

/** 从 output 字符串中尝试提取新增/删除行数。 */
function parseLineStats(output: unknown): { added?: number; deleted?: number } {
  const text = typeof output === 'string' ? output : ''
  // 匹配 "+N" / "-N" 模式(如 diff 格式)
  const addedMatch = text.match(/\+(\d+)/)
  const deletedMatch = text.match(/-(\d+)/)
  if (addedMatch || deletedMatch) {
    return {
      added: addedMatch ? Number(addedMatch[1]) : undefined,
      deleted: deletedMatch ? Number(deletedMatch[1]) : undefined
    }
  }
  return {}
}

/** 计算字符串行数（空字符串返回 0）。 */
function countLines(text: string): number {
  if (!text) return 0
  return text.split('\n').length
}

// === Write 工具 ===

export function WriteToolBlock({
  input,
  output,
  status,
  onApprove
}: {
  input?: unknown
  output?: unknown
  status: 'running' | 'done' | 'error' | 'pending'
  onApprove?: (confirmed: boolean) => void
}) {
  const [manualOpen, setManualOpen] = useState(false)
  const open = status === 'running' || manualOpen
  const filePath = getInputField(input, 'file_path') || getInputField(input, 'path') || ''
  const fileName = extractFilename(filePath)
  const content = getInputField(input, 'content') || ''
  // Write 的行数统计仅依赖 output 解析（无法准确计算整个文件的变更量）
  const { added, deleted } = parseLineStats(output)
  const hasLineStats = added !== undefined || deleted !== undefined
  const outputText = stringifyOutput(output)
  const isPending = status === 'pending' && onApprove

  return (
    <Collapsible open={open} onOpenChange={setManualOpen} className="not-prose w-full">
      <CollapsibleTrigger
        className={cn(
          'group flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-[10px]! transition-colors',
          'hover:bg-muted/30',
          status === 'error' ? 'border-red-500/20 bg-red-500/5' : 'border-border/40 bg-muted/20',
          open && 'rounded-b-none border-b-transparent'
        )}
      >
        <FilePlus2Icon size={13} className={cn('shrink-0', isPending ? 'text-amber-500' : 'text-emerald-500')} />
        <span className="min-w-0 flex-1 truncate font-medium text-muted-foreground/80">{fileName || '写入文件'}</span>
        <span className="shrink-0">
          {isPending ? (
            <span className="inline-flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.preventDefault()
                  onApprove(false)
                }}
                className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
              >
                取消
              </Button>
              <Button
                size="sm"
                onClick={(e) => {
                  e.preventDefault()
                  onApprove(true)
                }}
                className="h-6 px-2 text-xs"
              >
                确认
              </Button>
            </span>
          ) : (
            <>
              {status === 'running' && (
                <span className="inline-flex items-center gap-1 text-amber-500/80">
                  <Loader2Icon size={11} className="animate-spin" />
                  写入中
                </span>
              )}
              {status === 'done' && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-emerald-500/80">已写入</span>
                  {hasLineStats && (
                    <span className="font-mono text-[11px]">
                      {added !== undefined && <span className="text-emerald-500">+{added}</span>}
                      {deleted !== undefined && <span className="ml-0.5 text-red-400">-{deleted}</span>}
                    </span>
                  )}
                </span>
              )}
              {status === 'error' && <span className="text-red-400">失败</span>}
            </>
          )}
        </span>
        {!isPending && (
          <ChevronRightIcon
            size={12}
            className={cn('shrink-0 text-muted-foreground/40 transition-transform', open && 'rotate-90')}
          />
        )}
      </CollapsibleTrigger>
      {(content || outputText) && (
        <CollapsibleContent className="overflow-hidden">
          <div className="max-h-[200px] overflow-y-auto rounded-b-md border border-t-0 border-border/40 bg-muted/10 px-4 py-2">
            {content && (
              <div className="mb-2">
                <div className="mb-1 text-[10px]! font-medium text-muted-foreground/50">写入内容</div>
                <pre className="m-0 font-mono text-[10px] leading-4 break-words whitespace-pre-wrap text-muted-foreground/60">
                  {content}
                </pre>
              </div>
            )}
            {outputText && (
              <div>
                <div className="mb-1 text-[10px]! font-medium text-muted-foreground/50">结果</div>
                <pre className="m-0 font-mono text-[10px] leading-4 break-words whitespace-pre-wrap text-muted-foreground/60">
                  {outputText}
                </pre>
              </div>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

// === Edit 工具(与 Write 同风格) ===

export function EditToolBlock({
  input,
  output,
  status,
  onApprove
}: {
  input?: unknown
  output?: unknown
  status: 'running' | 'done' | 'error' | 'pending'
  onApprove?: (confirmed: boolean) => void
}) {
  const [manualOpen, setManualOpen] = useState(false)
  const open = status === 'running' || manualOpen
  const filePath = getInputField(input, 'file_path') || getInputField(input, 'path') || ''
  const fileName = extractFilename(filePath)
  const oldString = getInputField(input, 'old_string') || ''
  const newString = getInputField(input, 'new_string') || ''
  // 优先从 output 解析，否则根据 old/new 行数自行计算
  const outputStats = parseLineStats(output)
  const added = outputStats.added ?? (newString ? countLines(newString) : undefined)
  const deleted = outputStats.deleted ?? (oldString ? countLines(oldString) : undefined)
  const hasLineStats = added !== undefined || deleted !== undefined
  const outputText = stringifyOutput(output)
  const isPending = status === 'pending' && onApprove

  return (
    <Collapsible open={open} onOpenChange={setManualOpen} className="not-prose w-full">
      <CollapsibleTrigger
        className={cn(
          'group flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-[10px]! transition-colors',
          'hover:bg-muted/30',
          status === 'error' ? 'border-red-500/20 bg-red-500/5' : 'border-border/40 bg-muted/20',
          open && 'rounded-b-none border-b-transparent'
        )}
      >
        <FileEditIcon size={13} className={cn('shrink-0', isPending ? 'text-amber-500' : 'text-blue-500')} />
        <span className="min-w-0 flex-1 truncate font-medium text-muted-foreground/80">{fileName || '编辑文件'}</span>
        <span className="shrink-0">
          {isPending ? (
            <span className="inline-flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.preventDefault()
                  onApprove(false)
                }}
                className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
              >
                取消
              </Button>
              <Button
                size="sm"
                onClick={(e) => {
                  e.preventDefault()
                  onApprove(true)
                }}
                className="h-6 px-2 text-xs"
              >
                确认
              </Button>
            </span>
          ) : (
            <>
              {status === 'running' && (
                <span className="inline-flex items-center gap-1 text-amber-500/80">
                  <Loader2Icon size={11} className="animate-spin" />
                  编辑中
                </span>
              )}
              {status === 'done' && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-blue-500/80">已编辑</span>
                  {hasLineStats && (
                    <span className="font-mono text-[11px]">
                      {added !== undefined && <span className="text-emerald-500">+{added}</span>}
                      {deleted !== undefined && <span className="ml-0.5 text-red-400">-{deleted}</span>}
                    </span>
                  )}
                </span>
              )}
              {status === 'error' && <span className="text-red-400">失败</span>}
            </>
          )}
        </span>
        {!isPending && (
          <ChevronRightIcon
            size={12}
            className={cn('shrink-0 text-muted-foreground/40 transition-transform', open && 'rotate-90')}
          />
        )}
      </CollapsibleTrigger>
      {(oldString || newString || outputText) && (
        <CollapsibleContent className="overflow-hidden">
          <div className="max-h-[200px] overflow-y-auto rounded-b-md border border-t-0 border-border/40 bg-muted/10 px-4 py-2">
            {oldString && (
              <div className="mb-2">
                <div className="mb-1 text-[10px]! font-medium text-red-400/70">删除</div>
                <pre className="m-0 border-l-2 border-red-400/30 pl-2 font-mono text-[10px] leading-4 break-words whitespace-pre-wrap text-red-300/60">
                  {oldString}
                </pre>
              </div>
            )}
            {newString && (
              <div className="mb-2">
                <div className="mb-1 text-[10px]! font-medium text-emerald-400/70">新增</div>
                <pre className="m-0 border-l-2 border-emerald-400/30 pl-2 font-mono text-[10px] leading-4 break-words whitespace-pre-wrap text-emerald-300/60">
                  {newString}
                </pre>
              </div>
            )}
            {outputText && (
              <div>
                <div className="mb-1 text-[10px]! font-medium text-muted-foreground/50">结果</div>
                <pre className="m-0 font-mono text-[10px] leading-4 break-words whitespace-pre-wrap text-muted-foreground/60">
                  {outputText}
                </pre>
              </div>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

// === Read 工具(思考过程风格) ===

export function ReadToolBlock({
  input,
  output,
  status
}: {
  input?: unknown
  output?: unknown
  status: 'running' | 'done' | 'error'
}) {
  const [open, setOpen] = useState(false)
  const filePath = getInputField(input, 'file_path') || getInputField(input, 'path') || ''
  const fileName = extractFilename(filePath)
  const outputText = stringifyOutput(output)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="not-prose w-full">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 py-0.5 text-xs text-muted-foreground/60 transition-colors hover:text-muted-foreground">
        {status === 'running' ? (
          <>
            <Loader2Icon size={13} className="shrink-0 animate-spin text-muted-foreground/90" />
            <span className="text-xs">
              查看中 <span className="text-muted-foreground/80">{fileName || filePath}</span>
            </span>
          </>
        ) : (
          <span className="text-xs">
            已查看 <span className="text-muted-foreground/80">{fileName || filePath}</span>
          </span>
        )}
        <ChevronRightIcon
          size={14}
          className={cn(
            'shrink-0 text-muted-foreground/40 transition-all',
            'opacity-0 group-hover:opacity-100',
            open && 'rotate-90 opacity-100'
          )}
        />
      </CollapsibleTrigger>
      {outputText && (
        <CollapsibleContent className="overflow-hidden">
          <div className="rounded-md bg-muted/30 py-2 pr-3 pl-5">
            <div className="max-h-[120px] overflow-y-auto">
              <pre className="m-0 font-sans text-xs leading-5 break-words whitespace-pre-wrap text-muted-foreground/50">
                {outputText}
              </pre>
            </div>
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

// === Grep 工具(思考过程风格) ===

interface GrepFileEntry {
  filePath: string
  fileName: string
  lines: number[]
}

/** 从 grep output 解析出按文件分组的匹配结果。 */
function parseGrepFiles(output: string): GrepFileEntry[] {
  const fileMap = new Map<string, Set<number>>()

  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    // 匹配 "path/to/file:123:" 格式（跳过 URL 中的端口号）
    const m = line.match(/^(.+?):(\d+):/)
    if (!m) continue
    const [, filePath, lineNum] = m
    if (!filePath || !lineNum) continue
    // 排除 http/https URL 的 host:port 误匹配
    if (/^https?:\/\/[^/]+$/.test(filePath)) continue
    if (!fileMap.has(filePath)) fileMap.set(filePath, new Set())
    fileMap.get(filePath)!.add(Number(lineNum))
  }

  return Array.from(fileMap.entries()).map(([filePath, lines]) => ({
    filePath,
    fileName: extractFilename(filePath),
    lines: [...lines].sort((a, b) => a - b)
  }))
}

export function GrepToolBlock({
  input: _input,
  output,
  status
}: {
  input?: unknown
  output?: unknown
  status: 'running' | 'done' | 'error'
}) {
  const [open, setOpen] = useState(false)
  const outputText = stringifyOutput(output)
  const files = parseGrepFiles(outputText)

  if (files.length === 0 && status !== 'running') return null

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="not-prose w-full">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 py-0.5 text-xs text-muted-foreground/60 transition-colors hover:text-muted-foreground">
        {status === 'running' ? (
          <>
            <Loader2Icon size={13} className="shrink-0 animate-spin text-muted-foreground/50" />
            <span className="text-xs">检索中…</span>
          </>
        ) : (
          <span className="text-xs">
            已检索 <span className="text-muted-foreground/80">{files.length} 文件</span>
          </span>
        )}
        <ChevronRightIcon
          size={14}
          className={cn(
            'shrink-0 text-muted-foreground/40 transition-all',
            'opacity-0 group-hover:opacity-100',
            open && 'rotate-90 opacity-100'
          )}
        />
      </CollapsibleTrigger>
      {files.length > 0 && (
        <CollapsibleContent className="overflow-hidden">
          <div className="rounded-md bg-muted/30 px-2 py-2">
            <div className="max-h-50 overflow-y-auto">
              {files.map((f) => (
                <div key={f.filePath} className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground/50">
                  <FileIcon size={12} className="shrink-0 text-muted-foreground/40" />
                  <span className="shrink-0 font-medium text-muted-foreground/70">{f.fileName}</span>
                  <span className="truncate font-mono text-[11px]">
                    {f.lines.length <= 3
                      ? f.lines.map((l) => `L${l}`).join(', ')
                      : `L${f.lines[0]}, L${f.lines[1]} 等${f.lines.length}处`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

// === MCP 工具(Bash 终端卡片风格) ===

export function McpToolBlock({
  name,
  input,
  output,
  status
}: {
  name: string
  input?: unknown
  output?: unknown
  status: 'running' | 'done' | 'error'
}) {
  const [open, setOpen] = useState(false)
  const outputText = stringifyOutput(output)
  const inputJson = input ? JSON.stringify(input, null, 2) : ''
  // mcp__server__toolname → server:toolname
  const displayName = name.replace(/^mcp__/, '').replace('__', ':') || name

  // TODO 部分MCP工具是Qoder是用来查找本地文件的，后面逐步调整为对应的展示格式

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="not-prose w-full">
      <CollapsibleTrigger
        className={cn(
          'group flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-[10px]! transition-colors',
          'hover:bg-muted/30',
          status === 'error' ? 'border-red-500/20 bg-red-500/5' : 'border-border/40 bg-muted/20',
          open && 'rounded-b-none border-b-transparent'
        )}
      >
        <PuzzleIcon size={13} className="shrink-0 text-muted-foreground/60" />
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground/80">MCP - {displayName}</span>
        <span className="shrink-0">
          {status === 'running' && (
            <span className="inline-flex items-center gap-1 text-amber-500/80">
              <Loader2Icon size={11} className="animate-spin" />
              执行中
            </span>
          )}
          {status === 'done' && <span className="text-emerald-500/80">已完成</span>}
          {status === 'error' && <span className="text-red-400">失败</span>}
        </span>
        <ChevronRightIcon
          size={12}
          className={cn('shrink-0 text-muted-foreground/40 transition-transform', open && 'rotate-90')}
        />
      </CollapsibleTrigger>
      {(inputJson || outputText) && (
        <CollapsibleContent className="overflow-hidden">
          <div className="max-h-[200px] overflow-y-auto rounded-b-md border border-t-0 border-border/40 bg-muted/10 px-4 py-2">
            {inputJson && (
              <div className="mb-2">
                <div className="mb-1 text-[10px]! font-medium text-muted-foreground/50">参数</div>
                <pre className="m-0 font-mono text-[10px] leading-4 break-words whitespace-pre-wrap text-muted-foreground/60">
                  {inputJson}
                </pre>
              </div>
            )}
            {outputText && (
              <div>
                <div className="mb-1 text-[10px]! font-medium text-muted-foreground/50">结果</div>
                <pre className="m-0 font-mono text-[10px] leading-4 break-words whitespace-pre-wrap text-muted-foreground/60">
                  {outputText}
                </pre>
              </div>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

// === Bash 工具(终端卡片风格) ===

export function BashToolBlock({
  input,
  output,
  status,
  icon: Icon = TerminalIcon,
  onApprove
}: {
  input?: unknown
  output?: unknown
  status: 'running' | 'done' | 'error' | 'pending'
  icon?: ComponentType<{ size?: number; className?: string }>
  onApprove?: (confirmed: boolean) => void
}) {
  const [manualOpen, setManualOpen] = useState(false)
  const open = status === 'running' || manualOpen
  const command = getInputField(input, 'command') || ''
  const description = getInputField(input, 'description')
  const outputText = stringifyOutput(output)
  const isPending = status === 'pending' && onApprove

  return (
    <Collapsible open={open} onOpenChange={setManualOpen} className="not-prose w-full">
      <CollapsibleTrigger
        className={cn(
          'group flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-[10px]! transition-colors',
          'hover:bg-muted/30',
          status === 'error' ? 'border-red-500/20 bg-red-500/5' : 'border-border/40 bg-muted/20',
          open && 'rounded-b-none border-b-transparent'
        )}
      >
        <Icon size={13} className={cn('shrink-0', isPending ? 'text-amber-500' : 'text-muted-foreground/60')} />
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground/80">
          {description || command || '执行命令'}
        </span>
        <span className="shrink-0">
          {isPending ? (
            <span className="inline-flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.preventDefault()
                  onApprove(false)
                }}
                className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
              >
                取消
              </Button>
              <Button
                size="sm"
                onClick={(e) => {
                  e.preventDefault()
                  onApprove(true)
                }}
                className="h-6 px-2 text-xs"
              >
                确认
              </Button>
            </span>
          ) : (
            <>
              {status === 'running' && (
                <span className="inline-flex items-center gap-1 text-amber-500/80">
                  <Loader2Icon size={11} className="animate-spin" />
                  执行中
                </span>
              )}
              {status === 'done' && <span className="text-emerald-500/80">已完成</span>}
              {status === 'error' && <span className="text-red-400">失败</span>}
            </>
          )}
        </span>
        {!isPending && (
          <ChevronRightIcon
            size={12}
            className={cn('shrink-0 text-muted-foreground/40 transition-transform', open && 'rotate-90')}
          />
        )}
      </CollapsibleTrigger>
      {(command || outputText) && (
        <CollapsibleContent className="overflow-hidden">
          <div className="max-h-[200px] overflow-y-auto rounded-b-md border border-t-0 border-border/40 bg-muted/10 px-4 py-2">
            {command && (
              <div className="mb-4 font-mono text-[10px] leading-4 text-muted-foreground">
                <span className="select-none">$ </span>
                {command}
              </div>
            )}
            {outputText && (
              <pre className="m-0 font-mono text-[10px] leading-4 break-words whitespace-pre-wrap text-muted-foreground/60">
                {outputText}
              </pre>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

// === WebFetch 工具(终端卡片风格) ===

/** 从 URL 中提取域名用于展示。 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function WebFetchToolBlock({
  input,
  output,
  status
}: {
  input?: unknown
  output?: unknown
  status: 'running' | 'done' | 'error'
}) {
  const [manualOpen, setManualOpen] = useState(false)
  const open = status === 'running' || manualOpen
  const url = getInputField(input, 'url') || ''
  const prompt = getInputField(input, 'prompt')
  const outputText = stringifyOutput(output)
  const domain = extractDomain(url)

  return (
    <Collapsible open={open} onOpenChange={setManualOpen} className="not-prose w-full">
      <CollapsibleTrigger
        className={cn(
          'group flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-[10px]! transition-colors',
          'hover:bg-muted/30',
          status === 'error' ? 'border-red-500/20 bg-red-500/5' : 'border-border/40 bg-muted/20',
          open && 'rounded-b-none border-b-transparent'
        )}
      >
        <GlobeIcon size={13} className="shrink-0 text-muted-foreground/60" />
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground/80">
          {domain || url || '抓取网页'}
        </span>
        <span className="shrink-0">
          {status === 'running' && (
            <span className="inline-flex items-center gap-1 text-amber-500/80">
              <Loader2Icon size={11} className="animate-spin" />
              抓取中
            </span>
          )}
          {status === 'done' && <span className="text-emerald-500/80">已完成</span>}
          {status === 'error' && <span className="text-red-400">失败</span>}
        </span>
        <ChevronRightIcon
          size={12}
          className={cn('shrink-0 text-muted-foreground/40 transition-transform', open && 'rotate-90')}
        />
      </CollapsibleTrigger>
      {(url || prompt || outputText) && (
        <CollapsibleContent className="overflow-hidden">
          <div className="max-h-[300px] overflow-y-auto rounded-b-md border border-t-0 border-border/40 bg-muted/10 px-4 py-2">
            {url && (
              <div className="mb-2 font-mono text-[10px] leading-4 text-muted-foreground">
                <span className="select-none">$ </span>
                {url}
              </div>
            )}
            {prompt && (
              <div className="mb-3">
                <div className="mb-1 text-[10px]! font-medium text-muted-foreground/50">查询</div>
                <pre className="m-0 font-mono text-[10px] leading-4 break-words whitespace-pre-wrap text-muted-foreground/60">
                  {prompt}
                </pre>
              </div>
            )}
            {outputText && (
              <div>
                <div className="mb-1 text-[10px]! font-medium text-muted-foreground/50">结果</div>
                <pre className="m-0 font-mono text-[10px] leading-4 break-words whitespace-pre-wrap text-muted-foreground/60">
                  {outputText}
                </pre>
              </div>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

// === Delete 工具(与 Write/Edit 同风格) ===

export function DeleteToolBlock({
  input,
  status,
  onApprove
}: {
  input?: unknown
  status: 'running' | 'done' | 'error' | 'pending'
  onApprove?: (confirmed: boolean) => void
}) {
  const [manualOpen, setManualOpen] = useState(false)
  const open = status === 'running' || manualOpen
  const filePath = getInputField(input, 'file_path') || getInputField(input, 'path') || ''
  const fileName = extractFilename(filePath)
  const isPending = status === 'pending' && onApprove

  return (
    <Collapsible open={open} onOpenChange={setManualOpen} className="not-prose w-full">
      <CollapsibleTrigger
        className={cn(
          'group flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-[10px]! transition-colors',
          'hover:bg-muted/30',
          'border-red-500/20 bg-red-500/5',
          open && 'rounded-b-none border-b-transparent'
        )}
      >
        <FileXIcon size={13} className={cn('shrink-0', isPending ? 'text-amber-500' : 'text-red-500')} />
        <span className="min-w-0 flex-1 truncate font-medium text-muted-foreground/80">{fileName || '删除文件'}</span>
        <span className="shrink-0">
          {isPending ? (
            <span className="inline-flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.preventDefault()
                  onApprove(false)
                }}
                className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
              >
                取消
              </Button>
              <Button
                size="sm"
                onClick={(e) => {
                  e.preventDefault()
                  onApprove(true)
                }}
                className="h-6 px-2 text-xs"
              >
                确认
              </Button>
            </span>
          ) : (
            <>
              {status === 'running' && (
                <span className="inline-flex items-center gap-1 text-amber-500/80">
                  <Loader2Icon size={11} className="animate-spin" />
                  删除中
                </span>
              )}
              {status === 'done' && <span className="text-red-400">已删除</span>}
              {status === 'error' && <span className="text-red-400">失败</span>}
            </>
          )}
        </span>
        {!isPending && (
          <ChevronRightIcon
            size={12}
            className={cn('shrink-0 text-muted-foreground/40 transition-transform', open && 'rotate-90')}
          />
        )}
      </CollapsibleTrigger>
      {filePath && (
        <CollapsibleContent className="overflow-hidden">
          <div className="rounded-b-md border border-t-0 border-border/40 bg-muted/10 px-4 py-2">
            <div className="mb-1 text-[10px]! font-medium text-muted-foreground/50">文件路径</div>
            <pre className="m-0 font-mono text-[10px] leading-4 break-words whitespace-pre-wrap text-muted-foreground/60">
              {filePath}
            </pre>
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}
