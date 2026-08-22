import {
  ChevronRightIcon,
  FileDiffIcon,
  FileEditIcon,
  FilePlusIcon,
  FileXIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  HistoryIcon,
  Loader2Icon,
  RefreshCwIcon,
  XIcon
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BundledLanguage } from 'shiki'
import { useChatChangedFiles } from '../hooks/useChatChangedFiles'
import {
  changeOperationKind,
  useConversationChanges,
  type ConversationChangeFile,
  type ConversationChangeOperation
} from '../conversation-changes'
import { DeleteToolBlock, EditToolBlock, WriteToolBlock } from '../drivers/parts/ToolBlocks'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { api, type StoredMessage } from '@/api'
import { CodeBlockContent } from '@/components/ai-elements/code-block'

type ChangedFile = { path: string; status: string }
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
          <ConversationChangesContent files={conversationFiles} workingDirectory={workingDirectory} />
        </TabsContent>

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

// ========== File Tree ==========

type FileTreeNode = {
  key: string
  name: string
  isFolder: boolean
  depth: number
  file?: ChangedFile
  convFile?: ConversationChangeFile
  children: FileTreeNode[]
}

/** 将扁平文件路径列表构建为树结构。 */
function buildFileTree<T>(
  files: T[],
  getPath: (file: T) => string,
  getFileNode: (file: T, depth: number) => FileTreeNode
): FileTreeNode[] {
  const root: FileTreeNode[] = []
  const folderMap = new Map<string, FileTreeNode>()

  for (const file of files) {
    const fullPath = getPath(file)
    const parts = fullPath.split('/').filter(Boolean)
    if (parts.length === 0) continue

    let currentPath = ''
    let currentChildren = root

    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i]!
      let folder = folderMap.get(currentPath)
      if (!folder) {
        folder = {
          key: currentPath,
          name: parts[i]!,
          isFolder: true,
          depth: i,
          children: []
        }
        folderMap.set(currentPath, folder)
        currentChildren.push(folder)
      }
      currentChildren = folder.children
    }

    currentChildren.push(getFileNode(file, parts.length - 1))
  }

  const sortNodes = (nodes: FileTreeNode[]): void => {
    nodes.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const node of nodes) {
      if (node.isFolder) sortNodes(node.children)
    }
  }
  sortNodes(root)

  return root
}

/**
 * 「对话变更」Tab 内容：文件以树结构展示，
 * 下方优先展示 git diff 视图（HEAD vs 当前内容）；
 * 当 git 无原始数据时（新文件未提交/首次提交前等），回退展示对话操作记录（ToolBlocks）。
 * 文件列表由消息 parts 纯推导（标识「本次对话碰过哪些文件」）。
 */
function ConversationChangesContent({
  files,
  workingDirectory
}: {
  files: ConversationChangeFile[]
  workingDirectory?: string
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [diffContents, setDiffContents] = useState<DiffContents>({ original: '', current: '' })
  const [diffLoading, setDiffLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // 选中项不存在时回退首个文件，避免流式新增/消失后出现空白态
  const selected = files.find((f) => f.path === selectedPath) ?? files[0] ?? null

  const treeNodes = useMemo(() => {
    // 首次构建时默认展开所有文件夹
    const nodes = buildFileTree(
      files,
      (f) => f.displayPath,
      (f, depth) => ({
        key: f.path,
        name: f.displayPath.split('/').filter(Boolean).pop() || f.displayPath,
        isFolder: false,
        depth,
        convFile: f,
        children: []
      })
    )
    const allFolders = new Set<string>()
    const collect = (ns: FileTreeNode[]) => {
      for (const n of ns) {
        if (n.isFolder) {
          allFolders.add(n.key)
          collect(n.children)
        }
      }
    }
    collect(nodes)
    setExpanded((prev) => {
      if (prev.size === 0) return allFolders
      return prev
    })
    return nodes
  }, [files])

  const toggleFolder = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const loadDiff = useCallback(
    async (file: ConversationChangeFile) => {
      if (!workingDirectory) return
      setDiffLoading(true)
      try {
        // 对话变更的文件统一按「修改」状态取 diff（不依赖 git status）
        const contents = await api.getFileDiffContents(workingDirectory, file.path, 'M')
        setDiffContents(contents)
      } catch {
        setDiffContents({ original: '', current: '' })
      } finally {
        setDiffLoading(false)
      }
    },
    [workingDirectory]
  )

  // 选中文件变化时加载 diff
  useEffect(() => {
    if (selected) {
      loadDiff(selected)
    }
  }, [selected, loadDiff])

  if (!files.length) {
    return <div className="py-4 text-center text-xs text-muted-foreground/50">本次对话暂无文件变更</div>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 文件树 */}
      <div className="thin-scrollbar max-h-[40%] min-h-[72px] shrink-0 overflow-y-auto px-1 py-1">
        {treeNodes.map((node) => (
          <FileTreeNodeItem
            key={node.key}
            node={node}
            selectedPath={selected?.path ?? null}
            expanded={expanded}
            onToggleFolder={toggleFolder}
            onSelectFile={(path) => setSelectedPath(path)}
          />
        ))}
      </div>

      {/* Diff 视图 */}
      {selected && (
        <div className="flex min-h-0 flex-1 flex-col border-t">
          <div className="flex shrink-0 items-center justify-between border-b bg-muted/30 px-3 py-1.5">
            <span className="truncate font-mono text-xs text-muted-foreground" title={selected.displayPath}>
              {selected.displayPath}
            </span>
          </div>
          <div className="thin-scrollbar min-h-0 flex-1 overflow-auto">
            {diffLoading ? (
              <div className="flex h-full items-center justify-center py-8 text-muted-foreground/60">
                <Loader2Icon size={14} className="mr-2 animate-spin" />
                加载中...
              </div>
            ) : diffContents.original ? (
              /* 有 git 基线 → diff 视图 */
              diffContents.current ? (
                <ShikiDiffView
                  original={diffContents.original}
                  current={diffContents.current}
                  filePath={selected.path}
                />
              ) : (
                <div className="py-8 text-center text-xs text-muted-foreground/50">无变更内容</div>
              )
            ) : (
              /* git 无基线（新文件/未提交/首次提交前）→ 回退展示操作记录 */
              <div className="min-h-0 space-y-1.5 overflow-y-auto px-2 py-2">
                {selected.operations
                  .filter((op) => op.status !== 'error')
                  .map((op) => (
                    <OperationBlock key={op.toolCallId} op={op} />
                  ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** 递归渲染文件树节点（文件夹可折叠，文件可点击选中）。 */
function FileTreeNodeItem({
  node,
  selectedPath,
  expanded,
  onToggleFolder,
  onSelectFile
}: {
  node: FileTreeNode
  selectedPath: string | null
  expanded: Set<string>
  onToggleFolder: (key: string) => void
  onSelectFile: (path: string) => void
}) {
  if (node.isFolder) {
    const isOpen = expanded.has(node.key)
    return (
      <div>
        <button
          type="button"
          className="flex w-full items-center gap-1 rounded px-1 py-1 text-left transition-colors hover:bg-muted/40"
          style={{ paddingLeft: `${node.depth * 12 + 4}px` }}
          onClick={() => onToggleFolder(node.key)}
        >
          <ChevronRightIcon
            size={12}
            className={cn('shrink-0 text-muted-foreground/50 transition-transform', isOpen && 'rotate-90')}
          />
          {isOpen ? (
            <FolderOpenIcon size={13} className="shrink-0 text-muted-foreground/70" />
          ) : (
            <FolderIcon size={13} className="shrink-0 text-muted-foreground/70" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-foreground/70">{node.name}</span>
        </button>
        {isOpen && (
          <div>
            {node.children.map((child) => (
              <FileTreeNodeItem
                key={child.key}
                node={child}
                selectedPath={selectedPath}
                expanded={expanded}
                onToggleFolder={onToggleFolder}
                onSelectFile={onSelectFile}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  // 文件节点：对话变更
  if (node.convFile) {
    const file = node.convFile
    const nonErrorOps = file.operations.filter((op) => op.status !== 'error')
    const lastKind = nonErrorOps.length > 0 ? changeOperationKind(nonErrorOps[nonErrorOps.length - 1]!.tool) : 'edit'
    const Icon = lastKind === 'delete' ? FileXIcon : lastKind === 'write' ? FilePlusIcon : FileEditIcon
    const iconColor =
      lastKind === 'delete' ? 'text-red-400' : lastKind === 'write' ? 'text-emerald-500' : 'text-blue-400'

    return (
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-1.5 rounded px-1 py-1 text-left transition-colors hover:bg-muted/40',
          selectedPath === file.path && 'bg-muted/60'
        )}
        style={{ paddingLeft: `${node.depth * 12 + 18}px` }}
        onClick={() => onSelectFile(file.path)}
      >
        <Icon size={13} className={cn('shrink-0', iconColor)} />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground/80" title={file.displayPath}>
          {node.name}
        </span>
      </button>
    )
  }

  // 文件节点：工作区变更
  if (node.file) {
    const file = node.file
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
          'flex w-full items-center gap-1.5 rounded px-1 py-1 text-left transition-colors hover:bg-muted/40',
          selectedPath === file.path && 'bg-muted/60'
        )}
        style={{ paddingLeft: `${node.depth * 12 + 18}px` }}
        onClick={() => onSelectFile(file.path)}
      >
        <FileIcon size={13} className={cn('shrink-0', iconColor)} />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground/80" title={file.path}>
          {node.name}
        </span>
        <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px]', tagColor)}>{tagText}</span>
      </button>
    )
  }

  return null
}

/** 单条操作渲染：pending 映射为 running，复用对话流 ToolBlocks 视觉。 */
function OperationBlock({ op }: { op: ConversationChangeOperation }) {
  const status = op.status === 'pending' ? ('running' as const) : op.status
  const kind = changeOperationKind(op.tool)
  if (kind === 'write') return <WriteToolBlock input={op.input} output={op.output} status={status} />
  if (kind === 'delete') return <DeleteToolBlock input={op.input} status={status} />
  return <EditToolBlock input={op.input} output={op.output} status={status} />
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
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const treeNodes = useMemo(() => {
    const nodes = buildFileTree(
      files,
      (f) => f.path,
      (f, depth) => ({
        key: f.path,
        name: f.path.split('/').filter(Boolean).pop() || f.path,
        isFolder: false,
        depth,
        file: f,
        children: []
      })
    )
    const allFolders = new Set<string>()
    const collect = (ns: FileTreeNode[]) => {
      for (const n of ns) {
        if (n.isFolder) {
          allFolders.add(n.key)
          collect(n.children)
        }
      }
    }
    collect(nodes)
    setExpanded((prev) => {
      if (prev.size === 0) return allFolders
      return prev
    })
    return nodes
  }, [files])

  const toggleFolder = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

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

  const handleFileSelect = useCallback(
    (path: string) => {
      const file = files.find((f) => f.path === path)
      if (!file) return
      if (selectedFile?.path === file.path) {
        setSelectedFile(null)
        setDiffContents({ original: '', current: '' })
      } else {
        setSelectedFile(file)
        loadDiff(file)
      }
    },
    [selectedFile, loadDiff, files]
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

      {/* 文件树 */}
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {loading && files.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground/60">
            <Loader2Icon size={12} className="animate-spin" />
            <span>加载中...</span>
          </div>
        ) : files.length === 0 ? (
          <div className="py-4 text-center text-xs text-muted-foreground/50">暂无文件变更</div>
        ) : (
          treeNodes.map((node) => (
            <FileTreeNodeItem
              key={node.key}
              node={node}
              selectedPath={selectedFile?.path ?? null}
              expanded={expanded}
              onToggleFolder={toggleFolder}
              onSelectFile={handleFileSelect}
            />
          ))
        )}
      </div>

      {/* Shiki Git Diff 查看器 */}
      {selectedFile && (
        <div className="flex min-h-0 flex-1 flex-col border-t">
          <div className="flex shrink-0 items-center justify-between border-b bg-muted/30 px-3 py-1.5">
            <span className="truncate font-mono text-xs text-muted-foreground" title={selectedFile.path}>
              {selectedFile.path}
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

  // 测量 <code> 相对于 overlay 父容器（relative div）的实际顶部偏移
  const codeAreaRef = useRef<HTMLDivElement>(null)
  const [prePadding, setPrePadding] = useState(16)

  useLayoutEffect(() => {
    const el = codeAreaRef.current
    if (!el) return
    const codeEl = el.querySelector('code')
    const relativeDiv = el.firstElementChild as HTMLElement | null
    if (codeEl && relativeDiv) {
      const codeTop = codeEl.getBoundingClientRect().top
      const containerTop = relativeDiv.getBoundingClientRect().top
      setPrePadding(codeTop - containerTop)
    }
  }, [current, language])

  // 构建逐行 gradient：固定行高 + 实际 padding → 精确对齐
  const gradientStops = lines
    .map((_, i) => {
      const changeType = lineChanges.get(i)
      if (!changeType) return null
      const color = changeType === 'added' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(251, 191, 36, 0.15)'
      const top = prePadding + i * CODE_LINE_HEIGHT
      return `${color} ${top}px, ${color} ${top + CODE_LINE_HEIGHT}px`
    })
    .filter(Boolean)
    .join(', ')
  const overlayBg = gradientStops
    ? `linear-gradient(to bottom, transparent ${prePadding}px, ${gradientStops}, transparent ${prePadding + lines.length * CODE_LINE_HEIGHT}px)`
    : undefined

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
      {/* 右侧代码区：固定行高 + CodeBlockContent 语法高亮 + gradient overlay diff 背景色 */}
      <div ref={codeAreaRef} className="thin-scrollbar min-w-0 flex-1 overflow-auto leading-[18px]">
        <div className="relative">
          <CodeBlockContent code={current} language={language} />
          {overlayBg && <div className="pointer-events-none absolute inset-0" style={{ background: overlayBg }} />}
        </div>
      </div>
    </div>
  )
}

// ========== Utils ==========

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
