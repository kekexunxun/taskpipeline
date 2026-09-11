/**
 * `draft` 阶段的澄清 backend（§2.4）。
 *
 * 为什么要单开一个会话：一个任务只有一个执行会话（键 `${taskId}`），那份上下文归实现阶段独占；
 * 澄清问答塞进去，等于让实现阶段带着半截对话历史开工。所以这里按 `${taskId}:intake` 建常驻会话，
 * `begin()` 进 `planning` 时关掉它，实现阶段拿到干净上下文。
 *
 * 工具面收到最小：只读查询工具（`read_file` / `grep` / `glob` / `list_dir`，只在已关联仓库时注入）
 * 加一个 `updateTaskDraft`（只能提建议，不能直写），其余工具在 `canUseTool` 里一律 deny
 * ——不弹框、不等 `controlRequestTimeoutMs`，因为 `draft` 阶段没有任何理由改文件。
 * 没关联仓库时不传 `cwd`，只剩一个 `updateTaskDraft`，会话退化成纯模型问答。
 *
 * 回合输出不落流式通道：`draft` 不需要打字机效果，把整轮文本落成一条 `message` 事件，
 * 问答记录从 `events` 表读（Timeline 的那份 `events` 是从 trace span 合成的，`draft` 阶段没 trace）。
 */
import { z } from 'zod'
import type { PermissionResult } from '@qoder-ai/qoder-agent-sdk'
import type {
  AgentEvent,
  RepositoryProfile,
  Task,
  TaskDraftEventPayload,
  TaskDraftFieldKey,
  TaskDraftFields,
  TaskRepository
} from '@task-pipeline/core'
import { createProjectQueryToolSource } from '../../chat/drivers/project-query-tools.js'
import type { ToolDeclaration } from '../../chat/drivers/tool-source.js'
import { buildToolSourceMcp } from '../../pi-extension/qoder/tool-source-mcp.js'
import { QoderSession, QoderSessionRegistry } from '../../pi-extension/qoder/qoder-session.js'

/** 澄清会话的注册键：与执行会话 `${taskId}` 同 registry 但不同键，互不覆盖。 */
const intakeKey = (taskId: string): string => `${taskId}:intake`

/** MCP 记录键；server 名与工具名前缀由 `buildToolSourceMcp` 按它推导。 */
const INTAKE_MCP_KEY = 'task_intake'

const INTAKE_SYSTEM_PROMPT = [
  '你在帮用户把一个尚未开工的任务（draft）定义清楚。不写代码，不做实现规划。',
  '关注四件事：标题是否准确、描述是否讲清了背景与期望、验收标准是否可判定、该在哪些仓库里做。',
  '规则：',
  '- 一次只挑最关键的缺口问（最多两个问题），不要清单式盘问；用户表示「就这些」时接受现状。',
  '- 可以用只读工具确认代码现状（例如某能力是否已经存在），但结论必须落回任务定义本身。',
  '- 想改任务定义时调用 updateTaskDraft 提交建议；它不会立即生效，用户逐项采纳后才落库，所以不要声称已经改好。',
  '- 回答简短，使用中文，不要输出 Markdown 标题与代码块。'
].join('\n')

export type TaskIntakeTurnInput = {
  /** 任务快照：只用于拼首轮上下文与仓库清单。 */
  task: Task
  /** 已关联的仓库；`draft` 阶段没有 worktree，读的是源仓库路径。 */
  repositories: Pick<TaskRepository, 'name' | 'localPath'>[]
  /** 系统里可用的仓库候选：`updateTaskDraft` 的 `repositoryIds` 只能取这里的 id。 */
  availableRepositories: Pick<RepositoryProfile, 'id' | 'name'>[]
  token: string
  model?: string
  addEvent: (event: Omit<AgentEvent, 'id' | 'createdAt'>) => void
}

const sessions = new QoderSessionRegistry()

function openSession(input: TaskIntakeTurnInput): { session: QoderSession; firstTurn: boolean } {
  const key = intakeKey(input.task.id)
  const existing = sessions.get(key)
  if (existing) return { session: existing, firstTurn: false }
  const primary = input.repositories[0]
  const mcp = buildToolSourceMcp(INTAKE_MCP_KEY, intakeTools(input))
  const session = new QoderSession(key, {
    token: input.token,
    ...(primary ? { cwd: primary.localPath } : {}),
    ...(input.repositories.length > 1
      ? { additionalDirectories: input.repositories.slice(1).map((repo) => repo.localPath) }
      : {}),
    ...(input.model ? { model: input.model } : {}),
    systemPrompt: INTAKE_SYSTEM_PROMPT,
    permissionMode: 'default',
    // 只放行自己注入的那几个工具；其余的交给 canUseTool 直接拒。
    allowedTools: mcp.toolNames,
    mcpServers: { [INTAKE_MCP_KEY]: mcp.server },
    allowedMcpServerNames: [INTAKE_MCP_KEY],
    // 澄清回合不需要跑很多轮工具；跑飞了比慢更糟。
    maxTurns: 8,
    // 白名单外的工具（内建 Bash / Edit / Write 等）一律拒绝。不弹框也不等超时：
    // draft 阶段没有任何一种正当理由让模型动文件。
    canUseTool: async (toolName: string): Promise<PermissionResult> => ({
      behavior: 'deny',
      message: `澄清阶段不允许使用 ${toolName}`
    })
  })
  return { session: sessions.register(key, session), firstTurn: true }
}

/** 首轮把任务现状交给模型，省掉每轮重复贴一遍表单。 */
function draftSnapshot(input: TaskIntakeTurnInput): string {
  const { task, repositories } = input
  return [
    '【任务当前定义】',
    `标题：${task.title.trim() || '（空）'}`,
    `描述：${task.description.trim() || '（空）'}`,
    `关键词：${task.keywords.length ? task.keywords.join('、') : '（空）'}`,
    `验收标准：${task.acceptanceCriteria.length ? `\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}` : '（空）'}`,
    `已关联仓库：${repositories.length ? repositories.map((repo) => repo.name).join('、') : '（无）'}`,
    // 候选仓库连同 id 一起给出：`updateTaskDraft` 要的是 id，而模型猜不出内部主键。
    `可选仓库：${input.availableRepositories.length ? input.availableRepositories.map((repo) => `${repo.name}（id: ${repo.id}）`).join('、') : '（系统里还没有配置仓库）'}`,
    '【用户消息】'
  ].join('\n')
}

/** 建议字段的人类可读摘要：建议区与 Timeline 都靠它说清改了哪几项。 */
export function describeDraftFields(fields: TaskDraftFields): string {
  const parts: string[] = []
  if (fields.title) parts.push('标题')
  if (fields.description) parts.push('描述')
  if (fields.keywords?.length) parts.push(`关键词 ${fields.keywords.length} 个`)
  if (fields.acceptanceCriteria?.length) parts.push(`验收标准 ${fields.acceptanceCriteria.length} 条`)
  if (fields.repositoryIds?.length) parts.push(`仓库 ${fields.repositoryIds.length} 个`)
  return parts.join('、')
}

/**
 * 从工具入参里只取白名单字段。
 *
 * 不依赖 SDK 的 schema 校验作为唯一防线：那样一旦 schema 放宽，建议体会带着新字段
 * 直接落库里。额外两道：字符串去空、`repositoryIds` 过滤到真实存在的 id
 * （模型会编 id，而编出来的 id 会到采纳那一刻才爆）。
 *
 * 导出是给 `resolveDraftSuggestion` 用的：采纳时从库里读出的 payload 再过一次同一套清洗，
 * 不在两处各写一份字段名单。
 */
export function pickDraftFields(
  input: Record<string, unknown>,
  availableRepositories: Pick<RepositoryProfile, 'id'>[]
): TaskDraftFields {
  const fields: TaskDraftFields = {}
  const single = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  if (single(input.title)) fields.title = single(input.title)
  if (single(input.description)) fields.description = single(input.description)
  const known = new Set(availableRepositories.map((repo) => repo.id))
  for (const key of ['keywords', 'acceptanceCriteria', 'repositoryIds'] as const) {
    const raw = input[key]
    if (!Array.isArray(raw)) continue
    const list = raw
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim())
    const kept = key === 'repositoryIds' ? list.filter((id) => known.has(id)) : list
    if (kept.length) fields[key] = kept
  }
  return fields
}

/**
 * 采纳前的最后一道判据：勾选交集 + 建议里的仓库是否还在系统里。
 *
 * `keys` 缺省 = 整条采纳；给了名单（哪怕是空数组）= 只写勾上的那几项。
 * 这条区分不能缩成 `keys?.length`：界面上一项没勾和没处可勾是两回事，
 * 前者必须报错，当成「全写」就是一个静默改掉了用户没同意要改的任务。
 *
 * 单独成函数是为了能脱开主进程测：`resolveDraftSuggestion` 其余部分都是 store I/O，
 * 而这两个判断才是「用户点一下采纳到底会写什么」的答案。
 */
export function adoptDraftFields(
  stored: Record<string, unknown>,
  keys: TaskDraftFieldKey[] | undefined,
  availableRepositories: Pick<RepositoryProfile, 'id'>[]
): { fields: TaskDraftFields; error?: string } {
  const fields = pickDraftFields(stored, availableRepositories)
  // 未勾选的键不写：用户可以只认其中两项，剩下那项还是他自己填的。
  if (keys) for (const key of Object.keys(fields) as TaskDraftFieldKey[]) if (!keys.includes(key)) delete fields[key]
  if (Object.keys(fields).length === 0) return { fields, error: '没有可写入的内容：至少勾选一项' }
  // 仓库查的是原始 payload 而不是洗过的建议体：`pickDraftFields` 会把不认识的 id 悄悄剔掉，
  // 那样「建议里的仓库已被删」就变成一个默默少写仓库的任务。
  const known = new Set(availableRepositories.map((repo) => repo.id))
  const wanted =
    fields.repositoryIds && Array.isArray(stored.repositoryIds)
      ? stored.repositoryIds.filter((id): id is string => typeof id === 'string')
      : []
  if (wanted.some((id) => !known.has(id))) return { fields, error: '建议里的仓库已不在系统里，请让 Agent 重新给出仓库' }
  return { fields }
}

/**
 * 澄清会话的工具面：已关联仓库时的四个只读查询工具 + 一个 `updateTaskDraft`，没仓库就只剩后者。
 * 导出是为了把「模型能调什么」钉在测试里：真正的拦截在 `canUseTool`，但工具面才是第一道防线。
 */
export function intakeTools(input: TaskIntakeTurnInput): ToolDeclaration[] {
  const primary = input.repositories[0]
  const tools: ToolDeclaration[] = primary ? createProjectQueryToolSource(primary.localPath).tools() : []
  tools.push({
    name: 'updateTaskDraft',
    description:
      '把补全后的任务定义作为「建议」交给用户。它不会立即改动任务：界面上会出现逐项可采纳/可丢弃的建议，用户点采纳才落库。只填你要改的字段，未填的字段保持原样。',
    schema: {
      title: z.string().min(4).max(200).optional().describe('一句话任务标题，说明要达成什么'),
      description: z.string().max(4000).optional().describe('背景与期望结果；不要写实现步骤'),
      keywords: z.array(z.string().min(1)).max(10).optional().describe('检索关键词'),
      acceptanceCriteria: z
        .array(z.string().min(1))
        .max(12)
        .optional()
        .describe('可判定的验收标准，每条是一句可验证的事实'),
      repositoryIds: z
        .array(z.string().min(1))
        .max(8)
        .optional()
        .describe('仓库 id，只能取【任务当前定义】里列出的候选值')
    },
    // 不标 readOnlyHint：它确实有副作用（落一条建议事件），但副作用完全可逆且不碰仓库。
    annotations: { destructiveHint: false },
    execute: async (raw) => {
      const fields = pickDraftFields(raw, input.availableRepositories)
      if (Object.keys(fields).length === 0) return { ok: false, error: '没有可采纳的字段：请至少给出一项非空内容' }
      input.addEvent({
        taskId: input.task.id,
        kind: 'status',
        title: 'Agent 建议补全任务定义',
        detail: describeDraftFields(fields),
        payload: {
          type: 'draft-suggestion',
          fields,
          ...(fields.repositoryIds
            ? {
                repositoryNames: Object.fromEntries(
                  fields.repositoryIds.map((id) => [
                    id,
                    input.availableRepositories.find((repo) => repo.id === id)?.name ?? id
                  ])
                )
              }
            : {})
        } satisfies TaskDraftEventPayload
      })
      // 只回报「已提交」，不让模型以为改动已生效：它下一句怎么说全靠这个返回值。
      return {
        ok: true,
        pending: true,
        fields: Object.keys(fields),
        note: '建议已提交，等待用户在界面上逐项采纳；采纳前任务字段未变。'
      }
    }
  })
  return tools
}

/**
 * 跑一轮澄清。调用方负责 guard（必须是 `draft`）与事件顺序（先落用户那句）。
 *
 * 会话跑完一轮后保留，下一轮接着用——多轮上下文就存在这里，不落库。
 * 只有一轮没跑成（报错 / abort）时才丢弃会话：消费循环可能已经结束，
 * 留着它只会让后续每轮都卡在同一个坏状态，重建一个比修它便宜（与对话侧同一约定）。
 */
export async function runTaskIntakeTurn(
  input: TaskIntakeTurnInput,
  message: string,
  signal?: AbortSignal
): Promise<void> {
  const { session, firstTurn } = openSession(input)
  let reply = ''
  let failure: string | undefined
  try {
    for await (const chunk of session.turn({
      text: firstTurn ? `${draftSnapshot(input)}\n${message}` : message,
      signal
    })) {
      if (chunk.type === 'part' && chunk.part.type === 'text') reply += chunk.part.text
      else if (chunk.type === 'error') failure = chunk.message
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  if (failure) {
    await sessions.close(intakeKey(input.task.id))
    throw new Error(failure)
  }
  const text = reply.trim()
  if (text)
    input.addEvent({
      taskId: input.task.id,
      kind: 'message',
      title: '澄清助手',
      detail: text,
      payload: { type: 'draft-message', role: 'assistant' } satisfies TaskDraftEventPayload
    })
}

/**
 * 关闭任务的澄清会话：`begin()` 进链路、取消、删除都要调。
 *
 * 不等 `close()` 完成：调用点是状态流转的同步路径，为一个已 abort 的 query 阻塞流转没有意义。
 */
export function closeTaskIntake(taskId: string): void {
  void sessions.close(intakeKey(taskId)).catch(() => undefined)
}
