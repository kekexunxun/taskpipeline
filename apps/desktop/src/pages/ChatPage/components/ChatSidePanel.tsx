import {
  FileDiffIcon,
  FileEditIcon,
  FilePlusIcon,
  FileXIcon,
  GitBranchIcon,
  Loader2Icon,
  RefreshCwIcon,
  XIcon
} from 'lucide-react'
import type { CSSProperties } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BundledLanguage, ThemedToken } from 'shiki'
import { useChatChangedFiles } from '../hooks/useChatChangedFiles'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { api } from '@/api'
import { highlightCode } from '@/components/ai-elements/code-block'

type ChangedFile = { path: string; status: string }
type DiffContents = { original: string; current: string }

// Shiki uses bitflags for font styles
// oxlint-disable-next-line eslint(no-bitwise)
const isItalic = (fontStyle: number | undefined) => fontStyle && fontStyle & 1
// oxlint-disable-next-line eslint(no-bitwise)
const isBold = (fontStyle: number | undefined) => fontStyle && fontStyle & 2

/**
 * 对话右侧面板：多 Tab 展示。
 * 第一个 Tab「文件变更」基于当前对话 workingDirectory 的 git status。
 */
export function ChatSidePanel({
  workingDirectory,
  streaming,
  onClose
}: {
  workingDirectory?: string
  streaming?: boolean
  onClose?: () => void
}) {
  const [activeTab, setActiveTab] = useState('changes')
  const { files, loading, refresh } = useChatChangedFiles(workingDirectory, streaming)

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l bg-card/50">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex shrink-0 items-center justify-between border-b px-3" style={{ minHeight: '64px' }}>
          <TabsList className="h-auto w-auto shrink-0 justify-start gap-0 rounded-none bg-transparent p-0">
            <TabsTrigger value="changes" className="gap-1.5 text-xs">
              <FileDiffIcon size={12} />
              文件变更
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

        <TabsContent value="changes" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <ChangedFilesContent
            files={files}
            loading={loading}
            onRefresh={refresh}
            workingDirectory={workingDirectory}
          />
        </TabsContent>
      </Tabs>
    </section>
  )
}

function ChangedFilesContent({
  files,
  loading,
  onRefresh,
  workingDirectory
}: {
  files: ChangedFile[]
  loading: boolean
  onRefresh: () => void
  workingDirectory?: string
}) {
  const [selectedFile, setSelectedFile] = useState<ChangedFile | null>(null)
  const [diffContents, setDiffContents] = useState<DiffContents>({ original: '', current: '' })
  const [diffLoading, setDiffLoading] = useState(false)

  const loadDiff = useCallback(
    async (file: ChangedFile) => {
      if (!workingDirectory) return
      setDiffLoading(true)
      try {
        const contents = await api.getFileDiffContents(workingDirectory, file.path, file.status)
        setDiffContents(contents)
      } catch {
        setDiffContents({ original: '', current: '' })
      } finally {
        setDiffLoading(false)
      }
    },
    [workingDirectory]
  )

  const handleFileClick = useCallback(
    (file: ChangedFile) => {
      if (selectedFile?.path === file.path) {
        setSelectedFile(null)
        setDiffContents({ original: '', current: '' })
      } else {
        setSelectedFile(file)
        loadDiff(file)
      }
    },
    [selectedFile, loadDiff]
  )

  useEffect(() => {
    if (selectedFile) {
      loadDiff(selectedFile)
    }
  }, [files, selectedFile, loadDiff])

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
                key={file.path}
                file={file}
                selected={selectedFile?.path === file.path}
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
            <span className="truncate font-mono text-xs text-muted-foreground" title={selectedFile.path}>
              {extractFilename(selectedFile.path)}
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
            {diffLoading ? (
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
              <div className="py-8 text-center text-muted-foreground/50">无变更内容</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function FileItem({ file, selected, onClick }: { file: ChangedFile; selected: boolean; onClick: () => void }) {
  const fileName = extractFilename(file.path)
  const isAdded = file.status.includes('?') || file.status.includes('A')
  const isDeleted = file.status.includes('D')
  const isModified = file.status.includes('M')

  const FileIcon = isAdded ? FilePlusIcon : isDeleted ? FileXIcon : FileEditIcon
  const iconColor = isAdded ? 'text-emerald-500' : isDeleted ? 'text-red-400' : 'text-blue-400'
  const tagText = isAdded ? '新增' : isDeleted ? '删除' : isModified ? '修改' : changeStatusLabel(file.status)
  const tagColor = isAdded
    ? 'bg-emerald-500/10 text-emerald-500'
    : isDeleted
      ? 'bg-red-500/10 text-red-400'
      : 'bg-blue-500/10 text-blue-400'

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
      <span className="min-w-0 flex-1 truncate text-xs text-foreground/80" title={file.path}>
        {fileName}
      </span>
      <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px]', tagColor)}>{tagText}</span>
    </button>
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

function ShikiDiffView({ original, current, filePath }: { original: string; current: string; filePath: string }) {
  const language = useMemo(() => detectLanguage(filePath), [filePath])
  const lineChanges = useMemo(() => computeLineChanges(original, current), [original, current])

  // 使用 Shiki 高亮当前内容
  const rawTokens = useMemo(
    () => current.split('\n').map((line) => (line === '' ? [] : [{ color: 'inherit', content: line } as ThemedToken])),
    [current]
  )

  const [asyncTokens, setAsyncTokens] = useState<{ tokens: ThemedToken[][]; fg: string; bg: string } | null>(null)
  const prevCodeRef = useRef(current)

  // 当内容变化时重置
  if (prevCodeRef.current !== current) {
    prevCodeRef.current = current
    setAsyncTokens(null)
  }

  useEffect(() => {
    let cancelled = false
    const result = highlightCode(current, language, (res) => {
      if (!cancelled) {
        setAsyncTokens({ tokens: res.tokens, fg: res.fg, bg: res.bg })
      }
    })
    // 同步缓存命中
    if (result) {
      setAsyncTokens({ tokens: result.tokens, fg: result.fg, bg: result.bg })
    }
    return () => {
      cancelled = true
    }
  }, [current, language])

  const tokens = asyncTokens?.tokens ?? rawTokens

  return (
    <div className="flex font-mono text-[11px] leading-4">
      {/* 左侧固定列：gutter + 行号 */}
      <div className="sticky left-0 z-10 shrink-0" style={{ backgroundColor: 'var(--muted)' }}>
        {tokens.map((_, lineIdx) => {
          const changeType = lineChanges.get(lineIdx)
          const lineBg =
            changeType === 'added'
              ? 'rgba(34, 197, 94, 0.08)'
              : changeType === 'modified'
                ? 'rgba(251, 191, 36, 0.08)'
                : undefined
          return (
            <div key={lineIdx} className="flex" style={{ backgroundColor: lineBg }}>
              <span className="flex w-5 items-center justify-center select-none">
                {changeType === 'added' && <span className="text-[10px] leading-none text-emerald-500">+</span>}
                {changeType === 'modified' && <span className="text-[10px] leading-none text-amber-400">~</span>}
              </span>
              <span className="w-10 pr-2 text-right text-muted-foreground/40 select-none">{lineIdx + 1}</span>
            </div>
          )
        })}
      </div>
      {/* 右侧代码区：可横向滚动 */}
      <div className="thin-scrollbar min-w-0 flex-1 overflow-x-auto">
        {tokens.map((line, lineIdx) => {
          const changeType = lineChanges.get(lineIdx)
          const lineBg =
            changeType === 'added'
              ? 'rgba(34, 197, 94, 0.08)'
              : changeType === 'modified'
                ? 'rgba(251, 191, 36, 0.08)'
                : undefined
          return (
            <div key={lineIdx} className="whitespace-pre" style={{ backgroundColor: lineBg }}>
              <span className="pr-3 pl-1">
                {line.length === 0
                  ? '\n'
                  : line.map((token, tokenIdx) => (
                      <span
                        key={tokenIdx}
                        style={
                          {
                            color: token.color,
                            fontStyle: isItalic(token.fontStyle) ? 'italic' : undefined,
                            fontWeight: isBold(token.fontStyle) ? 'bold' : undefined
                          } as CSSProperties
                        }
                      >
                        {token.content}
                      </span>
                    ))}
              </span>
            </div>
          )
        })}
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

/** Git 状态码转中文标签。 */
function changeStatusLabel(status: string): string {
  if (status.includes('?')) return '新增'
  if (status.includes('A')) return '新增'
  if (status.includes('D')) return '删除'
  if (status.includes('M')) return '修改'
  if (status.includes('R')) return '重命名'
  if (status.includes('C')) return '复制'
  return status
}
