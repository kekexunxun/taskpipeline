/**
 * IPC handler 注册：从 main.ts 提取的全部 IPC handler。
 *
 * 通过 deps 对象接收 main.ts 中组装的服务实例，避免直接依赖 main.ts 的模块作用域。
 */
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, dialog, ipcMain, shell } from 'electron'
import { boardColumnFor } from '@task-pipeline/core'
import {
  fetchJiraTasks,
  importJiraIssue,
  jiraKeyFrom,
  testAtlassianConnectionRest,
  safeAtlassianCall
} from '@task-pipeline/integrations'
import type { Task, TaskRepository, TaskStartMode, Memory, AgentProfile } from '@task-pipeline/core'
import type { RepositoryCommandMap } from '@task-pipeline/integrations'
import type { CodegraphManager } from '@task-pipeline/codegraph'
import type { QoderOrchestrator } from '../pi-extension/qoder/index.js'
import type { ChatService } from '../chat/chat-service.js'
import type { ChatAttachmentCache } from '../chat/chat-attachment-cache.js'
import type { MemoryService } from '../memory/memory-service.js'
import type { AgentService } from '../agents/agent-service.js'
import type { TracePipeline } from '../trace/bus/trace-pipeline.js'
import type { TraceService } from '../trace/trace-service.js'
import type { McpServerEntry } from '../mcp/mcp-config.js'
import type { ChatDriverId } from '../chat/chat-types.js'
import type { AgentGenerationRepository } from '../agents/agent-generator.js'
import type { TaskBackendId } from '../chat/task-backends/index.js'
import type { HitlMode } from '../task/hitl-mode.js'
import type { TaskRemovalMode } from '../task/task-lifecycle.js'
import type { PathRegistry } from '../path-registry.js'
import { checkForUpdates, downloadUpdate as updaterDownload, quitAndInstall, getUpdateStatus } from '../auto-updater.js'

/** IPC handler 所需的全部依赖，由 main.ts 组装后传入。 */
export interface IpcDeps {
  getWindow: () => Electron.BrowserWindow | undefined
  dataDir: string
  skillsRoot: string
  mcpConfigPath: string

  store: TaskStoreLike
  keyStore: { protect: (value: string, key: string) => string }

  // 任务生命周期
  taskCardsWithCurrentChanges: () => unknown[]
  getActiveTaskOperations: () => Set<string>
  getActiveTaskId: () => string | undefined
  startTask: (
    taskId: string,
    options?: {
      mode?: TaskStartMode
      repositoryCommands?: RepositoryCommandMap
      useAllRepositories?: boolean
      repoAgentIds?: Record<string, string>
    }
  ) => Promise<void>
  resumeTask: (taskId: string) => Promise<void>
  pauseTask: (taskId: string) => Promise<void>
  resumePausedTask: (taskId: string) => Promise<void>
  updateTaskPlan: (taskId: string, planContent: string) => Promise<void>
  approveTaskPlan: (taskId: string) => Promise<void>
  reviseTaskPlan: (taskId: string, feedback: string) => Promise<void>
  retryTaskValidation: (taskId: string) => Promise<void>
  sendTaskMessage: (taskId: string, message: string) => Promise<void>
  cancelTask: (taskId: string) => Promise<void>
  deleteTask: (id: string, mode?: TaskRemovalMode) => Promise<void>
  stopTaskOperations: (taskId: string, force?: boolean) => Promise<void>
  runTaskOperation: (taskId: string, operation: (signal: AbortSignal) => Promise<void>) => Promise<void>
  taskChangedFiles: (taskId: string) => Promise<unknown[]>
  taskWorkspace: (taskId: string) => string
  openEditorForTask: (taskId: string, editor: 'vscode' | 'qoder') => Promise<void>
  mergeBackToBase: (taskId: string, signal?: AbortSignal) => Promise<void>
  runReviewWithAutoFix: (taskId: string, signal?: AbortSignal) => Promise<void>
  submitMergeRequestsWithCredWatch: (taskId: string, signal?: AbortSignal) => Promise<void>
  getPendingUi: () => Map<string, (response: unknown) => void>

  // 服务实例
  taskWorkflow: { reimplement: (taskId: string) => Promise<void>; resetReview: (taskId: string) => Promise<void> }
  deliveryService: { resetDelivery: (taskId: string) => Promise<void> }
  mergeRefresher: { refresh: () => Promise<unknown> }
  taskCompleter: { manualComplete: (taskId: string) => Promise<void> }
  gitService: {
    inspectRepository: (path: string) => Promise<{ rootPath: string; remoteUrl?: string; currentBranch?: string }>
    workingTreeStatus: (cwd: string) => Promise<unknown[]>
    diffFile: (cwd: string, file: string, status: string) => Promise<string>
    diffFileContents: (cwd: string, file: string, status: string) => Promise<{ original: string; current: string }>
  }
  atlassianFactory: { create: (kind: string) => unknown; restConfig: (kind: string) => unknown }
  // Agent 生成
  qoderOrch: QoderOrchestrator & {
    callForAgentGeneration: (
      prompt: string,
      model: string,
      options: { additionalDirectories: string[]; onMessage: (msg: unknown) => void }
    ) => Promise<string>
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  QoderTraceBuilder: any
  AGENT_GENERATOR_TASK_ID: string
  chatService: ChatService
  chatAttachmentCache: ChatAttachmentCache
  memoryService: MemoryService
  agentService: AgentService
  tracePipeline: TracePipeline
  traceService: TraceService

  // HITL
  getHitlModeForContext: (contextType?: 'conversation' | 'task', contextId?: string) => HitlMode
  setGlobalHitlMode: (mode: HitlMode) => void
  setConversationHitlMode: (conversationId: string, mode: HitlMode) => void

  // MCP / Skill
  loadMcpServers: (path: string) => McpServerEntry[]
  saveMcpServers: (path: string, servers: McpServerEntry[]) => void
  validateMcpServerEntry: (entry: McpServerEntry, servers: McpServerEntry[], editingId: string) => string | undefined
  BUILTIN_MCP_IDS: Set<string>
  testMcpConnectionById: (id: string) => Promise<{ ok: boolean; tools: unknown[]; message: string }>
  listSkills: (root: string) => unknown[]
  importSkillZip: (root: string, path: string) => Promise<unknown>
  importSkillFolder: (root: string, path: string) => Promise<unknown>
  deleteSkill: (root: string, name: string) => void

  // Credential
  credentialStateSnapshot: () => unknown[]
  checkCredentialHealth: () => Promise<unknown[]>

  // Agent
  AGENT_TEMPLATES: unknown[]
  loadRepoContext: (repositories: AgentGenerationRepository[]) => Promise<string>
  buildAgentGenerationPrompt: (input: {
    description: string
    repositories: AgentGenerationRepository[]
    repoContext: string
  }) => string
  parseAgentGenerationResult: (raw: string) => unknown
  callOpenAIForPrompt: (
    prompt: string,
    taskId: string,
    model: string,
    signal?: AbortSignal,
    options?: { timeoutMs?: number }
  ) => Promise<string>
  stripOpenAIModelPrefix: (model: string) => string

  // 工具
  listTaskBackends: () => Array<{ id: TaskBackendId; displayName: string; configured: boolean }>
  syncPiModelConfig: () => void
  keywordRewriter: (query: string) => Promise<string[]>

  // Codegraph
  codegraphManager: CodegraphManager

  // PathRegistry
  pathRegistry: PathRegistry

  // 数据目录
  writeCustomDataDir: (dir: string) => void
}

/** TaskStore 的 IPC 所需子集 */
interface TaskStoreLike {
  getTask: (id: string) => Task
  createTask: (
    input: Pick<Task, 'title' | 'description'> & Partial<Pick<Task, 'keywords' | 'acceptanceCriteria'>>
  ) => Task
  updateTask: (id: string, patch: Record<string, unknown>) => Task
  listTaskRepositories: (taskId?: string) => TaskRepository[]
  listRepositoryProfiles: () => TaskRepository[]
  saveRepositoryProfile: (profile: TaskRepository) => void
  deleteRepositoryProfile: (id: string) => void
  attachRepository: (taskId: string, repositoryId: string) => void
  detachRepository: (taskId: string, repositoryId: string) => void
  updateTaskRepository: (
    id: string,
    commands: Partial<Pick<TaskRepository, 'setupCommand' | 'lintCommand' | 'testCommand' | 'buildCommand'>>
  ) => TaskRepository
  getSetting: (key: string) => string | undefined
  setSetting: (key: string, value: string) => void
  listApprovals: (taskId: string) => unknown[]
  addApproval: (input: { taskId: string; kind: string; context: string }) => { id: string }
  resolveApproval: (id: string, status: 'approved' | 'rejected') => void
  getTaskBySourceKey: (source: string, key: string) => Task | undefined
  upsertJiraTask: (input: Record<string, unknown>) => Task
}

export function registerIpc(d: IpcDeps): void {
  const {
    getWindow,
    dataDir,
    skillsRoot,
    mcpConfigPath,
    store,
    keyStore,
    taskCardsWithCurrentChanges,
    getActiveTaskOperations,
    getActiveTaskId,
    startTask,
    resumeTask,
    pauseTask,
    resumePausedTask,
    updateTaskPlan,
    approveTaskPlan,
    reviseTaskPlan,
    retryTaskValidation,
    sendTaskMessage,
    cancelTask,
    deleteTask,
    stopTaskOperations,
    runTaskOperation,
    taskChangedFiles,
    taskWorkspace,
    openEditorForTask,
    mergeBackToBase,
    runReviewWithAutoFix,
    submitMergeRequestsWithCredWatch,
    getPendingUi,
    taskWorkflow,
    deliveryService,
    mergeRefresher,
    taskCompleter,
    gitService,
    atlassianFactory,
    qoderOrch,
    chatService,
    chatAttachmentCache,
    memoryService,
    agentService,
    tracePipeline,
    traceService,
    getHitlModeForContext,
    setGlobalHitlMode,
    setConversationHitlMode,
    loadMcpServers,
    saveMcpServers,
    validateMcpServerEntry,
    BUILTIN_MCP_IDS,
    testMcpConnectionById,
    listSkills,
    importSkillZip,
    importSkillFolder,
    deleteSkill,
    credentialStateSnapshot,
    checkCredentialHealth,
    AGENT_TEMPLATES,
    loadRepoContext,
    buildAgentGenerationPrompt,
    parseAgentGenerationResult,
    callOpenAIForPrompt,
    stripOpenAIModelPrefix,
    listTaskBackends,
    writeCustomDataDir,
    syncPiModelConfig,
    keywordRewriter,
    QoderTraceBuilder: QoderTraceBuilderCtor,
    AGENT_GENERATOR_TASK_ID,
    codegraphManager,
    pathRegistry
  } = d

  /** 全量重建 path_registry 表（仓库 + 对话文件夹）。 */
  async function refreshPathRegistry(): Promise<void> {
    const repos = store.listRepositoryProfiles() as unknown as Array<{
      id: string
      name: string
      localPath: string
      defaultBranch: string
    }>
    const allGroups = await chatService.listGroups()
    const dirGroups = allGroups.filter((g) => g.chatType === 'directory')
    const wikiCounts: Record<string, number> = {}
    for (const repo of repos) {
      wikiCounts[repo.id] = memoryService.listRepoWikiDocs(repo.id).length
    }
    pathRegistry.refresh(repos, dirGroups, wikiCounts)
  }

  // === Trace 页面（v2）=====================================================
  ipcMain.handle('trace:list', () => traceService.listSummaries())
  ipcMain.handle('trace:get', (_event, _kind: string, traceId: string) => traceService.getTrace(traceId))
  ipcMain.handle('trace:dashboard', () => traceService.dashboardStats())
  ipcMain.handle('trace:delete', (_event, _kind: string, traceId: string) => traceService.deleteTrace(traceId))

  // === 任务 CRUD ============================================================
  ipcMain.handle('tasks:list', async () => {
    await mergeRefresher.refresh()
    return taskCardsWithCurrentChanges()
  })
  ipcMain.handle('tasks:get', async (_event, id: string) => {
    await mergeRefresher.refresh()
    return {
      task: store.getTask(id),
      running: getActiveTaskOperations().has(id),
      repositories: store.listTaskRepositories(id),
      events: await traceService.getTaskEvents(id),
      openAiEvents: [],
      approvals: store.listApprovals(id),
      changedFiles: await taskChangedFiles(id)
    }
  })
  ipcMain.handle(
    'tasks:create',
    (_event, input: Pick<Task, 'title' | 'description'> & Partial<Pick<Task, 'keywords' | 'acceptanceCriteria'>>) =>
      store.createTask(input)
  )
  ipcMain.handle('tasks:update', (_event, id: string, patch: Record<string, unknown>) => store.updateTask(id, patch))
  ipcMain.handle('tasks:delete', (_event, id: string, mode?: TaskRemovalMode) => deleteTask(id, mode))

  // === 仓库配置 ==============================================================
  ipcMain.handle('repos:list', () => store.listRepositoryProfiles())
  ipcMain.handle('repos:save', async (_event, profile) => {
    store.saveRepositoryProfile(profile)
    try {
      await memoryService.refreshRepoWiki(profile.id, profile.localPath)
    } catch (error) {
      console.warn('[repowiki] index failed:', error)
    }
    // codegraph 索引：异步触发，不阻塞保存操作
    codegraphManager.ensureIndex(profile.id, profile.localPath).catch((error) => {
      console.warn('[codegraph] index failed:', error)
    })
    await refreshPathRegistry()
  })
  ipcMain.handle('repos:delete', async (_event, id: string) => {
    const profile = store.listRepositoryProfiles().find((r) => r.id === id)
    store.deleteRepositoryProfile(id)
    memoryService.deleteRepoMemories(id)
    codegraphManager.deleteIndex(id)
    const removedAgents = agentService.detachRepository(id)
    if (profile) pathRegistry.removeRepo(profile.localPath)
    return { removedAgents }
  })
  ipcMain.handle('repos:choose-folder', async () => {
    const localPath = (await dialog.showOpenDialog(getWindow()!, { properties: ['openDirectory'] })).filePaths[0]
    if (!localPath) return undefined
    try {
      const info = await gitService.inspectRepository(localPath)
      return {
        name: basename(info.rootPath),
        localPath: info.rootPath,
        remoteUrl: info.remoteUrl,
        defaultBranch: info.currentBranch
      }
    } catch {
      throw new Error('仓库异常:所选目录不是有效的 Git 仓库,或当前未检出分支')
    }
  })
  ipcMain.handle('tasks:attach-repo', (_event, taskId: string, repositoryId: string) =>
    store.attachRepository(taskId, repositoryId)
  )
  ipcMain.handle('tasks:detach-repo', (_event, taskId: string, repositoryId: string) =>
    store.detachRepository(taskId, repositoryId)
  )
  ipcMain.handle(
    'tasks:update-repo-commands',
    (
      _event,
      taskId: string,
      repositoryId: string,
      commands: Partial<Pick<TaskRepository, 'setupCommand' | 'lintCommand' | 'testCommand' | 'buildCommand'>>
    ) => {
      const repo = store.listTaskRepositories(taskId).find((item) => item.repositoryId === repositoryId)
      if (!repo) throw new Error(`任务仓库不存在: ${repositoryId}`)
      return store.updateTaskRepository(repo.id, commands)
    }
  )

  // === 设置 ==================================================================
  ipcMain.handle('settings:get', (_event, key: string) =>
    ['jiraToken', 'confluenceToken', 'qoderToken', 'modelApiKey', 'gitlabToken'].includes(key)
      ? store.getSetting(key)
        ? '__configured__'
        : undefined
      : store.getSetting(key)
  )
  ipcMain.handle('settings:set', (_event, key: string, value: string, secret = false) => {
    store.setSetting(key, secret ? keyStore.protect(value, key) : value)
    if (key === 'modelProfiles' || key === 'modelProfile') syncPiModelConfig()
  })

  // === HITL ==================================================================
  ipcMain.handle(
    'hitl:set-mode',
    (_event, mode: HitlMode, contextType?: 'conversation' | 'task', contextId?: string) => {
      if (!contextType || !contextId) {
        setGlobalHitlMode(mode)
        store.setSetting('hitlMode', mode)
      } else if (contextType === 'conversation') {
        setConversationHitlMode(contextId, mode)
        void chatService.setChatHitlMode(contextId, mode).catch(() => {})
      } else if (contextType === 'task') {
        store.updateTask(contextId, { hitlMode: mode })
      }
    }
  )
  ipcMain.handle('hitl:get-mode', (_event, contextType?: 'conversation' | 'task', contextId?: string) =>
    getHitlModeForContext(contextType, contextId)
  )

  // === 任务执行流程 ==========================================================
  ipcMain.handle(
    'tasks:start',
    (
      _event,
      taskId: string,
      options?: {
        mode?: TaskStartMode
        repositoryCommands?: RepositoryCommandMap
        useAllRepositories?: boolean
        repoAgentIds?: Record<string, string>
      }
    ) => startTask(taskId, options)
  )
  ipcMain.handle('tasks:reimplement', (_event, taskId: string) => taskWorkflow.reimplement(taskId))
  ipcMain.handle('tasks:resume', (_event, taskId: string) => resumeTask(taskId))
  ipcMain.handle('tasks:pause', (_event, taskId: string) => pauseTask(taskId))
  ipcMain.handle('tasks:resume-paused', (_event, taskId: string) => resumePausedTask(taskId))
  ipcMain.handle('tasks:update-plan', (_event, taskId: string, planContent: string) =>
    updateTaskPlan(taskId, planContent)
  )
  ipcMain.handle('tasks:approve-plan', (_event, taskId: string) => approveTaskPlan(taskId))
  ipcMain.handle('tasks:revise-plan', (_event, taskId: string, feedback: string) => reviseTaskPlan(taskId, feedback))
  ipcMain.handle('tasks:retry-validation', (_event, taskId: string) => retryTaskValidation(taskId))
  ipcMain.handle('tasks:message', (_event, taskId: string, message: string) => sendTaskMessage(taskId, message))
  ipcMain.handle('tasks:abort', () => (getActiveTaskId() ? stopTaskOperations(getActiveTaskId()!, true) : undefined))
  ipcMain.handle('tasks:cancel', (_event, taskId: string) => cancelTask(taskId))
  ipcMain.handle('tasks:review', (_event, taskId: string) =>
    runTaskOperation(taskId, (signal) => runReviewWithAutoFix(taskId, signal))
  )
  ipcMain.handle('tasks:reset-review', (_event, taskId: string) => taskWorkflow.resetReview(taskId))
  ipcMain.handle('tasks:reset-delivery', (_event, taskId: string) => deliveryService.resetDelivery(taskId))
  ipcMain.handle('tasks:submit-mrs', (_event, taskId: string) =>
    runTaskOperation(taskId, (signal) => submitMergeRequestsWithCredWatch(taskId, signal))
  )
  ipcMain.handle('tasks:refresh-merge-status', () => mergeRefresher.refresh())
  ipcMain.handle('tasks:manual-complete', (_event, taskId: string) => taskCompleter.manualComplete(taskId))
  ipcMain.handle('tasks:open-editor', (_event, taskId: string, editor: 'vscode' | 'qoder') =>
    openEditorForTask(taskId, editor)
  )
  ipcMain.handle('tasks:merge-back-to-base', (_event, taskId: string) =>
    runTaskOperation(taskId, (signal) => mergeBackToBase(taskId, signal))
  )
  ipcMain.handle('tasks:reveal-workspace', (_event, taskId: string) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('taskId 不能为空')
    const ws = taskWorkspace(taskId)
    if (!existsSync(ws)) mkdirSync(ws, { recursive: true })
    shell.showItemInFolder(ws)
  })
  ipcMain.handle('tasks:list-backends', () => listTaskBackends())
  ipcMain.handle('qoder:status', () => qoderOrch.getStatus())

  // === Shell / Jira / Atlassian ==============================================
  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    if (typeof url !== 'string') throw new Error('url 必须是字符串')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('无效的 URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 http(s) 链接')
    await shell.openExternal(parsed.toString())
  })
  ipcMain.handle('jira:import', async (_event, keyOrUrl: string) =>
    safeAtlassianCall('导入 Jira Issue', () =>
      importJiraIssue(atlassianFactory.create('jira') as never, keyOrUrl, store as never)
    )
  )
  ipcMain.handle('jira:check-exists', (_event, keyOrUrl: string) => {
    try {
      const key = jiraKeyFrom(keyOrUrl)
      if (!key) return { existing: false, conflict: false }
      const existing = store.getTaskBySourceKey('jira', key)
      return {
        existing: Boolean(existing),
        conflict: Boolean(existing && boardColumnFor(existing.state) !== 'todo')
      }
    } catch {
      return { existing: false, conflict: false }
    }
  })
  ipcMain.handle('jira:sync', async () =>
    safeAtlassianCall('同步 Jira 任务', async () => {
      const candidates = await fetchJiraTasks(atlassianFactory.create('jira') as never)
      return candidates.map((candidate) => {
        const existing = candidate.taskKey ? store.getTaskBySourceKey('jira', candidate.taskKey) : undefined
        return {
          ...candidate,
          existing: Boolean(existing),
          conflict: Boolean(existing && boardColumnFor(existing.state) !== 'todo')
        }
      })
    })
  )
  ipcMain.handle('jira:import-many', (_event, candidates: Array<Record<string, unknown>>) => {
    const tasks = candidates.flatMap((candidate) => {
      const taskKey = typeof candidate.taskKey === 'string' ? candidate.taskKey.trim().toUpperCase() : ''
      const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
      if (!taskKey || !title) return []
      return [
        store.upsertJiraTask({
          taskKey,
          source: 'jira',
          sourceUrl: typeof candidate.sourceUrl === 'string' ? candidate.sourceUrl : undefined,
          title,
          description: typeof candidate.description === 'string' ? candidate.description : '',
          keywords: Array.isArray(candidate.keywords) ? candidate.keywords.map(String) : [],
          acceptanceCriteria: Array.isArray(candidate.acceptanceCriteria)
            ? candidate.acceptanceCriteria.map(String)
            : [],
          state: 'draft',
          reviewStatus: 'pending'
        })
      ]
    })
    if (tasks.length > 0) store.setSetting('lastJiraSync', new Date().toISOString())
    return tasks
  })
  ipcMain.handle('atlassian:test', (_event, kind: 'jira' | 'confluence') => {
    const rest = atlassianFactory.restConfig(kind)
    if (!rest) return { ok: false, message: `请先配置 ${kind === 'jira' ? 'Jira' : 'Confluence'} URL 与 Token` }
    return testAtlassianConnectionRest(kind, rest as never)
  })
  ipcMain.handle('gitlab:test-mcp', () =>
    testMcpConnectionById('gitlab').then((r) => ({ ok: r.ok, message: r.message }))
  )
  ipcMain.handle('settings:check-credentials', () => checkCredentialHealth())
  ipcMain.handle('credentials:state', () => credentialStateSnapshot())
  ipcMain.handle('task:ui-response', (_event, response: Record<string, unknown>) =>
    getPendingUi().get(String(response.id))?.(response)
  )

  // === MCP ===================================================================
  ipcMain.handle('mcp:list', () => ({ servers: loadMcpServers(mcpConfigPath), filePath: mcpConfigPath }))
  ipcMain.handle('mcp:save', (_event, entry: McpServerEntry) => {
    const servers = loadMcpServers(mcpConfigPath)
    const editingId = entry?.id
    if (typeof editingId !== 'string' || !editingId) throw new Error('缺少服务 id')
    const error = validateMcpServerEntry(entry, servers, editingId)
    if (error) throw new Error(error)
    const existing = servers.find((s) => s.id === editingId)
    const next = existing
      ? servers.map((s) =>
          s.id === editingId
            ? s.builtin
              ? { ...s, enabled: Boolean(entry.enabled) }
              : { ...s, ...entry, builtin: false, enabled: Boolean(entry.enabled ?? s.enabled) }
            : s
        )
      : [...servers, { ...entry, builtin: false, enabled: entry.enabled !== false }]
    saveMcpServers(mcpConfigPath, next)
    return loadMcpServers(mcpConfigPath)
  })
  ipcMain.handle('mcp:delete', (_event, id: string) => {
    if (BUILTIN_MCP_IDS.has(id)) throw new Error('内置服务不允许删除')
    saveMcpServers(
      mcpConfigPath,
      loadMcpServers(mcpConfigPath).filter((s) => s.id !== id)
    )
    return loadMcpServers(mcpConfigPath)
  })
  ipcMain.handle('mcp:test', (_event, id: string) => testMcpConnectionById(id))

  // === Skill =================================================================
  ipcMain.handle('skill:list', () => listSkills(skillsRoot))
  ipcMain.handle('skill:import-zip', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindow()!, {
      properties: ['openFile'],
      filters: [{ name: 'Skill ZIP', extensions: ['zip'] }]
    })
    const zipPath = canceled ? undefined : filePaths[0]
    if (!zipPath) return undefined
    return importSkillZip(skillsRoot, zipPath)
  })
  ipcMain.handle('skill:import-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindow()!, { properties: ['openDirectory'] })
    const folderPath = canceled ? undefined : filePaths[0]
    if (!folderPath) return undefined
    return importSkillFolder(skillsRoot, folderPath)
  })
  ipcMain.handle('skill:delete', (_event, name: string) => {
    if (typeof name !== 'string' || !name) throw new Error('缺少技能名')
    deleteSkill(skillsRoot, name)
    return listSkills(skillsRoot)
  })

  // === Memory ================================================================
  ipcMain.handle(
    'memory:list',
    (
      _event,
      filter?: { scope?: Memory['scope']; scopes?: Memory['scope'][]; repositoryId?: string; conversationId?: string }
    ) => memoryService.listMemories(filter)
  )
  ipcMain.handle('memory:upsert', (_event, input: Parameters<MemoryService['upsertMemory']>[0]) =>
    memoryService.upsertMemory(input)
  )
  ipcMain.handle(
    'memory:update',
    (_event, id: string, patch: Partial<Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>>) =>
      memoryService.updateMemory(id, patch)
  )
  ipcMain.handle('memory:delete', (_event, id: string) => memoryService.deleteMemory(id))
  ipcMain.handle(
    'memory:search',
    async (
      _event,
      query: string,
      options?: { repositoryIds?: string[]; conversationId?: string; limit?: number; traceSource?: 'dev-probe' }
    ) => memoryService.search({ userId: memoryService.ensureUserId(), query, keywordRewriter, ...options })
  )
  ipcMain.handle('repowiki:index', async (_event, repositoryId: string) => {
    const profile = store.listRepositoryProfiles().find((repo) => repo.id === repositoryId)
    if (!profile) throw new Error('仓库不存在')
    const result = await memoryService.refreshRepoWiki(profile.id, profile.localPath)
    // 更新 path_registry 中的 wiki 文档数
    const wikiDocs = memoryService.listRepoWikiDocs(repositoryId)
    pathRegistry.updateWikiCount(profile.localPath, wikiDocs.length)
    return result
  })
  ipcMain.handle('repowiki:list', (_event, repositoryId: string) => memoryService.listRepoWikiDocs(repositoryId))
  ipcMain.handle('repowiki:search', (_event, repositoryId: string, query: string) =>
    memoryService.searchRepoWikiDocs(repositoryId, query)
  )

  // === Agent 配置 ============================================================
  ipcMain.handle('agents:list', () => agentService.list())
  ipcMain.handle('agents:save', (_event, profile: AgentProfile) => {
    agentService.save(profile)
    return agentService.list()
  })
  ipcMain.handle('agents:delete', (_event, id: string) => {
    agentService.delete(id)
    return agentService.list()
  })
  ipcMain.handle('agents:templates', () => AGENT_TEMPLATES)
  ipcMain.handle('agents:export', async () => {
    const window = getWindow()
    if (!window) throw new Error('窗口不可用')
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: '导出 Agent 配置',
      defaultPath: join(app.getPath('downloads'), `agents-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return undefined
    writeFileSync(filePath, `${JSON.stringify(agentService.list(), null, 2)}\n`, 'utf8')
    return filePath
  })
  ipcMain.handle('agents:import', async () => {
    const window = getWindow()
    if (!window) throw new Error('窗口不可用')
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: '导入 Agent 配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || filePaths.length === 0) return undefined
    const parsed = JSON.parse(readFileSync(filePaths[0]!, 'utf8')) as unknown
    if (!Array.isArray(parsed)) throw new Error('导入文件必须是 Agent 数组（导出的 JSON 可直接导入）')
    return agentService.importAll(parsed as AgentProfile[])
  })
  ipcMain.handle(
    'agents:generate-content',
    async (_event, input: { model?: string; description: string; repositories: AgentGenerationRepository[] }) => {
      const model = input?.model?.trim() || (await chatService.getDefaultModel())?.model
      if (!model) throw new Error('未配置可用模型，请先在设置中添加 Qoder Token 或 OpenAI 配置')
      const description = input?.description ?? ''
      const repositories = input?.repositories ?? []
      const repoContext = await loadRepoContext(repositories)
      const prompt = buildAgentGenerationPrompt({ description, repositories, repoContext })
      const isQoder = model.startsWith('qoder:')
      const traceId = `agent-gen-${randomUUID()}`
      const qoderModel = model.slice('qoder:'.length)
      const openaiModel = stripOpenAIModelPrefix(model)
      tracePipeline.beginTrace({
        traceId,
        kind: 'task',
        title: `生成 Agent 说明：${description.replace(/\s+/g, ' ').trim().slice(0, 60)}`,
        source: isQoder ? 'qoder' : 'openai',
        agentName: isQoder ? 'Qoder' : 'OpenAI',
        ...(isQoder || openaiModel ? { model: isQoder ? qoderModel : openaiModel } : {})
      })
      const builder = isQoder
        ? new QoderTraceBuilderCtor(tracePipeline, traceId, 'task', 'qoder', qoderModel)
        : undefined
      const openaiSpan = isQoder
        ? undefined
        : tracePipeline.startSpan(traceId, {
            type: 'llm.generate',
            name: '生成 Agent 说明',
            ...(openaiModel ? { model: openaiModel } : {})
          })
      try {
        const raw = isQoder
          ? await qoderOrch.callForAgentGeneration(prompt, qoderModel, {
              additionalDirectories: repositories.map((repo) => repo.localPath),
              onMessage: (message) => {
                try {
                  builder?.onMessage(message as never)
                } catch {
                  /* ignore */
                }
              }
            })
          : await callOpenAIForPrompt(prompt, AGENT_GENERATOR_TASK_ID, model, undefined, { timeoutMs: 120_000 })
        if (openaiSpan) tracePipeline.endSpan(traceId, openaiSpan, { output: raw })
        const result = parseAgentGenerationResult(raw)
        return result
      } catch (error) {
        if (openaiSpan) {
          tracePipeline.endSpan(traceId, openaiSpan, {
            status: 'error',
            error: { message: error instanceof Error ? error.message : String(error) }
          })
        }
        throw error
      } finally {
        builder?.finish()
        tracePipeline.endTrace(traceId)
      }
    }
  )

  // === Chat 对话 =============================================================
  ipcMain.handle('chats:list', async () => chatService.listChats())
  ipcMain.handle('chats:list-groups', async () => chatService.listGroups())
  ipcMain.handle('chats:get', async (_event, id: string) => {
    const result = await chatService.getChat(id)
    if (result?.conversation?.hitlMode) {
      setConversationHitlMode(id, result.conversation.hitlMode)
    }
    return result
  })
  ipcMain.handle(
    'chats:create',
    async (_event, input?: { driverId?: ChatDriverId; model?: string; workingDirectory?: string }) =>
      chatService.createChat(input?.driverId, input?.model, input?.workingDirectory)
  )
  ipcMain.handle('chats:delete', async (_event, id: string) => {
    await chatService.deleteChat(id)
    memoryService.deleteConversationMemories(id)
    chatAttachmentCache.deleteAttachments(id)
  })
  ipcMain.handle('chats:set-directory', async (_event, id: string, workingDirectory?: string) => {
    const result = await chatService.setChatWorkingDirectory(id, workingDirectory)
    // 绑定工作目录时触发 codegraph 索引（异步不阻塞）
    if (workingDirectory) {
      codegraphManager.ensureIndex(`chat:${id}`, workingDirectory).catch((error) => {
        console.warn('[codegraph] chat directory index failed:', error)
      })
    }
    return result
  })
  ipcMain.handle('chats:list-models', async () => {
    const groups = await chatService.listModels()
    const status = qoderOrch?.getCachedStatus()
    if (status?.enabled && status.connected) {
      const enabled = status.models.filter((m) => m.isEnabled !== false)
      const quotaExhausted =
        status.usage?.isQuotaExceeded === true || (enabled.length > 0 && enabled.every((m) => m.priceFactor === 0))
      if (quotaExhausted) {
        const qoder = groups.find((group) => group.driverId === 'qoder')
        if (qoder) qoder.quotaExhausted = true
      }
    }
    return groups
  })
  ipcMain.handle('chats:default-model', () => chatService.getDefaultModel())
  ipcMain.handle('chats:start-stream', (_event, input) => {
    void chatService.startChatStream(input).catch((reason) => console.error('[chat] stream_failed', reason))
  })
  ipcMain.handle('chats:abort', (_event, input) => chatService.abortChat(input))
  ipcMain.handle('chats:inject-guidance', (_event, chatId: string, text: string) =>
    chatService.injectGuidance(chatId, text)
  )
  ipcMain.handle(
    'chats:save-attachment',
    (_event, chatId: string, data: ArrayBuffer, filename: string, mediaType: string) =>
      chatAttachmentCache.saveAttachment(chatId, Buffer.from(data), filename, mediaType)
  )
  ipcMain.handle('chats:changed-files', async (_event, workingDirectory?: string) => {
    if (!workingDirectory) return []
    try {
      return await gitService.workingTreeStatus(workingDirectory)
    } catch {
      return []
    }
  })
  ipcMain.handle('chats:file-diff', async (_event, workingDirectory?: string, filePath?: string, status?: string) => {
    if (!workingDirectory || !filePath) return ''
    try {
      return await gitService.diffFile(workingDirectory, filePath, status || 'M')
    } catch {
      return ''
    }
  })
  ipcMain.handle(
    'chats:file-diff-contents',
    async (_event, workingDirectory?: string, filePath?: string, status?: string) => {
      if (!workingDirectory || !filePath) return { original: '', current: '' }
      try {
        return await gitService.diffFileContents(workingDirectory, filePath, status || 'M')
      } catch {
        return { original: '', current: '' }
      }
    }
  )
  ipcMain.handle('dialog:choose-directory', async () => {
    if (!getWindow()) return undefined
    const localPath = (await dialog.showOpenDialog(getWindow()!, { properties: ['openDirectory'] })).filePaths[0]
    return localPath || undefined
  })
  ipcMain.handle('dialog:choose-directories', async () => {
    if (!getWindow()) return []
    const result = await dialog.showOpenDialog(getWindow()!, { properties: ['openDirectory', 'multiSelections'] })
    return result.filePaths
  })
  ipcMain.handle('chat-groups:create-workspace', async (_event, name: string, directories: string[]) => {
    const result = await chatService.createWorkspaceGroup(name, directories)
    await refreshPathRegistry()
    return result
  })
  ipcMain.handle('chat-groups:delete', async (_event, id: string) => {
    await chatService.deleteGroup(id)
    await refreshPathRegistry()
  })

  // === PathRegistry ==========================================================
  ipcMain.handle('path-registry:list', () => pathRegistry.listEntries())

  // === Codegraph =============================================================
  ipcMain.handle('codegraph:list', () => codegraphManager.listAll())
  ipcMain.handle('codegraph:status', (_event, repositoryId: string) => codegraphManager.getStatus(repositoryId))
  ipcMain.handle('codegraph:status-for-path', (_event, localPath: string) =>
    codegraphManager.getStatusByPath(localPath)
  )
  ipcMain.handle('codegraph:build', async (_event, repositoryId: string) => {
    const profile = store.listRepositoryProfiles().find((repo) => repo.id === repositoryId)
    if (!profile) throw new Error('仓库不存在')
    await codegraphManager.ensureIndex(repositoryId, profile.localPath)
    return codegraphManager.getStatusByPath(profile.localPath)
  })
  ipcMain.handle('codegraph:rebuild', async (_event, repositoryId: string) => {
    const profile = store.listRepositoryProfiles().find((repo) => repo.id === repositoryId)
    if (!profile) throw new Error('仓库不存在')
    await codegraphManager.forceRebuild(repositoryId, profile.localPath)
    return codegraphManager.getStatusByPath(profile.localPath)
  })
  ipcMain.handle('codegraph:delete', (_event, repositoryId: string) => {
    codegraphManager.deleteIndex(repositoryId)
  })
  ipcMain.handle('codegraph:update', async (_event, repositoryId: string) => {
    const profile = store.listRepositoryProfiles().find((repo) => repo.id === repositoryId)
    if (!profile) throw new Error('仓库不存在')
    await codegraphManager.updateIndex(repositoryId, profile.localPath)
    return codegraphManager.getStatusByPath(profile.localPath)
  })
  ipcMain.handle('codegraph:build-for-path', async (_event, localPath: string) => {
    await codegraphManager.ensureIndex(`path:${localPath}`, localPath)
    return codegraphManager.getStatusByPath(localPath)
  })
  ipcMain.handle('codegraph:rebuild-for-path', async (_event, localPath: string) => {
    await codegraphManager.forceRebuild(`path:${localPath}`, localPath)
    return codegraphManager.getStatusByPath(localPath)
  })

  // === 自动更新 ==============================================================
  ipcMain.handle('app:version', () => app.getVersion())

  // === 数据目录 ==============================================================
  ipcMain.handle('app:get-data-dir', () => dataDir)
  ipcMain.handle('app:set-data-dir', async (_event, dir: string) => {
    if (!dir || typeof dir !== 'string') throw new Error('无效的数据目录路径')
    if (dir === dataDir) return
    const oldDir = dataDir
    mkdirSync(dir, { recursive: true })
    try {
      cpSync(oldDir, dir, { recursive: true, force: true })
    } catch (error) {
      throw new Error(`数据迁移失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      rmSync(oldDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    writeCustomDataDir(dir)
  })
  ipcMain.handle('app:choose-data-dir', async () => {
    if (!getWindow()) return undefined
    const result = await dialog.showOpenDialog(getWindow()!, {
      title: '选择数据目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.filePaths[0] || undefined
  })
  ipcMain.handle('app:relaunch', () => {
    app.relaunch()
    app.exit(0)
  })

  // === 自动更新 =============================================================
  ipcMain.handle('updater:check', () => checkForUpdates())
  ipcMain.handle('updater:download', () => updaterDownload())
  ipcMain.handle('updater:install', () => quitAndInstall())
  ipcMain.handle('updater:status', () => getUpdateStatus())
}
