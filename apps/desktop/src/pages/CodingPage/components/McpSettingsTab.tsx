/**
 * 系统设置 → MCP Tab
 *
 * 统一管理 dataDir/mcp.json 中的 MCP 服务（内置 gitlab/jira/confluence + 自定义）：
 * - 参考 Qoder 的折叠卡片：标题 / 命令 / 状态徽标 / 工具列表（listTools 结果）/ 启停开关；
 * - 内置服务只读（锁定参数），仅可切换启停；自定义服务可弹窗编辑 / 删除；
 * - 新增/编辑保存后自动初始化（连接 + listTools）验证配置有效性。
 */

import { useEffect, useMemo, useState } from 'react'
import {
  ChevronRightIcon,
  ExternalLinkIcon,
  LockIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  Loader2Icon
} from 'lucide-react'
import { api, type McpServerEntry, type McpServerTestResult } from '@/api'
import { useFeedback } from '@/hooks/useGlobalFeedback'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldGroup } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

/** 单个服务的连接测试状态（初始化/验证）。 */
type McpTestState =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'ok'; tools: Array<{ name: string; description?: string }>; message: string }
  | { state: 'error'; message: string }

function commandLine(server: McpServerEntry): string {
  if (server.transport === 'stdio') return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
  return server.url ?? ''
}

/** KEY=VALUE 每行文本 ⇄ Record。 */
function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = line.match(/^([^=]+)=(.*)$/)
    if (match) out[match[1]!.trim()] = match[2]!.trim()
  }
  return out
}
function stringifyKv(obj?: Record<string, string>): string {
  return Object.entries(obj ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

/** 内置服务展示图标（与对话选择器一致）。 */
function ServerIcon() {
  return (
    <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
      <PlugIcon size={14} />
    </div>
  )
}

/** 状态徽标。 */
function StatusBadge({ test }: { test: McpTestState }) {
  if (test.state === 'testing')
    return (
      <Badge variant="secondary" className="gap-1 text-[9px]">
        <Loader2Icon className="animate-spin-slow" size={9} />
        初始化中…
      </Badge>
    )
  if (test.state === 'ok')
    return (
      <Badge variant="success" className="text-[9px]">
        已连接 {test.tools.length} 工具
      </Badge>
    )
  if (test.state === 'error')
    return (
      <Badge variant="destructive" className="max-w-64 truncate text-[9px]" title={test.message}>
        {test.message}
      </Badge>
    )
  return <Badge variant="muted">未测试</Badge>
}

export function McpSettingsTab() {
  const { showError, showSuccess } = useFeedback()
  const [servers, setServers] = useState<McpServerEntry[]>([])
  const [filePath, setFilePath] = useState('')
  const [loading, setLoading] = useState(true)
  const [tests, setTests] = useState<Record<string, McpTestState>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [editor, setEditor] = useState<{ open: boolean; editing?: McpServerEntry }>({ open: false })
  const [deleteTarget, setDeleteTarget] = useState<McpServerEntry | undefined>(undefined)

  const load = async () => {
    try {
      const result = await api.listMcpServers()
      setServers(result.servers)
      setFilePath(result.filePath)
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runTest = async (server: McpServerEntry) => {
    setTests((current) => ({ ...current, [server.id]: { state: 'testing' } }))
    setExpanded((current) => ({ ...current, [server.id]: true }))
    try {
      const result: McpServerTestResult = await api.testMcpServer(server.id)
      // 兼容旧主进程返回 string[] 的情况（主进程未重启时仍返回纯字符串）
      const rawTools = result.tools as unknown[]
      const tools: Array<{ name: string; description?: string }> = (rawTools ?? []).map((tool) =>
        typeof tool === 'string'
          ? { name: tool, description: undefined }
          : (tool as { name: string; description?: string })
      )
      setTests((current) => ({
        ...current,
        [server.id]: result.ok
          ? { state: 'ok', tools, message: result.message }
          : { state: 'error', message: result.message }
      }))
    } catch (reason) {
      setTests((current) => ({
        ...current,
        [server.id]: { state: 'error', message: reason instanceof Error ? reason.message : String(reason) }
      }))
    }
  }

  const toggleEnabled = async (server: McpServerEntry, enabled: boolean) => {
    try {
      setServers(await api.saveMcpServer({ ...server, enabled }))
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const saveServer = async (entry: McpServerEntry, _isNew: boolean) => {
    try {
      const next = await api.saveMcpServer(entry)
      setServers(next)
      showSuccess('已保存')
      // 配置后自动初始化：验证配置是否有效（新增/编辑立即测试）。
      void runTest(entry)
      setEditor({ open: false })
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const removeServer = async () => {
    if (!deleteTarget) return
    try {
      setServers(await api.deleteMcpServer(deleteTarget.id))
      showSuccess('已删除')
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
    setDeleteTarget(undefined)
  }

  const selectable = servers.filter((server) => server.enabled)

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-foreground">MCP 服务</h3>
          <p className="text-[11px] leading-5 text-muted-foreground">
            统一配置文件：{filePath || '…/data/mcp.json'}。内置服务仅可启停，自定义服务支持弹窗编辑。
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setEditor({ open: true })}>
          <PlusIcon size={11} />
          新增 MCP
        </Button>
      </div>

      {loading ? (
        <div className="grid place-items-center py-10 text-xs text-muted-foreground">
          <Loader2Icon className="animate-spin-slow" size={14} />
        </div>
      ) : servers.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          暂无 MCP 服务
        </div>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => (
            <McpServerCard
              key={server.id}
              server={server}
              test={tests[server.id] ?? { state: 'idle' }}
              expanded={Boolean(expanded[server.id])}
              onToggleExpand={(open) => setExpanded((current) => ({ ...current, [server.id]: open }))}
              onToggleEnabled={(enabled) => void toggleEnabled(server, enabled)}
              onTest={() => void runTest(server)}
              onEdit={() => setEditor({ open: true, editing: server })}
              onDelete={() => setDeleteTarget(server)}
            />
          ))}
        </div>
      )}

      {selectable.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          已启用 {selectable.length} 个服务，可在对话 / 任务 Composer 的 MCP 选择器中勾选使用。
        </p>
      )}

      {editor.open && (
        <McpServerEditorDialog
          open={editor.open}
          editing={editor.editing}
          existing={servers}
          onClose={() => setEditor({ open: false })}
          onSave={(entry, isNew) => void saveServer(entry, isNew)}
        />
      )}

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 MCP 服务</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除「{deleteTarget?.name}」吗？该操作不可撤销，对话中已勾选该服务的会话将不再注入。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void removeServer()}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function McpServerCard({
  server,
  test,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onTest,
  onEdit,
  onDelete
}: {
  server: McpServerEntry
  test: McpTestState
  expanded: boolean
  onToggleExpand(open: boolean): void
  onToggleEnabled(enabled: boolean): void
  onTest(): void
  onEdit(): void
  onDelete(): void
}) {
  const command = commandLine(server)
  return (
    <Collapsible open={expanded} onOpenChange={onToggleExpand} className="overflow-hidden rounded-md border bg-card/40">
      <CollapsibleTrigger className="w-full">
        <div className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-muted/40">
          <ServerIcon />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h4 className="truncate text-xs font-semibold text-foreground">{server.name}</h4>
              {server.builtin ? (
                <Badge variant="muted" className="gap-0.5 text-[9px]">
                  <LockIcon size={8} />
                  系统内置
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[9px]">
                  自定义
                </Badge>
              )}
            </div>
            {server.description && (
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{server.description}</p>
            )}
            <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/80">{command}</p>
          </div>
          <StatusBadge test={test} />
          <Switch checked={server.enabled} onCheckedChange={onToggleEnabled} aria-label={`启用 ${server.name}`} />
          {!server.builtin && (
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`编辑 ${server.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onEdit()
                }}
              >
                <PencilIcon size={11} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`删除 ${server.name}`}
                className="text-destructive"
                onClick={(event) => {
                  event.stopPropagation()
                  onDelete()
                }}
              >
                <Trash2Icon size={11} />
              </Button>
            </div>
          )}
          <ChevronRightIcon
            size={13}
            className={cn('shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t bg-background/40 px-3 py-2.5">
          <div className="flex items-start justify-between gap-2">
            {test.state === 'ok' && test.tools.length > 0 ? (
              <div className="max-h-40 min-w-0 flex-1 space-y-0.5 overflow-y-auto">
                {test.tools.map((tool) => (
                  <div key={tool.name} className="flex items-baseline gap-2 py-0.5">
                    <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                      {tool.name}
                    </Badge>
                    {tool.description && (
                      <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={tool.description}>
                        {tool.description}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <span className="flex-1 text-[11px] text-muted-foreground">
                {test.state === 'error' ? test.message : '展开后点击「测试连接」验证配置有效性'}
              </span>
            )}
            <Button variant="secondary" size="sm" disabled={test.state === 'testing'} onClick={onTest}>
              {test.state === 'testing' ? (
                <Loader2Icon className="animate-spin-slow" size={11} />
              ) : (
                <RefreshCwIcon size={11} />
              )}
              {test.state === 'testing' ? '初始化中' : test.state === 'ok' ? '重新测试' : '测试连接'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function McpServerEditorDialog({
  open,
  editing,
  existing,
  onClose,
  onSave
}: {
  open: boolean
  editing?: McpServerEntry
  existing: McpServerEntry[]
  onClose(): void
  onSave(entry: McpServerEntry, isNew: boolean): void
}) {
  const isNew = !editing
  const isBuiltinEdit = Boolean(editing?.builtin)
  const [id, setId] = useState(editing?.id ?? '')
  const [name, setName] = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [transport, setTransport] = useState<McpServerEntry['transport']>(editing?.transport ?? 'stdio')
  const [command, setCommand] = useState(editing?.command ?? '')
  const [argsText, setArgsText] = useState((editing?.args ?? []).join(' '))
  const [url, setUrl] = useState(editing?.url ?? '')
  const [envText, setEnvText] = useState(stringifyKv(editing?.env))
  const [headersText, setHeadersText] = useState(stringifyKv(editing?.headers))
  const [error, setError] = useState<string | undefined>(undefined)

  const entry = useMemo<McpServerEntry>(() => {
    const args = argsText
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean)
    return {
      id: id.trim(),
      name: name.trim(),
      description: description.trim() || undefined,
      builtin: Boolean(editing?.builtin),
      enabled: editing?.enabled ?? true,
      transport,
      ...(transport === 'stdio' ? { command: command.trim(), args } : { url: url.trim() }),
      env: Object.keys(parseKv(envText)).length > 0 ? parseKv(envText) : undefined,
      headers: Object.keys(parseKv(headersText)).length > 0 ? parseKv(headersText) : undefined
    }
  }, [id, name, description, transport, command, argsText, url, envText, headersText, editing])

  const submit = () => {
    if (!entry.id) return setError('id 不能为空')
    if (!isBuiltinEdit && !entry.name) return setError('名称不能为空')
    if (transport === 'stdio' && !entry.command) return setError('stdio 传输需要填写 command')
    if (transport !== 'stdio' && !entry.url) return setError('sse / http 传输需要填写 url')
    if (!isBuiltinEdit && existing.some((s) => s.id === entry.id && s.id !== editing?.id))
      return setError(`id "${entry.id}" 已存在`)
    setError(undefined)
    onSave(entry, isNew)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isBuiltinEdit ? `${editing?.name}（系统内置）` : isNew ? '新增 MCP 服务' : '编辑 MCP 服务'}
          </DialogTitle>
          <DialogDescription>
            {isBuiltinEdit
              ? '内置服务由系统维护，参数不可修改，仅可切换启用状态。'
              : '保存后立即初始化连接，验证配置是否有效。'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FieldGroup className="gap-2.5">
            <div className="grid grid-cols-2 gap-2.5">
              <Field className="gap-1" label="ID">
                <Input
                  value={id}
                  onChange={(event) => setId(event.target.value)}
                  disabled={!isNew}
                  placeholder="如 my-server（字母数字_-）"
                  className="font-mono text-xs"
                />
              </Field>
              <Field className="gap-1" label="名称">
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={isBuiltinEdit}
                  placeholder="显示名称"
                />
              </Field>
            </div>
            <Field className="gap-1" label="描述（可选）">
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={isBuiltinEdit}
                placeholder="该服务的用途说明"
              />
            </Field>
            <Field className="gap-1" label="传输方式">
              <select
                value={transport}
                disabled={isBuiltinEdit}
                onChange={(event) => setTransport(event.target.value as McpServerEntry['transport'])}
                className="h-8 rounded-md border bg-background px-2 text-xs"
              >
                <option value="stdio">stdio（本地命令）</option>
                <option value="sse">sse（远程 URL）</option>
                <option value="streamable-http">streamable-http（远程 URL）</option>
              </select>
            </Field>
            {transport === 'stdio' ? (
              <div className="grid grid-cols-2 gap-2.5">
                <Field className="gap-1" label="Command">
                  <Input
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    disabled={isBuiltinEdit}
                    placeholder="如 npx / uvx / node"
                    className="font-mono text-xs"
                  />
                </Field>
                <Field className="gap-1" label="Args（空格分隔）">
                  <Input
                    value={argsText}
                    onChange={(event) => setArgsText(event.target.value)}
                    disabled={isBuiltinEdit}
                    placeholder="如 -y @zereight/mcp-gitlab"
                    className="font-mono text-xs"
                  />
                </Field>
              </div>
            ) : (
              <Field className="gap-1" label="URL">
                <Input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  disabled={isBuiltinEdit}
                  placeholder="https://…"
                  className="font-mono text-xs"
                />
              </Field>
            )}
            <Field className="gap-1" label="环境变量（每行 KEY=VALUE，可选）">
              <Textarea
                value={envText}
                onChange={(event) => setEnvText(event.target.value)}
                disabled={isBuiltinEdit}
                rows={3}
                placeholder="API_KEY=xxx"
                className="font-mono text-xs"
              />
            </Field>
            <Field className="gap-1" label="请求头（每行 KEY=VALUE，可选）">
              <Textarea
                value={headersText}
                onChange={(event) => setHeadersText(event.target.value)}
                disabled={isBuiltinEdit}
                rows={2}
                placeholder="Authorization=Bearer xxx"
                className="font-mono text-xs"
              />
            </Field>
          </FieldGroup>
          {error && <p className="text-[11px] text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" size="sm">
              取消
            </Button>
          </DialogClose>
          <Button size="sm" onClick={submit} disabled={isBuiltinEdit}>
            {isBuiltinEdit ? (
              <>
                <LockIcon size={11} />
                系统内置
              </>
            ) : (
              <>
                <ExternalLinkIcon size={11} />
                保存并初始化
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
