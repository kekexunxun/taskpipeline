/**
 * main.ts — Electron 主进程入口 / 组合根。
 *
 * 职责：
 *  1. 数据目录 + store 初始化
 *  2. 提取模块的依赖注入初始化（hitl-mode / model-profile / chat-trace / pi-session / task-lifecycle）
 *  3. 服务单例组装（git / reviewer / workflow / delivery / chat / qoder orchestrator）
 *  4. IPC handler 注册（薄代理层，委托给提取模块）
 *  5. 应用生命周期管理
 *
 * 所有业务逻辑已提取到独立模块，本文件仅负责「接线」。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, nativeImage } from 'electron'
import {
  JsonlTraceStorage,
  type AgentEvent,
  type Task,
  type TaskEventSink,
  type SettingResolver
} from '@task-pipeline/core'
import { redactSecrets, testAtlassianConnectionRest } from '@task-pipeline/integrations'
import { QoderOrchestrator, QoderTraceBuilder } from './pi-extension/qoder/index.js'
import { initAutoUpdater } from './auto-updater.js'
import { TracePipeline } from './trace/bus/trace-pipeline.js'
import type { PiTraceBuilder } from './trace/instrument/pi-trace-builder.js'
import { resolveBundledOcrBinary } from './init/ocr-binary.js'
import { loadMcpServers, saveMcpServers, validateMcpServerEntry, BUILTIN_MCP_IDS } from './mcp/mcp-config.js'
import { listSkills, importSkillZip, importSkillFolder, deleteSkill } from './skill/skill-store.js'
import { MemoryService } from './memory/memory-service.js'
import {
  updateCredential,
  credentialStateSnapshot,
  checkCredentialHealth,
  testMcpConnectionById
} from './credential/credential-state.js'
import { initTaskRunner, loadRepoContext, callOpenAIForPrompt, savePlanDecision } from './task/task-runner.js'
import { keywordRewriterWithTrace, taskMemoryContext } from './memory/memory-context.js'
import { AgentService } from './agents/agent-service.js'
import { AGENT_TEMPLATES } from './agents/templates.js'
import { buildAgentGenerationPrompt, parseAgentGenerationResult } from './agents/agent-generator.js'
// ── 提取模块 ─────────────────────────────────────────────────────────────────
import { resolveQodercliPath } from './init/qodercli-path.js'
import { resolveDataDir, writeCustomDataDir, createAppStores } from './init/data-dir.js'
import { createReviewDeliveryPipeline } from './services/review-delivery.js'
import { createChatSystem } from './chat/chat-init.js'
// ── 提取模块 ─────────────────────────────────────────────────────────────────
import {
  loadHitlModeFromStore,
  getHitlModeForContext,
  setGlobalHitlMode,
  setConversationHitlMode
} from './task/hitl-mode.js'
import {
  initModelProfile,
  readOpenAIProfiles,
  defaultOpenAIProfile,
  openAIApiKeyFor,
  stripOpenAIModelPrefix,
  resolveOpenAIModelValue,
  syncSystemDefaultModel,
  isModelValueAvailable,
  resolveLiteModel
} from './chat/model-profile.js'
import { initChatTraceManager } from './trace/chat-trace-manager.js'
import {
  initPiSession,
  emitPi,
  stopPi,
  syncPiModelConfig,
  requestUi,
  handleAskUserQuestion,
  getActiveTaskId,
  setActiveTaskId,
  getPiSession,
  getPendingUi
} from './task/pi-session.js'
import {
  initTaskLifecycle,
  taskWorkspace,
  updateState,
  runTaskOperation,
  sweepInterruptedTraces,
  getActiveTaskOperations,
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
  taskChangedFiles,
  openEditorForTask,
  mergeBackToBase,
  runReviewWithAutoFix,
  finishImplementation,
  runOperationAgent,
  submitMergeRequestsWithCredWatch,
  stopTaskOperations,
  taskCardsWithCurrentChanges
} from './task/task-lifecycle.js'
import type { TaskBackendId } from './chat/task-backends/index.js'
import { registerIpc } from './ipc/index.js'

// ── Qodercli 路径修复 ────────────────────────────────────────────────────────

resolveQodercliPath()

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_GENERATOR_TASK_ID = '__agent_generator__'
app.setName('TaskPipeline')

// ── 数据目录 + Store ─────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | undefined
const dataDir = resolveDataDir()
const skillsRoot = join(dataDir, 'skills')
const { store, keyStore } = createAppStores(dataDir)

// ── 通用工具 ─────────────────────────────────────────────────────────────────

function protectedValue(key: string): string | undefined {
  return keyStore.resolve(store.getSetting(key), key)
}
function sendTaskEvent(event: Record<string, unknown>): void {
  const json = JSON.stringify(event, (_key, value) => (typeof value === 'string' ? redactSecrets(value) : value))
  mainWindow?.webContents.send('task:event', JSON.parse(json) as unknown)
}
function emitTaskChanged(taskId: string): void {
  sendTaskEvent({ type: 'task_changed', taskId })
}
function addTaskEvent(event: Omit<AgentEvent, 'id' | 'createdAt'>): void {
  emitTaskChanged(event.taskId)
}
function updatePiUsage(taskId: string): void {
  const piSession = getPiSession()
  if (!piSession) return
  const stats = piSession.getSessionStats()
  store.updateTask(taskId, {
    sessionUsage: {
      provider: 'openai',
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheReadTokens: stats.tokens.cacheRead,
      cacheWriteTokens: stats.tokens.cacheWrite,
      totalTokens: stats.tokens.total,
      costUsd: stats.cost,
      turns: stats.assistantMessages
    }
  })
  emitTaskChanged(taskId)
}
function modelProvider(): 'qoder' | 'openai' {
  return protectedValue('qoderToken') ? 'qoder' : 'openai'
}
function runtimeProvider(task: Task): 'qoder' | 'openai' {
  const runtime = agentService.resolveRuntime(task, store.listTaskRepositories(task.id))
  return runtime.provider ?? modelProvider()
}
function providerForTask(taskId: string | undefined): 'qoder' | 'openai' {
  const task = taskId ? store.getTask(taskId) : undefined
  return task ? runtimeProvider(task) : modelProvider()
}
// ── 抽象层宿主实现 ────────────────────────────────────────────────────────────

class DesktopEventSink implements TaskEventSink {
  addEvent(input: Omit<AgentEvent, 'id' | 'createdAt'>): AgentEvent {
    const event = store.addEvent(input)
    emitTaskChanged(input.taskId)
    return event
  }
  emitChanged(taskId: string): void {
    emitTaskChanged(taskId)
  }
}
class DesktopSettingResolver implements SettingResolver {
  get(key: string): string | undefined {
    return store.getSetting(key)
  }
  getSecret(key: string, envName?: string): string | undefined {
    if (envName && process.env[envName]) return process.env[envName]
    return keyStore.resolve(store.getSetting(key), key)
  }
}
const desktopSink = new DesktopEventSink()
const desktopResolver = new DesktopSettingResolver()

// ── 模块初始化 ───────────────────────────────────────────────────────────────

loadHitlModeFromStore(store)
initModelProfile({
  store,
  keyStore,
  getQoderCachedStatus: () => {
    const s = qoderOrch?.getCachedStatus()
    return s ? { ...s, usage: s.usage ?? undefined } : undefined
  },
  resolveLiteModelFromQoder: () => qoderOrch.resolveLiteModel()
})
const memoryService = new MemoryService(store)
const agentService = new AgentService(
  (key) => store.getSetting(key),
  (key, value) => store.setSetting(key, value),
  (repositoryId) => memoryService.listRepoWikiDocs(repositoryId),
  () => syncSystemDefaultModel(),
  (model) => isModelValueAvailable(model)
)
const tracePipeline = new TracePipeline(new JsonlTraceStorage(dataDir), (event) => sendTaskEvent(event))
const piTraceBuilders = new Map<string, PiTraceBuilder>()
initChatTraceManager(tracePipeline)
initPiSession({
  store,
  dataDir,
  tracePipeline,
  protectedValue,
  readOpenAIProfiles,
  defaultOpenAIProfile,
  openAIApiKeyFor,
  providerForTask,
  updatePiUsage,
  emitTaskChanged,
  sendTaskEvent,
  piTraceBuilders,
  getMainWindow: () => mainWindow,
  onFinishImplementation: (taskId, responseTexts) => {
    void runTaskOperation(taskId, (signal) => finishImplementation(taskId, responseTexts, signal)).catch((error) =>
      emitPi({ type: 'agent_error', message: error instanceof Error ? error.message : String(error) })
    )
  }
})

// ── 下沉模块实例 ─────────────────────────────────────────────────────────────

const pipeline = createReviewDeliveryPipeline({
  store,
  dataDir,
  desktopSink,
  desktopResolver,
  getMainWindow: () => mainWindow,
  addTaskEvent: (event) => addTaskEvent(event as Omit<AgentEvent, 'id' | 'createdAt'>)
})
const {
  gitService,
  openAIReviewer,
  buildReviewOrchestrator,
  taskWorkflow,
  deliveryService,
  mergeRefresher,
  taskCompleter,
  atlassianFactory,
  traceService
} = pipeline

// ── Chat 体系 ────────────────────────────────────────────────────────────────

const mcpConfigPath = join(dataDir, 'mcp.json')
const { chatService, chatAttachmentCache } = createChatSystem({
  store,
  dataDir,
  skillsRoot,
  mcpConfigPath,
  getMainWindow: () => mainWindow,
  protectedValue,
  getQoderOrch: () => qoderOrch,
  tracePipeline,
  memoryService,
  agentService,
  atlassianFactory,
  providerForTask,
  modelProvider,
  runtimeProvider,
  desktopResolver,
  addTaskEvent,
  getQoderStatusForHealth: () => qoderOrch.getStatusForHealth(),
  atlassianRestConfig: (kind: string) => atlassianFactory.restConfig(kind as 'jira' | 'confluence'),
  testAtlassianRest: testAtlassianConnectionRest
})

// ── Qoder Orchestrator + Task Runner 初始化 ──────────────────────────────────

// eslint-disable-next-line prefer-const -- forward-referenced by initModelProfile closure
let qoderOrch!: QoderOrchestrator
qoderOrch = new QoderOrchestrator({
  store,
  dataDir,
  taskWorkflow,
  memoryService,
  agentService,
  tracePipeline,
  openAIReviewer,
  addTaskEvent: addTaskEvent as (event: Omit<AgentEvent, 'id' | 'createdAt'>) => void,
  emitPi,
  sendTaskEvent,
  protectedValue,
  updateCredential: (kind, state) => updateCredential(kind, state),
  requestUi: <T>(method: string, payload: Record<string, unknown>, options?: { signal?: AbortSignal }) =>
    requestUi<T>(method, payload, options),
  handleAskUserQuestion,
  updateState,
  runTaskOperation,
  runtimeProvider,
  providerForTask,
  resolveAgentContext: async (task, repos) => {
    const context = await agentService.resolveAgentContext(task, repos)
    if (context.sections.length)
      addTaskEvent({
        taskId: task.id,
        kind: 'status',
        title: '注入 Agent 上下文',
        detail: context.sections.join('\n\n')
      })
    return context
  },
  resolveModel: (task) => agentService.resolveModelForTask(task, store.listTaskRepositories(task.id)),
  resolveTestContext: async (task, repos) => {
    const { roleBody, contextBody } = agentService.resolveOperationAgent('test', task, repos)
    const sections: string[] = []
    if (roleBody) sections.push(roleBody)
    if (contextBody) sections.push(contextBody)
    if (sections.length)
      addTaskEvent({ taskId: task.id, kind: 'status', title: '注入测试 Agent 上下文', detail: sections.join('\n\n') })
    return { sections }
  },
  resolveMemoryContext: taskMemoryContext,
  getHitlMode: (contextType, contextId) => getHitlModeForContext(contextType, contextId, store),
  getActiveTaskId: () => getActiveTaskId(),
  setActiveTaskId: (id) => setActiveTaskId(id),
  finishImplementation,
  resolveOpenAIModelValue: () => resolveOpenAIModelValue(),
  syncSystemDefaultModel: () => syncSystemDefaultModel(),
  storeGetSetting: (key) => store.getSetting(key),
  taskChangedFiles,
  savePlanDecision
})
initTaskLifecycle({
  store,
  dataDir,
  tracePipeline,
  traceService,
  memoryService,
  agentService,
  taskWorkflow,
  gitService,
  deliveryService,
  mergeRefresher,
  taskCompleter,
  atlassianFactory,
  qoderOrch,
  openAIReviewer,
  piTraceBuilders,
  protectedValue,
  providerForTask,
  runtimeProvider,
  modelProvider,
  addTaskEvent: addTaskEvent as (event: Omit<AgentEvent, 'id' | 'createdAt'>) => void,
  emitTaskChanged,
  sendTaskEvent,
  updatePiUsage,
  buildReviewOrchestrator,
  submitMergeRequestsWithCredentialWatch: submitMergeRequestsWithCredWatch,
  resolveOpenAIModelValue,
  defaultOpenAIProfile,
  openAIApiKeyFor
})
initTaskRunner({
  store,
  protectedValue,
  addTaskEvent: addTaskEvent as (event: Omit<AgentEvent, 'id' | 'createdAt'>) => void,
  emitPi,
  tracePipeline,
  openAIReviewer,
  agentService,
  qoderOrchestrator: qoderOrch,
  memoryService,
  taskWorkflow,
  providerForTask,
  defaultOpenAIProfile,
  openAIApiKeyFor,
  stripOpenAIModelPrefix,
  resolveLiteModel,
  updateState,
  submitMergeRequestsWithCredentialWatch: submitMergeRequestsWithCredWatch,
  taskChangedFiles,
  runReviewWithAutoFix,
  runOperationAgent
})

const keywordRewriter = (query: string) => keywordRewriterWithTrace(query)

// ── IPC 路由 ─────────────────────────────────────────────────────────────────

function listTaskBackends(): Array<{ id: TaskBackendId; displayName: string; configured: boolean }> {
  const jiraConfigured = !!(desktopResolver.get('jiraBaseUrl') && desktopResolver.get('jiraApiToken'))
  return [
    { id: 'jira', displayName: 'Jira', configured: jiraConfigured },
    { id: 'github', displayName: 'GitHub Issues', configured: false },
    { id: 'linear', displayName: 'Linear', configured: false }
  ]
}

registerIpc({
  getWindow: () => mainWindow,
  dataDir,
  skillsRoot,
  mcpConfigPath,
  store: store as never,
  keyStore,
  taskCardsWithCurrentChanges: taskCardsWithCurrentChanges as never,
  getActiveTaskOperations: getActiveTaskOperations as never,
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
  stopTaskOperations: stopTaskOperations as never,
  runTaskOperation,
  taskChangedFiles,
  taskWorkspace,
  openEditorForTask,
  mergeBackToBase,
  runReviewWithAutoFix,
  submitMergeRequestsWithCredWatch,
  getPendingUi: getPendingUi as never,
  taskWorkflow: taskWorkflow as never,
  deliveryService: deliveryService as never,
  mergeRefresher,
  taskCompleter: taskCompleter as never,
  gitService: gitService as never,
  atlassianFactory: atlassianFactory as never,
  qoderOrch: qoderOrch as never,
  chatService,
  chatAttachmentCache,
  memoryService,
  agentService,
  tracePipeline,
  traceService,
  getHitlModeForContext: (contextType, contextId) => getHitlModeForContext(contextType, contextId, store),
  setGlobalHitlMode,
  setConversationHitlMode,
  loadMcpServers,
  saveMcpServers,
  validateMcpServerEntry: validateMcpServerEntry as never,
  BUILTIN_MCP_IDS,
  testMcpConnectionById,
  listSkills,
  importSkillZip,
  importSkillFolder: importSkillFolder as never,
  deleteSkill,
  credentialStateSnapshot,
  checkCredentialHealth,
  AGENT_TEMPLATES,
  loadRepoContext,
  buildAgentGenerationPrompt,
  parseAgentGenerationResult,
  callOpenAIForPrompt,
  stripOpenAIModelPrefix: stripOpenAIModelPrefix as never,
  listTaskBackends,
  writeCustomDataDir,
  syncPiModelConfig,
  keywordRewriter,
  QoderTraceBuilder,
  AGENT_GENERATOR_TASK_ID
})

// ── 窗口创建 ─────────────────────────────────────────────────────────────────

function resolveAppIcon(): Electron.NativeImage | undefined {
  for (const candidate of [
    join(__dirname, '../build/icon.normalized.png'),
    join(__dirname, '../build/icon.png'),
    join(__dirname, '../dist/icon.png')
  ]) {
    if (!existsSync(candidate)) continue
    const image = nativeImage.createFromPath(candidate)
    if (!image.isEmpty()) return image
  }
  return undefined
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#111210',
    icon: resolveAppIcon(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }
  })
  if (process.env.VITE_DEV_SERVER_URL) await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  else await mainWindow.loadFile(join(__dirname, '../dist/index.html'))
}

// ── App 生命周期 ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (process.platform === 'darwin' && process.env.VITE_DEV_SERVER_URL) {
    const icon = resolveAppIcon()
    if (icon) app.dock?.setIcon(icon)
  }
  if (!resolveBundledOcrBinary()) {
    console.warn(
      '[ocr] @alibaba-group/open-code-review not found in node_modules; reviews will fall back to PATH lookup and may fail in packaged builds.'
    )
  }
  initAutoUpdater()
  void createWindow()
  sweepInterruptedTraces()
  for (const repo of store.listRepositoryProfiles()) {
    void memoryService
      .refreshRepoWiki(repo.id, repo.localPath)
      .catch((error) => console.warn('[repowiki] startup index failed:', error))
  }
  const mergeTimer = setInterval(() => {
    void mergeRefresher.refresh()
  }, 60_000)
  mergeTimer.unref()
  app.on('browser-window-focus', () => {
    void mergeRefresher.refresh()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow()
  } else if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

let isQuitting = false
let storeClosed = false
function safeCloseStore(): void {
  if (storeClosed) return
  storeClosed = true
  try {
    store.close()
  } catch {
    /* already closed */
  }
}
app.on('before-quit', (event) => {
  if (!isQuitting) {
    isQuitting = true
    event.preventDefault()
    void (async () => {
      try {
        await chatService.abortAllActiveStreams()
      } catch {
        /* ignore */
      }
      void stopPi()
      safeCloseStore()
      app.quit()
    })()
    return
  }
  void stopPi()
  safeCloseStore()
})
