import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { isToolCallEventType, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  LocalFileKeyStore,
  TaskStore,
  type AgentEvent,
  type McpProfile,
  type SettingResolver,
  type Task,
  type TaskEventSink,
  type TaskState
} from '@task-pipeline/core'
import {
  AtlassianClientFactory,
  DeliveryService,
  GitService,
  McpClient,
  MergeStatusRefresher,
  OpenAICompatReviewer,
  OpenCodeReviewService,
  ReviewOrchestrator,
  syncJiraTasks,
  TaskCompleter,
  TaskWorkflow,
  testAtlassianConnection
} from '@task-pipeline/integrations'
import { DockerToolRouter } from './sandbox.js'
import { evaluatePermission } from './permission.js'
import { PiAgentPlanModeProvider } from './plan-mode.js'

const dataDir = process.env.TASK_PIPELINE_DATA_DIR ?? join(homedir(), '.task-pipeline')
const store = new TaskStore(join(dataDir, 'task-pipeline.db'))
const keyStore = new LocalFileKeyStore(dataDir)
const owner = `pi:${process.pid}`
const sandboxRouter = new DockerToolRouter(store, () => selectedTask(''), process.env.DOCKER_BINARY ?? 'docker')

// === 抽象层宿主实现 ===========================================================

/**
 * Pi 端的 TaskEventSink。
 *
 * Pi Extension 没有 IPC 推送通道,这里只把事件落库,前端通过下次拉取
 * `tasks:list` / `tasks:get` 时拿到最新状态。`emitChanged` 留空,
 * 需要时宿主可以扩展为通过 `ctx.ui.notify` 提示用户刷新。
 */
class PiEventSink implements TaskEventSink {
  addEvent(input: Omit<AgentEvent, 'id' | 'createdAt'>): AgentEvent {
    return store.addEvent(input)
  }
  emitChanged(_taskId: string): void {
    /* Pi 无 IPC,依赖下次拉取;保留空实现便于接口契约 */
  }
}

/** Pi 端的 SettingResolver:读 setting + 解密 secret,语义与 desktop 一致。 */
class PiSettingResolver implements SettingResolver {
  get(key: string): string | undefined {
    return store.getSetting(key)
  }
  getSecret(key: string, envName?: string): string | undefined {
    if (envName && process.env[envName]) return process.env[envName]
    return keyStore.resolve(store.getSetting(key), key)
  }
}

const piSink = new PiEventSink()
const piResolver = new PiSettingResolver()
const gitService = new GitService()
const ocrService = new OpenCodeReviewService(store.getSetting('ocrBinary') ?? process.env.OCR_BINARY ?? 'ocr')
const openAIReviewer = new OpenAICompatReviewer(piResolver)
function buildReviewOrchestrator(): ReviewOrchestrator {
  return new ReviewOrchestrator({ ocr: ocrService, git: gitService, reviewer: openAIReviewer }, piSink)
}
const taskWorkflow = new TaskWorkflow(store, piResolver, piSink, (taskId) => join(dataDir, 'workspaces', taskId))
const mergeRefresher = new MergeStatusRefresher(store, piResolver, piSink)
const taskCompleter = new TaskCompleter(store, piSink)
const atlassianFactory = new AtlassianClientFactory(piResolver)

/**
 * 把解密后的 token 注入到 McpProfile.env,使 McpClient 内部
 * `this.env[this.profile.tokenEnv]` 能拿到。注意不能改 tokenEnv 自身,
 * McpClient 内部会通过 env[tokenEnv] 取值,所以这里把 token 写入 env 即可。
 */
function buildJiraClient(profile: McpProfile): McpClient {
  const token = configuredSecret('jiraToken', profile.tokenEnv)
  if (!token) return new McpClient(profile)
  const envName = profile.tokenEnv ?? 'JIRA_TOKEN'
  return new McpClient({ ...profile, env: { ...profile.env, [envName]: token } })
}

/**
 * Pi 端的 DeliveryService 实例。
 * 每次调用都新建一个,因为要注入 `ctx.ui.confirm` 作为 approver。
 */
function buildDeliveryService(ctx: {
  ui: { confirm(title: string, message: string): Promise<boolean> }
}): DeliveryService {
  return new DeliveryService(store, gitService, piResolver, piSink, {
    approver: async (task, kind, context) => {
      // 与 desktop 端一致：默认"常规可行"不弹窗；deliveryConfirm=true 时才逐步骤确认。
      if (piResolver.get('deliveryConfirm') !== 'true') return true
      const approval = store.addApproval({ taskId: task.id, kind, context })
      const accepted = await ctx.ui.confirm(`确认${kind}：${task.title}`, `${task.title}\n\n${context}`)
      store.resolveApproval(approval.id, accepted ? 'approved' : 'rejected')
      return accepted
    }
  })
}

function selectedTask(args: string): Task | undefined {
  const id = args.trim() || store.getSetting('activeTaskId') || ''
  return id ? store.getTask(id) : undefined
}

function setState(task: Task, state: TaskState): Task {
  const updated = store.updateTask(task.id, { state })
  store.addEvent({ taskId: task.id, kind: 'status', title: `状态更新为 ${state}` })
  return updated
}

function configuredSecret(settingKey: string, envName?: string): string | undefined {
  if (envName && process.env[envName]) return process.env[envName]
  return keyStore.resolve(store.getSetting(settingKey), settingKey)
}

export default function codingAgentExtension(pi: ExtensionAPI) {
  // L3: 先注册 --subagent-nonce flag,让 pi CLI parser 知道怎么解析
  // (父进程会传 --subagent-nonce <nonce> + TASK_PIPELINE_SUBAGENT_NONCE env,
  // 子进程能同步读到,身份才能对上)
  pi.registerFlag('subagent-nonce', {
    description: '由 spawn 子进程时注入,守卫三重身份校验',
    type: 'string'
  })
  // 三重身份校验:env + ppid + flag nonce 三者一致才认是合法子进程。
  // 子进程需要跳过 sandbox 注册 / 拦戠器 / 命令注册等整套 setup。
  if (isSubagentProcess(pi)) return
  sandboxRouter.register(pi, process.cwd())
  pi.on('session_start', async (_event) => {
    const mode = await sandboxRouter.check()
    store.setSetting('sandboxStatus', mode)
    const task = selectedTask('')
    if (task)
      store.addEvent({
        taskId: task.id,
        kind: 'status',
        title: mode === 'docker' ? '执行环境：Docker 沙箱' : '执行环境：本机',
        detail: mode === 'docker' ? '系统已自动选择 Docker 沙箱' : 'Docker 服务不可用，系统已自动回退到本机执行'
      })
  })
  pi.on('session_shutdown', async () => {
    await sandboxRouter.stop()
  })

  pi.on('tool_call', async (event, ctx) => {
    const input = event.input as Record<string, unknown>
    const task = selectedTask('')
    const roots = task
      ? store.listTaskRepositories(task.id).map((repo) => resolvePath(repo.worktreePath ?? repo.localPath))
      : []
    const decision = evaluatePermission(event.toolName, input, roots, sandboxRouter.activeCwd(process.cwd()))
    if (decision.action === 'allow') return undefined
    if (decision.action === 'block') return { block: true, reason: decision.reason }
    if (!isToolCallEventType('bash', event)) return { block: true, reason: decision.reason }
    const command = event.input.command
    if (!ctx.hasUI) return { block: true, reason: '受保护命令在无交互模式下默认拒绝' }
    const allowed = await ctx.ui.confirm('受保护命令', `${command}\n\n确认执行？`)
    if (!allowed) return { block: true, reason: '用户拒绝执行' }
    if (task) store.addEvent({ taskId: task.id, kind: 'permission', title: '已批准受保护命令', detail: command })
    return undefined
  })

  pi.registerCommand('tasks', {
    description: '查看 Todo、InProgress、InReview 和 Done 任务',
    handler: async (_args, ctx) => {
      const cards = store.listCards()
      const text = [
        `Todo：${cards.filter((task) => task.boardColumn === 'todo').length}`,
        `InProgress：${cards.filter((task) => task.boardColumn === 'in_progress').length}`,
        `InReview：${cards.filter((task) => task.boardColumn === 'in_review').length}`,
        `Done：${cards.filter((task) => task.boardColumn === 'done').length}`,
        '',
        ...store
          .listTasks()
          .map((task) => `${task.id.slice(0, 8)}  [${task.state}] ${task.taskKey ?? 'LOCAL'} ${task.title}`)
      ].join('\n')
      ctx.ui.notify(text, 'info')
    }
  })

  pi.registerCommand('task-open', {
    description: '打开并编辑任务：/task-open <task-id>',
    handler: async (args, ctx) => {
      const task = selectedTask(args)
      if (!task) return ctx.ui.notify('找不到任务', 'error')
      store.setSetting('activeTaskId', task.id)
      const description = await ctx.ui.editor(
        `编辑 ${task.taskKey ?? task.id.slice(0, 8)}：${task.title}`,
        task.description
      )
      if (description !== undefined && description !== task.description) store.updateTask(task.id, { description })
      ctx.ui.notify(`当前任务：${task.title}`, 'info')
    }
  })

  pi.registerCommand('task-start', {
    description: '确认并开始任务：/task-start <task-id>',
    handler: async (args, ctx) => {
      const taskId = args.trim() || store.getSetting('activeTaskId') || ''
      if (!taskId) return ctx.ui.notify('找不到任务', 'error')
      let task = store.getTask(taskId)
      if (!task) return ctx.ui.notify('找不到任务', 'error')
      if (!store.acquireLease(task.id, owner, 120_000))
        return ctx.ui.notify('任务正在另一个 Pi/GUI 会话中运行', 'warning')
      if (task.state === 'draft') {
        const approved = await ctx.ui.confirm('确认任务', `${task.title}\n\n${task.description}`)
        if (!approved) {
          store.releaseLease(task.id, owner)
          return
        }
        task = setState(task, 'confirmed')
      }
      const selection = await ctx.ui.select('启动方式', ['直接开始', '先生成计划'])
      if (!selection) {
        store.releaseLease(task.id, owner)
        return
      }
      const mode = selection === '先生成计划' ? 'plan' : 'direct'
      try {
        await taskWorkflow.begin(task.id, mode)
      } catch (error) {
        store.releaseLease(task.id, owner)
        return ctx.ui.notify(`准备环境失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
      store.setSetting('activeTaskId', task.id)
      if (mode === 'plan') {
        // plan 阶段:走子 agent 隔离,spawn 一个只读工具集的子 pi 进程跑 planner。
        // 主 session 的 active tools / hook 完全不动,plan 结束后也不需要还原。
        const planProvider = new PiAgentPlanModeProvider()
        const primaryRepo = store.listTaskRepositories(task.id)[0]!
        const cwd = primaryRepo.worktreePath ?? primaryRepo.localPath
        ctx.ui.notify('正在生成计划…', 'info')
        let parsed
        try {
          parsed = await planProvider.runPlan({ task, feedback: undefined }, { cwd, hardTimeoutMs: 5 * 60_000 })
        } catch (error) {
          store.releaseLease(task.id, owner)
          return ctx.ui.notify(`生成计划失败：${error instanceof Error ? error.message : String(error)}`, 'error')
        }

        let planForApproval: string
        if (parsed.outcome === 'unparsed') {
          store.releaseLease(task.id, owner)
          return ctx.ui.notify('planner 输出无法解析为 plan', 'error')
        } else if (parsed.outcome === 'already_satisfied') {
          const changedGroups = await Promise.all(
            store.listTaskRepositories(task.id).map(async (repo) => {
              const files = await gitService.changedFiles(repo.worktreePath ?? repo.localPath, repo.baseBranch)
              return files.map((file) => ({ repositoryName: repo.name, ...file }))
            })
          )
          const changedFiles = changedGroups.flat()
          if (changedFiles.length === 0) {
            taskWorkflow.completeWithoutChanges(task.id, parsed.summary)
            store.releaseLease(task.id, owner)
            ctx.ui.notify('代码已满足任务要求，任务已自动完成', 'info')
            return
          }
          planForApproval = [
            '## 需要人工确认',
            '',
            `Agent 判断当前代码已满足任务要求，但系统检测到 ${changedFiles.length} 个文件变化，因此任务未自动完成。`,
            '',
            parsed.summary,
            '',
            '## 检测到的文件变化',
            '',
            ...changedFiles.map((file) => `- ${file.repositoryName}: ${file.path} (${file.status})`)
          ].join('\n')
          store.updateTask(task.id, { summary: '计划结论与文件状态不一致，等待确认' })
        } else {
          planForApproval = parsed.plan
        }
        taskWorkflow.setPlan(task.id, planForApproval)
        const choice = await ctx.ui.select('计划已生成', ['批准并开始', '补充意见并重新生成', '稍后确认'])
        if (choice === '批准并开始') {
          const approval = store.addApproval({ taskId: task.id, kind: 'plan', context: planForApproval })
          store.resolveApproval(approval.id, 'approved')
          await taskWorkflow.approvePlan(task.id)
          pi.sendUserMessage(`按已批准计划实现任务：\n\n${planForApproval}`, { deliverAs: 'followUp' })
        } else if (choice === '补充意见并重新生成') {
          const feedback = await ctx.ui.editor('计划调整意见', '')
          if (feedback?.trim()) {
            taskWorkflow.revisePlan(task.id)
            pi.sendUserMessage(`根据以下意见重新生成完整计划，仍然禁止修改文件：\n\n${feedback.trim()}`, {
              deliverAs: 'followUp'
            })
          }
        }
      } else {
        pi.sendUserMessage(`开始实现任务：\n\n${task.title}\n\n${task.description}`, { deliverAs: 'followUp' })
        ctx.ui.notify('worktree 与准备命令已完成，开始实现。', 'info')
      }
    }
  })

  pi.registerCommand('review', {
    description: '对当前任务运行 Open Code Review（委托模式：ocr rule + LLM）',
    handler: async (args, ctx) => {
      const taskId = args.trim() || store.getSetting('activeTaskId') || ''
      if (!taskId) return ctx.ui.notify('没有活动任务', 'error')
      try {
        await taskWorkflow.runReview(taskId, buildReviewOrchestrator())
        const task = store.getTask(taskId)
        if (!task) return
        if (task.reviewStatus === 'blocked') ctx.ui.notify('Review 存在阻断问题', 'warning')
        else if (task.reviewStatus === 'passed') ctx.ui.notify('Review 已通过', 'info')
      } catch (error) {
        ctx.ui.notify(`Review 失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
  })

  pi.registerCommand('task-reset-review', {
    description: '重置 review 状态（reviewing → review_blocked）',
    handler: async (args, ctx) => {
      const taskId = args.trim() || store.getSetting('activeTaskId') || ''
      if (!taskId) return ctx.ui.notify('找不到任务', 'error')
      try {
        taskWorkflow.resetReview(taskId)
        ctx.ui.notify('review 状态已重置', 'info')
      } catch (error) {
        ctx.ui.notify(`重置失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
  })

  pi.registerCommand('jira-sync', {
    description: '通过已配置的 Jira MCP 同步任务',
    handler: async (_args, ctx) => {
      const raw = store.getSetting('jiraMcpProfile')
      if (!raw) return ctx.ui.notify('请先在 GUI 设置 Jira MCP Profile', 'warning')
      const profile = JSON.parse(raw) as McpProfile
      // 委托给下沉的 syncJiraTasks,逻辑与 desktop 一致(分页 / status 字段映射 / lastJiraSync 设置)
      const client = buildJiraClient(profile)
      try {
        const tasks = await syncJiraTasks(client, store)
        ctx.ui.notify(`Jira MCP 同步完成：已更新 ${tasks.length} 个任务`, 'info')
      } catch (error) {
        ctx.ui.notify(`Jira 同步失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
  })

  pi.registerCommand('jira-test', {
    description: '测试当前 Jira MCP 配置是否可用',
    handler: async (_args, ctx) => {
      const client = atlassianFactory.create('jira')
      try {
        const result = await testAtlassianConnection(client, 'jira')
        ctx.ui.notify(result.message, result.ok ? 'info' : 'error')
      } catch (error) {
        ctx.ui.notify(`连接失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
  })

  pi.registerCommand('deliver', {
    description: '提交并交付当前任务（commit --no-verify + push 90s + GitLab MR）',
    handler: async (args, ctx) => {
      const taskId = args.trim() || store.getSetting('activeTaskId') || ''
      if (!taskId) return ctx.ui.notify('没有活动任务', 'error')
      const task = store.getTask(taskId)
      if (!task) return ctx.ui.notify('没有活动任务', 'error')
      if (task.state !== 'awaiting_commit') return ctx.ui.notify(`当前状态 ${task.state} 不允许交付`, 'warning')
      const gitlabProfile = gitlabProfileFromStore()
      if (!gitlabProfile?.baseUrl) return ctx.ui.notify('GitLab 配置不完整：缺少实例地址', 'error')
      const token = configuredSecret('gitlabToken', gitlabProfile.tokenEnv)
      if (!token) return ctx.ui.notify('GitLab Token 未通过环境变量或加密配置提供', 'error')
      const delivery = buildDeliveryService(ctx)
      try {
        await delivery.submitMergeRequests(taskId)
        const updated = store.getTask(taskId)
        if (updated?.state === 'await_merge') ctx.ui.notify('交付完成', 'info')
        else ctx.ui.notify(`任务已退到 ${updated?.state}`, 'warning')
      } catch (error) {
        ctx.ui.notify(`提交失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
  })

  pi.registerCommand('task-reset-delivery', {
    description: '重置提交 MR 状态（delivering → awaiting_commit）',
    handler: async (args, ctx) => {
      const taskId = args.trim() || store.getSetting('activeTaskId') || ''
      if (!taskId) return ctx.ui.notify('找不到任务', 'error')
      try {
        new DeliveryService(store, gitService, piResolver, piSink).resetDelivery(taskId)
        ctx.ui.notify('提交状态已重置', 'info')
      } catch (error) {
        ctx.ui.notify(`重置失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
  })

  pi.registerCommand('task-manual-complete', {
    description: '手动结束 await_merge 任务（跳过未合并 MR）',
    handler: async (args, ctx) => {
      const taskId = args.trim() || store.getSetting('activeTaskId') || ''
      if (!taskId) return ctx.ui.notify('找不到任务', 'error')
      try {
        taskCompleter.manualComplete(taskId)
        ctx.ui.notify('任务已手动结束', 'info')
      } catch (error) {
        ctx.ui.notify(`手动结束失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
  })

  pi.registerCommand('task-refresh-mr', {
    description: '刷新所有 await_merge 任务的 MR 状态',
    handler: async (_args, ctx) => {
      try {
        const results = await mergeRefresher.refresh()
        const merged = results.filter((r) => r.taskCompleted).length
        ctx.ui.notify(`刷新完成：${results.length} 个任务,${merged} 个已自动完成`, 'info')
      } catch (error) {
        ctx.ui.notify(`刷新失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
  })

  pi.registerCommand('task-resume', {
    description: '恢复失败或暂停的任务',
    handler: async (args, ctx) => {
      const task = selectedTask(args)
      if (!task) return ctx.ui.notify('找不到任务', 'error')
      if (!store.acquireLease(task.id, owner, 120_000)) return ctx.ui.notify('任务已被占用', 'warning')
      store.setSetting('activeTaskId', task.id)
      ctx.ui.notify(`已恢复 ${task.title}`, 'info')
    }
  })

  pi.registerCommand('task-cancel', {
    description: '取消当前任务并释放租约',
    handler: async (args, ctx) => {
      const task = selectedTask(args)
      if (!task) return ctx.ui.notify('找不到任务', 'error')
      const approved = await ctx.ui.confirm('取消任务', '将停止执行并保留 worktree。确认取消？')
      if (!approved) return
      if (!['completed', 'cancelled'].includes(task.state)) store.updateTask(task.id, { state: 'cancelled' })
      store.releaseLease(task.id, owner)
      ctx.ui.notify('任务已取消，worktree 已保留', 'info')
    }
  })
}

function gitlabProfileFromStore(): { baseUrl: string; tokenEnv?: string } | undefined {
  const raw = store.getSetting('gitlabProfile')
  if (!raw) return undefined
  return JSON.parse(raw) as { baseUrl: string; tokenEnv?: string }
}

// === 子进程守卫 ==============================================================

/**
 * 三重身份校验:子进程守卫(防子进程重走 setup / 拦截器 / 命令注册)。
 * - L5 env 标记:`TASK_PIPELINE_SUBAGENT === "1"`,由 spawn 注入
 * - L6 ppid 检查:`process.ppid > 1` — ppid ≤ 1 表示被 init/reaper 收养
 *   (独立启动 / 孤儿进程) ,不应被认可为合法子进程
 * - L7 flag nonce 校验:从 `--subagent-nonce` 读出,必须与 env 中注入的
 *   `TASK_PIPELINE_SUBAGENT_NONCE` 严格相等(防 env 手动 set 绕过)
 *
 * 只要其中任何一项不通过,就返回 false,extension 会按正常主会话逻辑走。
 */
export function isSubagentProcess(pi: ExtensionAPI): boolean {
  if (process.env.TASK_PIPELINE_SUBAGENT !== '1') return false
  if (process.ppid <= 1) return false
  const expected = process.env.TASK_PIPELINE_SUBAGENT_NONCE
  if (!expected) return false
  const flagNonce = pi.getFlag('subagent-nonce')
  return typeof flagNonce === 'string' && flagNonce === expected
}
