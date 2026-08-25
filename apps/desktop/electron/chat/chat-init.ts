/**
 * Chat 子系统组装：MCP resolver / Credential / Driver 注册 / Memory context / ChatService 实例化。
 *
 * 从 main.ts "Chat 体系" 段提取，封装完整的 Chat 系统创建流程。
 * 通过 deps 对象注入外部依赖，返回 Chat 系统核心实例。
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { TaskStore, AgentEvent, SettingResolver, Task } from '@task-pipeline/core'
import type { AtlassianClientFactory, testAtlassianConnectionRest } from '@task-pipeline/integrations'
import {
  describeToolAction,
  isDangerousTool,
  isBuiltinWriteTool,
  isWriteTool
} from '../agents/task-agent/dangerous-tools.js'
import { initCredentialState } from '../credential/credential-state.js'
import { loadMcpServers } from '../mcp/mcp-config.js'
import { createMcpServiceResolver } from '../mcp/mcp-services.js'
import { renderMemoryContext } from '../memory/memory-service.js'
import type { MemoryService } from '../memory/memory-service.js'
import { initMemoryContext, keywordRewriterWithTrace, consolidateChatMemory } from '../memory/memory-context.js'
import { QoderChatDriver } from '../pi-extension/qoder/index.js'
import type { QoderOrchestrator } from '../pi-extension/qoder/index.js'
import { readSkillContent } from '../skill/skill-store.js'
import { getHitlModeForContext } from '../task/hitl-mode.js'
import { handleAskUserQuestion, prettyToolName, requestUi } from '../task/pi-session.js'
import { startTaskStageSpan } from '../task/task-runner.js'
import { chatTraceManager } from '../trace/chat-trace-manager.js'
import type { TracePipeline } from '../trace/bus/trace-pipeline.js'
import type { AgentService } from '../agents/agent-service.js'
import { ChatAttachmentCache } from './chat-attachment-cache.js'
import { ChatService } from './chat-service.js'
import { ChatDriverRegistry } from './drivers/driver-registry.js'
import { OpenAIChatDriver } from './drivers/openai-chat-driver.js'
import { JiraTaskCreationBackend } from './task-backends/jira.js'
import type { ModelProfile } from './model-profile.js'
import {
  resolveOpenAIModelValue,
  syncSystemDefaultModel,
  isModelValueAvailable,
  resolveLiteModel
} from './model-profile.js'

export interface ChatSystemDeps {
  store: TaskStore
  dataDir: string
  skillsRoot: string
  mcpConfigPath: string
  getMainWindow: () => BrowserWindow | undefined
  protectedValue: (key: string) => string | undefined
  getQoderOrch: () => QoderOrchestrator
  tracePipeline: TracePipeline
  memoryService: MemoryService
  agentService: AgentService
  atlassianFactory: AtlassianClientFactory
  providerForTask: (taskId: string | undefined) => string
  modelProvider: () => string
  runtimeProvider: (task: Task) => string
  desktopResolver: SettingResolver
  addTaskEvent: (event: Omit<AgentEvent, 'id' | 'createdAt'>) => void
  getQoderStatusForHealth: () => unknown
  atlassianRestConfig: (kind: string) => unknown
  testAtlassianRest: typeof testAtlassianConnectionRest
}

export interface ChatSystem {
  chatService: ChatService
  chatMcpResolver: ReturnType<typeof createMcpServiceResolver>
  chatAttachmentCache: ChatAttachmentCache
}

export function createChatSystem(deps: ChatSystemDeps): ChatSystem {
  const {
    store,
    dataDir,
    skillsRoot,
    mcpConfigPath,
    getMainWindow,
    protectedValue,
    getQoderOrch,
    tracePipeline,
    memoryService,
    agentService,
    atlassianFactory,
    modelProvider,
    runtimeProvider,
    desktopResolver
  } = deps

  // ── MCP Resolver ──────────────────────────────────────────────────────────
  const chatMcpResolver = createMcpServiceResolver(() => loadMcpServers(mcpConfigPath), {
    getSetting: (key: string) => store.getSetting(key),
    getSecret: (key: string) => protectedValue(key)
  })

  // ── Credential State ──────────────────────────────────────────────────────
  initCredentialState({
    getWindow: getMainWindow,
    store,
    protectedValue,
    getQoderStatusForHealth: () => getQoderOrch().getStatusForHealth(),
    atlassianRestConfig: (kind) => atlassianFactory.restConfig(kind),
    testAtlassianRest: deps.testAtlassianRest,
    mcpProfileResolver: chatMcpResolver
  })

  // ── Skill Content ─────────────────────────────────────────────────────────
  const resolveSkillContent = (names: string[]): string | undefined => {
    const parts = names
      .map((name) => readSkillContent(skillsRoot, name))
      .filter((part): part is string => Boolean(part))
    return parts.length > 0 ? parts.join('\n\n') : undefined
  }

  // ── Driver Registry ───────────────────────────────────────────────────────
  const chatAttachmentCache = new ChatAttachmentCache(dataDir)
  const chatDriverRegistry = new ChatDriverRegistry()

  chatDriverRegistry.register(
    new QoderChatDriver(
      () => protectedValue('qoderToken'),
      () => getQoderOrch().getStatus(),
      tracePipeline,
      chatMcpResolver,
      async (toolName, toolInput, { signal, conversationId, title, displayName, description }) => {
        if (toolName === 'AskUserQuestion') {
          const answers = await handleAskUserQuestion(toolInput, { signal, conversationId })
          if (answers && answers.length > 0) return { type: 'askUser' as const, answers }
          return { type: 'deny' as const, message: '用户取消了问答，请选择其他方式继续任务' }
        }
        const hitlMode = getHitlModeForContext('conversation', conversationId, store)
        if (hitlMode === 'yolo') return 'allow'
        const needsConfirm =
          hitlMode === 'auto'
            ? isDangerousTool(toolName, toolInput)
            : toolName.startsWith('mcp__')
              ? isWriteTool(toolName)
              : isBuiltinWriteTool(toolName) || isDangerousTool(toolName, toolInput)
        if (!needsConfirm) return 'allow'
        const detail = describeToolAction(toolName, toolInput)
        const trimmed = detail.length > 500 ? `${detail.slice(0, 500)}…(已截断)` : detail
        const descLine = description ? (description.length > 300 ? `${description.slice(0, 300)}…` : description) : ''
        const lines = [descLine, conversationId ? `对话 ${conversationId}` : '', trimmed].filter(Boolean)
        const ok =
          (await requestUi<boolean>(
            'confirm',
            {
              title: `允许执行 ${prettyToolName(displayName ?? title ?? toolName)}?`,
              message: lines.join('\n\n'),
              conversationId,
              toolName,
              toolInput: typeof toolInput === 'object' && toolInput !== null ? toolInput : {}
            },
            { signal }
          )) ?? false
        return ok ? 'allow' : 'deny'
      },
      dataDir,
      chatAttachmentCache
    )
  )

  chatDriverRegistry.register(
    new OpenAIChatDriver(
      store,
      (profile: ModelProfile | undefined) => {
        if (profile?.id) {
          const scoped = protectedValue(`modelApiKey:${profile.id}`)
          if (scoped) return scoped
        }
        if (profile?.isDefault || !profile?.id) return protectedValue('modelApiKey')
        return undefined
      },
      tracePipeline,
      chatMcpResolver,
      resolveSkillContent,
      chatAttachmentCache
    )
  )

  // ── Memory Context ────────────────────────────────────────────────────────
  initMemoryContext({
    store,
    memoryService,
    chatDriverRegistry,
    agentService,
    tracePipeline,
    addTaskEvent: deps.addTaskEvent,
    runtimeProvider,
    modelProvider,
    resolveOpenAIModelValue,
    syncSystemDefaultModel,
    isModelValueAvailable,
    resolveLiteModel,
    startTaskStageSpan
  })

  // ── Chat Service ──────────────────────────────────────────────────────────
  function resolveDefaultBackend(): 'jira' | 'github' | 'linear' {
    const hint = desktopResolver.get('taskCreationBackend')
    if (hint === 'jira' || hint === 'github' || hint === 'linear') return hint
    return 'jira'
  }

  const chatService = new ChatService(
    store,
    dataDir,
    chatDriverRegistry,
    getMainWindow,
    () => {
      if (resolveDefaultBackend() === 'jira') return new JiraTaskCreationBackend(atlassianFactory)
      return undefined
    },
    async ({ conversationId, query, workingDirectory }) => {
      const turnTraceId = chatTraceManager.traceIdForChat(conversationId)
      const repositoryIds = workingDirectory
        ? store
            .listRepositoryProfiles()
            .filter((repo) => workingDirectory === repo.localPath || workingDirectory.startsWith(repo.localPath + '/'))
            .map((repo) => repo.id)
        : []
      const result = await memoryService.search({
        userId: memoryService.ensureUserId(),
        repositoryIds: repositoryIds.length ? repositoryIds : undefined,
        conversationId,
        query,
        keywordRewriter: (q: string) => keywordRewriterWithTrace(q, turnTraceId)
      })
      if (turnTraceId && tracePipeline.isActive(turnTraceId)) {
        const span = tracePipeline.startSpan(turnTraceId, {
          type: 'tool.execute',
          name: '记忆与 Repowiki 检索',
          input: { query, keywords: result.keywords }
        })
        tracePipeline.endSpan(turnTraceId, span, {
          output: {
            memories: result.memories.map((m) => ({
              scope: m.scope,
              title: m.title,
              snippet: m.content.slice(0, 200)
            })),
            wikiDocs: result.wikiDocs.map((doc) => ({
              path: doc.path,
              title: doc.title,
              snippet: doc.content.slice(0, 200)
            }))
          }
        })
      }
      return renderMemoryContext(result.memories, result.wikiDocs)
    },
    consolidateChatMemory,
    chatTraceManager,
    async (workingDirectory: string | undefined) => {
      if (!workingDirectory) return undefined
      try {
        const groups = await chatService.listGroups()
        const workspace = groups.find((g) => g.chatType === 'workspace' && g.directories.includes(workingDirectory))
        if (!workspace) return undefined
        const parts: string[] = []
        const dirList = workspace.directories.map((dir) => `- ${dir}`).join('\n')
        parts.push(
          `<project_instructions>\nThe absolute path(s) of the user's workspace(s) are: \n${dirList}\n</project_instructions>`
        )
        const os = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'
        const shellName = process.env.SHELL || (process.platform === 'win32' ? 'powershell' : 'bash')
        parts.push(`<user_info>\nUser's OS: ${os}\nUser's shell: ${shellName}\n</user_info>`)
        const agentsEntries: string[] = []
        for (const dir of workspace.directories) {
          let content: string | undefined
          for (const filename of ['AGENTS.md', 'agents.md']) {
            const agentsFile = join(dir, filename)
            if (existsSync(agentsFile)) {
              try {
                content = readFileSync(agentsFile, 'utf8')
                break
              } catch {
                /* continue */
              }
            }
          }
          if (content) {
            const projectName = basename(dir)
            agentsEntries.push(`  --- Contents of ${dir}/AGENTS.md (project: ${projectName}) ---\n${content}`)
          }
        }
        if (agentsEntries.length > 0) {
          parts.push(
            `<agents_instructions>\n  The following instructions are from the AGENTS.MD.\n  These instructions provide guidance for AI agents working on this project.\n\n${agentsEntries.join('\n\n')}\n</agents_instructions>`
          )
        }
        return parts.join('\n\n')
      } catch {
        return undefined
      }
    }
  )

  return {
    chatService,
    chatMcpResolver,
    chatAttachmentCache
  }
}
