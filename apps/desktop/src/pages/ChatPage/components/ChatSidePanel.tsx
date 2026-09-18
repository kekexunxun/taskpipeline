import {
  FileDiffIcon,
  FileEditIcon,
  FilePlusIcon,
  FileXIcon,
  GitBranchIcon,
  HistoryIcon,
  Loader2Icon,
  RefreshCwIcon,
  XIcon
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BundledLanguage } from 'shiki'
import { useChatChangedFiles } from '../hooks/useChatChangedFiles'
import { changeOperationKind, useConversationChanges, type ConversationChangeFile } from '../conversation-changes'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { fileChangeLabel, fileChangeTagColor, fileChangeIconColor } from '@/utils/status'
import { api, type StoredMessage } from '@/api'
import { CodeBlockContent } from '@/components/ai-elements/code-block'

type ChangedFile = { path: string; status: string; root: string }
type DiffContents = { original: string; current: string }

/**
 * 对话右侧面板：多 Tab 展示。
 * - 「对话变更」：从消息 parts 纯推导本次对话的文件变更（conversation-changes）；
 * - 「工作区变更」：基于当前对话 workingDirectory 的 git status。
 */
export function ChatSidePanel({
  workingDirectory,
  messages,
  streaming,
  onClose
}: {
  workingDirectory?: string
  /** 当前对话的消息列表（「对话变更」Tab 纯推导用）。 */
  messages: StoredMessage[]
  streaming?: boolean
  onClose?: () => void
}) {
  const [activeTab, setActiveTab] = useState('conversation')
  const conversationFiles = useConversationChanges(messages, workingDirectory)
  const { files, loading, refresh } = useChatChangedFiles(workingDirectory, streaming)

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l bg-card/50">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex shrink-0 items-center justify-between border-b px-3" style={{ minHeight: '64px' }}>
          <TabsList className="h-auto w-auto shrink-0 justify-start gap-0 rounded-none bg-transparent p-0">
            <TabsTrigger value="conversation" className="gap-1.5 text-xs!">
              <HistoryIcon size={12} />
              对话变更
              {conversationFiles.length > 0 && (
                <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[10px]">
                  {conversationFiles.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="changes" className="gap-1.5 text-xs!">
              <FileDiffIcon size={12} />
              工作区变更
              {files.length > 0 && (
                <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[10px]">
                  {files.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground/60 hover:text-muted-foreground"
              onClick={onClose}
              title="关闭面板"
            >
              <XIcon size={12} />
            </Button>
          )}
        </div>

        <TabsContent value="conversation" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <ConversationChangesContent
            files={conversationFiles}
            workingDirectory={workingDirectory}
            streaming={streaming}
          />
        </TabsContent>

        <TabsContent value="changes" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <ChangedFilesContent files={files} loading={loading} onRefresh={refresh} />
        </TabsContent>
      </Tabs>
    </section>
  )
}

/** 从文件路径提取目录部分（不含文件名）。 */
function extractDirPath(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return idx >= 0 ? filePath.slice(0, idx) : ''
}

/**
 * 「对话变更」Tab 内容：展示方案与「工作区变更」对齐——
 * 整列去重文件行（文件名 + 浅色目录 + 状态标签，标签按最后一次操作类型推导），
 * 点击文件行在下方展开 git diff（HEAD vs 当前内容），再次点击收起。
 * 文件列表由消息 parts 纯推导（标识「本次对话碰过哪些文件」）。
 * 注意：diff 只在「选中路径变化 / 流式结束」时拉取，messages 流式更新不触发，避免闪屏。
 */
function ConversationChangesContent({
  files,
  workingDirectory,
  streaming
}: {
  files: ConversationChangeFile[]
  workingDirectory?: string
  streaming?: boolean
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [diffContents, setDiffContents] = useState<DiffContents>({ original: '', current: '' })
  const [diffLoading, setDiffLoading] = useState(false)
  // diff 内容归属的文件路径：与当前选中不一致时先显示 loading 而不是旧内容
  const [diffFor, setDiffFor] = useState<string | null>(null)
  const diffReqSeq = useRef(0)
  const selected = files.find((f) => f.path === selectedPath) ?? null

  const loadDiff = useCallback(
    async (path: string) => {
      if (!workingDirectory) return
      const seq = ++diffReqSeq.current
      setDiffLoading(true)
      try {
        // 对话变更的文件统一按「修改」状态取 diff（不依赖 git status）
        const contents = await api.getFileDiffContents(workingDirectory, path, 'M')
        if (seq !== diffReqSeq.current) return
        setDiffContents(contents)
      } catch {
        if (seq !== diffReqSeq.current) return
        setDiffContents({ original: '', current: '' })
      } finally {
        if (seq === diffReqSeq.current) {
          setDiffFor(path)
          setDiffLoading(false)
        }
      }
    },
    [workingDirectory]
  )

  // 仅选中路径变化时拉取 diff（对象身份变化不重拉，流式期间 messages 高频更新不受影响）
  useEffect(() => {
    if (selectedPath) void loadDiff(selectedPath)
  }, [selectedPath, loadDiff])

  // 流式结束后刷新一次当前 diff（AI 可能在流式期间继续改了同一文件）
  const prevStreaming = useRef(streaming)
  useEffect(() => {
    if (prevStreaming.current && !streaming && selectedPath) void loadDiff(selectedPath)
    prevStreaming.current = streaming
  }, [streaming, selectedPath, loadDiff])

  const handleFileClick = useCallback((path: string) => {
    setSelectedPath((prev) => {
      if (prev === path) {
        setDiffFor(null)
        setDiffContents({ original: '', current: '' })
        return null
      }
      return path
    })
  }, [])

  if (!files.length) {
    return <div className="py-4 text-center text-xs text-muted-foreground/50">本次对话暂无文件变更</div>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 文件列表 */}
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="space-y-0.5">
          {files.map((file) => (
            <ChangeFileItem
              key={file.path}
              file={file}
              selected={selectedPath === file.path}
              onClick={() => handleFileClick(file.path)}
            />
          ))}
        </div>
      </div>

      {/* Diff 视图 */}
      {selected && (
        <div className="flex min-h-0 flex-1 flex-col border-t">
          <div className="flex shrink-0 items-center justify-between border-b bg-muted/30 px-3 py-1.5">
            <span className="truncate font-mono text-xs text-muted-foreground" title={selected.displayPath}>
              {selected.displayPath}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-5 w-5 text-muted-foreground/60 hover:text-muted-foreground"
              onClick={() => handleFileClick(selected.path)}
              title="关闭"
            >
              <XIcon size={11} />
            </Button>
          </div>
          <div className="thin-scrollbar min-h-0 flex-1 overflow-auto">
            {diffLoading && diffFor !== selected.path ? (
              <div className="flex h-full items-center justify-center py-8 text-muted-foreground/60">
                <Loader2Icon size={14} className="mr-2 animate-spin" />
                加载中...
              </div>
            ) : diffContents.current || diffContents.original ? (
              <ShikiDiffView original={diffContents.original} current={diffContents.current} filePath={selected.path} />
            ) : (
              <div className="py-8 text-center text-xs text-muted-foreground/50">无变更内容</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** 「对话变更」列表行：与「工作区变更」同款视觉（文件名 + 浅色目录路径 + 状态标签）。 */
function ChangeFileItem({
  file,
  selected,
  onClick
}: {
  file: ConversationChangeFile
  selected: boolean
  onClick: () => void
}) {
  const nonErrorOps = file.operations.filter((op) => op.status !== 'error')
  const lastKind = nonErrorOps.length > 0 ? changeOperationKind(nonErrorOps[nonErrorOps.length - 1]!.tool) : 'edit'
  // 状态标签按最后一次操作类型推导：write=A(新增) / delete=D(删除) / edit=M(修改)
  const status = lastKind === 'write' ? 'A' : lastKind === 'delete' ? 'D' : 'M'
  const Icon = lastKind === 'write' ? FilePlusIcon : lastKind === 'delete' ? FileXIcon : FileEditIcon
  const iconColor = fileChangeIconColor(status)
  const tagText = fileChangeLabel(status)
  const tagColor = fileChangeTagColor(status)
  const fileName = file.displayPath.split('/').filter(Boolean).pop() || file.displayPath
  const dirPath = extractDirPath(file.displayPath)

  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors',
        'hover:bg-muted/40',
        selected && 'bg-muted/60'
      )}
      onClick={onClick}
    >
      <Icon size={13} className={cn('shrink-0', iconColor)} />
      <span className="min-w-0 flex-1 truncate text-xs">
        <span className="text-foreground/80">{fileName}</span>
        {dirPath && <span className="ml-1.5 text-muted-foreground/40">{dirPath}</span>}
      </span>
      <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px]', tagColor)}>{tagText}</span>
    </button>
  )
}

/** 「工作区变更」列表行：文件名 + 浅色目录路径 + 状态标签。 */
function FileItem({ file, selected, onClick }: { file: ChangedFile; selected: boolean; onClick: () => void }) {
  const fileName = extractFilename(file.path)
  const dirPath = [extractRootName(file.root), extractDirPath(file.path)].filter(Boolean).join('/')
  const isAdded = file.status.includes('?') || file.status.includes('A')
  const isDeleted = file.status.includes('D')

  const FileIcon = isAdded ? FilePlusIcon : isDeleted ? FileXIcon : FileEditIcon
  const iconColor = fileChangeIconColor(file.status)
  const tagText = fileChangeLabel(file.status)
  const tagColor = fileChangeTagColor(file.status)

  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors',
        'hover:bg-muted/40',
        selected && 'bg-muted/60'
      )}
      onClick={onClick}
    >
      <FileIcon size={13} className={cn('shrink-0', iconColor)} />
      <span className="min-w-0 flex-1 truncate text-xs">
        <span className="text-foreground/80">{fileName}</span>
        {dirPath && <span className="ml-1.5 text-muted-foreground/40">{dirPath}</span>}
      </span>
      <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px]', tagColor)}>{tagText}</span>
    </button>
  )
}

function ChangedFilesContent({
  files,
  loading,
  onRefresh
}: {
  files: ChangedFile[]
  loading: boolean
  onRefresh: () => void
}) {
  const [selectedFile, setSelectedFile] = useState<ChangedFile | null>(null)
  const [diffContents, setDiffContents] = useState<DiffContents>({ original: '', current: '' })
  const [diffLoading, setDiffLoading] = useState(false)
  // diff 内容归属的文件 key：与当前选中不一致时先显示 loading 而不是旧内容
  const [diffFor, setDiffFor] = useState<string | null>(null)
  const diffReqSeq = useRef(0)
  const loadDiff = useCallback(async (file: ChangedFile) => {
    if (!file.root) return
    const key = fileKey(file)
    const seq = ++diffReqSeq.current
    setDiffLoading(true)
    try {
      const contents = await api.getFileDiffContents(file.root, file.path, file.status)
      if (seq !== diffReqSeq.current) return
      setDiffContents(contents)
    } catch {
      if (seq !== diffReqSeq.current) return
      setDiffContents({ original: '', current: '' })
    } finally {
      if (seq === diffReqSeq.current) {
        setDiffFor(key)
        setDiffLoading(false)
      }
    }
  }, [])

  const handleFileClick = useCallback(
    (file: ChangedFile) => {
      if (selectedFile && fileKey(selectedFile) === fileKey(file)) {
        setSelectedFile(null)
        setDiffFor(null)
        setDiffContents({ original: '', current: '' })
      } else {
        setSelectedFile(file)
      }
    },
    [selectedFile]
  )

  // 仅选中文件变化时拉取 diff；files 列表刷新（流式结束自动刷新）不重拉，避免闪屏
  useEffect(() => {
    if (selectedFile) {
      loadDiff(selectedFile)
    }
  }, [selectedFile, loadDiff])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具栏 */}
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <GitBranchIcon size={11} />
          工作区变更
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-5 w-5 text-muted-foreground/60 hover:text-muted-foreground"
          onClick={onRefresh}
          disabled={loading}
          title="刷新"
        >
          <RefreshCwIcon size={11} className={loading ? 'animate-spin' : ''} />
        </Button>
      </div>

      {/* 文件列表 */}
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {loading && files.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground/60">
            <Loader2Icon size={12} className="animate-spin" />
            <span>加载中...</span>
          </div>
        ) : files.length === 0 ? (
          <div className="py-4 text-center text-xs text-muted-foreground/50">暂无文件变更</div>
        ) : (
          <div className="space-y-0.5">
            {files.map((file) => (
              <FileItem
                key={fileKey(file)}
                file={file}
                selected={!!selectedFile && fileKey(selectedFile) === fileKey(file)}
                onClick={() => handleFileClick(file)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Shiki Git Diff 查看器 */}
      {selectedFile && (
        <div className="flex min-h-0 flex-1 flex-col border-t">
          <div className="flex shrink-0 items-center justify-between border-b bg-muted/30 px-3 py-1.5">
            <span
              className="truncate font-mono text-xs text-muted-foreground"
              title={`${selectedFile.root}/${selectedFile.path}`}
            >
              {[extractRootName(selectedFile.root), selectedFile.path].filter(Boolean).join('/')}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-5 w-5 text-muted-foreground/60 hover:text-muted-foreground"
              onClick={() => {
                setSelectedFile(null)
                setDiffContents({ original: '', current: '' })
              }}
              title="关闭"
            >
              <XIcon size={11} />
            </Button>
          </div>
          <div className="thin-scrollbar min-h-0 flex-1 overflow-auto">
            {diffLoading && diffFor !== fileKey(selectedFile) ? (
              <div className="flex h-full items-center justify-center py-8 text-muted-foreground/60">
                <Loader2Icon size={14} className="mr-2 animate-spin" />
                加载中...
              </div>
            ) : diffContents.current || diffContents.original ? (
              <ShikiDiffView
                original={diffContents.original}
                current={diffContents.current}
                filePath={selectedFile.path}
              />
            ) : (
              <div className="py-8 text-center text-xs text-muted-foreground/50">无变更内容</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ========== Shiki Diff View ==========

/** 根据文件扩展名推断 Shiki 语言标识。 */
function detectLanguage(filePath: string): BundledLanguage {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const langMap: Record<string, BundledLanguage> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    svg: 'xml',
    sql: 'sql',
    graphql: 'graphql',
    toml: 'toml',
    ini: 'ini',
    dockerfile: 'dockerfile',
    dockerignore: 'shell'
  }
  return langMap[ext] || ('text' as BundledLanguage)
}

/** 简易行级 diff：对比 original 和 current 的行，返回每行的变更状态。 */
function computeLineChanges(original: string, current: string): Map<number, 'added' | 'modified'> {
  const originalLines = original.split('\n')
  const currentLines = current.split('\n')
  const changes = new Map<number, 'added' | 'modified'>()

  // 新增文件：所有行都是 added
  if (!original) {
    for (let i = 0; i < currentLines.length; i++) {
      changes.set(i, 'added')
    }
    return changes
  }

  // 使用 LCS 算法的简化版本来匹配行
  const originalSet = new Set(originalLines.map((l) => l.trimEnd()))

  for (let i = 0; i < currentLines.length; i++) {
    const currentLine = currentLines[i]!.trimEnd()
    if (!originalSet.has(currentLine)) {
      // 检查是否是修改（对应位置的原行不同但附近存在相似行）
      const isNearOriginal = i < originalLines.length && originalLines[i]!.trimEnd() !== currentLine
      if (isNearOriginal && i < originalLines.length) {
        changes.set(i, 'modified')
      } else {
        changes.set(i, 'added')
      }
    }
  }

  return changes
}

// 固定代码区行高，便于 gutter 和 gradient 精确对齐
const CODE_LINE_HEIGHT = 18

function ShikiDiffView({ original, current, filePath }: { original: string; current: string; filePath: string }) {
  const language = useMemo(() => detectLanguage(filePath), [filePath])
  const lineChanges = useMemo(() => computeLineChanges(original, current), [original, current])
  const lines = useMemo(() => current.split('\n'), [current])

  // 测量 <code> 顶部偏移（gutter 对齐用）与逐行实际位置（diff 色块用）
  const codeAreaRef = useRef<HTMLDivElement>(null)
  const [prePadding, setPrePadding] = useState(16)
  const [lineRects, setLineRects] = useState<{ top: number; height: number }[]>([])

  useLayoutEffect(() => {
    const el = codeAreaRef.current
    if (!el) return
    const measure = () => {
      const codeEl = el.querySelector('code')
      const relativeDiv = el.firstElementChild as HTMLElement | null
      if (!codeEl || !relativeDiv) return
      const codeTop = codeEl.getBoundingClientRect().top
      const containerTop = relativeDiv.getBoundingClientRect().top
      setPrePadding(codeTop - containerTop)
      // 逐行取实际渲染位置：色块用实体 div 定位，不再依赖固定行高假设。
      // offsetTop 已是相对定位祖先（代码容器）的布局坐标，与 overlay 的 absolute top 同一坐标系，不可再减 containerTop（视口坐标），否则色块会随滚动偏移。
      const lineEls = codeEl.querySelectorAll(':scope > span')
      const rects: { top: number; height: number }[] = []
      for (const lineEl of lineEls) {
        const span = lineEl as HTMLElement
        rects.push({ top: span.offsetTop, height: span.offsetHeight })
      }
      setLineRects(rects)
    }
    measure()
    // shiki 高亮是异步回填的，行内容变化会改变布局，用 ResizeObserver 兜底重测
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [current, language])

  const diffColor = (changeType: 'added' | 'modified') =>
    changeType === 'added' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(251, 191, 36, 0.15)'

  return (
    <div className="flex font-mono text-[10px]!">
      {/* 左侧固定列：gutter + 行号 */}
      <div className="sticky left-0 z-10 shrink-0" style={{ backgroundColor: 'var(--muted)', paddingTop: prePadding }}>
        {lines.map((_, lineIdx) => {
          const changeType = lineChanges.get(lineIdx)
          const lineBg =
            changeType === 'added'
              ? 'rgba(34, 197, 94, 0.15)'
              : changeType === 'modified'
                ? 'rgba(251, 191, 36, 0.15)'
                : undefined
          const borderColor = changeType === 'added' ? '#22c55e' : changeType === 'modified' ? '#f59e0b' : 'transparent'
          return (
            <div
              key={lineIdx}
              className="flex"
              style={{ height: CODE_LINE_HEIGHT, backgroundColor: lineBg, borderLeft: `2px solid ${borderColor}` }}
            >
              <span className="flex w-5 items-center justify-center select-none">
                {changeType === 'added' && <span className="font-bold text-emerald-500">+</span>}
                {changeType === 'modified' && <span className="font-bold text-amber-400">~</span>}
              </span>
              <span
                className="w-10 pr-2 text-right text-muted-foreground/40 select-none"
                style={{ height: CODE_LINE_HEIGHT, lineHeight: `${CODE_LINE_HEIGHT}px` }}
              >
                {lineIdx + 1}
              </span>
            </div>
          )
        })}
      </div>
      {/* 右侧代码区：固定行高 + CodeBlockContent 语法高亮 + 逐行实体色块 overlay（避免 gradient 在行间产生渐变） */}
      <div ref={codeAreaRef} className="thin-scrollbar min-w-0 flex-1 overflow-auto leading-[18px]">
        <div className="relative">
          <CodeBlockContent code={current} language={language} />
          {lines.map((_, i) => {
            const changeType = lineChanges.get(i)
            if (!changeType) return null
            const rect = lineRects[i]
            if (!rect) return null
            return (
              <div
                key={`diff-${i}`}
                className="pointer-events-none absolute inset-x-0"
                style={{ top: rect.top, height: rect.height, backgroundColor: diffColor(changeType) }}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ========== Utils ==========

/** 从文件路径提取文件名。 */
function extractFilename(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return idx >= 0 ? filePath.slice(idx + 1) : filePath
}

/** 取工作区根目录名（末段），用于多文件夹工作区区分文件归属。 */
function extractRootName(root: string): string {
  const trimmed = root.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** 多根目录下 `path` 可能跨仓库重复，用 `root:path` 作为唯一标识。 */
function fileKey(file: ChangedFile): string {
  return `${file.root}:${file.path}`
}
