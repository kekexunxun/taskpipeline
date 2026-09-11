import type { AgentEvent, TaskDraftEventPayload, TaskDraftFieldKey, TaskDraftFields } from '@task-pipeline/core'

/**
 * `draft` 澄清记录的读取侧判据（§2.4）。
 *
 * 单独成文件而不是写在组件里：这三条判据要能脱开 React 测（渲染层的 events 表来自
 * `tasks:get`，构造一份 events 数组比 mount 一个面板便宜得多）。
 * 事件形态与主进程共用 core 的 `TaskDraftEventPayload`，两边不会各写一份字段名单。
 */

/** 一句问答。`me` = 用户说的（气泡靠右）。 */
export type IntakeMessage = { id: string; me: boolean; text: string; createdAt: string }

/**
 * 待采纳的建议。`eventId` 是回传给主进程的唯一定位符——建议体不从 renderer 回去，
 * 否则 renderer 可以自己拼字段让主进程写库。
 */
export type PendingDraftSuggestion = {
  eventId: string
  fields: TaskDraftFields
  repositoryNames?: Record<string, string>
  /** 建议里实际有内容的字段，按 `DRAFT_FIELD_LABELS` 的顺序；勾选框就按它渲染。 */
  keys: TaskDraftFieldKey[]
}

/** 描述短到这个字数就算没讲清背景与期望（§2.4 第 5 条）。 */
const MIN_DESCRIPTION_LENGTH = 40

export const DRAFT_FIELD_LABELS: Record<TaskDraftFieldKey, string> = {
  title: '标题',
  description: '描述',
  keywords: '关键词',
  acceptanceCriteria: '验收标准',
  repositoryIds: '关联仓库'
}

/** 顺序固定：勾选框与建议摘要共用，不靠 `Object.keys` 的插入顺序（那取决于模型填了哪几项）。 */
const DRAFT_FIELD_ORDER = ['title', 'description', 'keywords', 'acceptanceCriteria', 'repositoryIds'] as const

export type DraftGapKey = 'description' | 'acceptanceCriteria' | 'repositories'

export const DRAFT_GAP_LABELS: Record<DraftGapKey, string> = {
  description: '描述还没讲清背景与期望',
  acceptanceCriteria: '还没有可判定的验收标准',
  repositories: '还没关联仓库'
}

/** 取一条事件的建议/问答载荷；不是这两种时返回 `undefined`（`payload` 在库里是任意 JSON）。 */
function draftPayload(event: AgentEvent): Partial<TaskDraftEventPayload> | undefined {
  return event.payload && typeof event.payload === 'object'
    ? (event.payload as Partial<TaskDraftEventPayload>)
    : undefined
}

export function intakeMessages(events: AgentEvent[]): IntakeMessage[] {
  return events
    .map((event) => {
      const payload = draftPayload(event)
      if (payload?.type !== 'draft-message') return undefined
      const text = event.detail?.trim()
      if (!text) return undefined
      return { id: event.id, me: payload.role === 'user', text, createdAt: event.createdAt }
    })
    .filter((item): item is IntakeMessage => item !== undefined)
}

/**
 * 最后一条还没被处置的建议。
 *
 * 从后往前扫，先碰到 `draft-suggestion-resolved` 就说明最新那条建议已经处置过了
 * （处置事件一定排在建议之后），不必再往前找。空字段的建议直接跳过：那是脏数据，
 * 亮一个只有按钮没有内容的卡更糟。
 */
export function latestDraftSuggestion(events: AgentEvent[]): PendingDraftSuggestion | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    const payload = draftPayload(event)
    if (payload?.type === 'draft-suggestion-resolved') return undefined
    if (payload?.type !== 'draft-suggestion') continue
    const fields = payload.fields ?? {}
    const keys = DRAFT_FIELD_ORDER.filter((key) => hasDraftField(key, fields))
    if (!keys.length) continue
    return {
      eventId: event.id,
      fields,
      ...(payload.repositoryNames ? { repositoryNames: payload.repositoryNames } : {}),
      keys
    }
  }
  return undefined
}

function hasDraftField(key: TaskDraftFieldKey, fields: TaskDraftFields): boolean {
  const value = fields[key]
  return typeof value === 'string' ? value.trim() !== '' : Boolean(value?.length)
}

/** 建议字段的可读值：数组字段合成一行（仓库取名字而不是裸 id）。 */
export function formatDraftFieldValue(key: TaskDraftFieldKey, suggestion: PendingDraftSuggestion): string {
  const value = suggestion.fields[key]
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  if (key === 'repositoryIds') return list.map((id) => suggestion.repositoryNames?.[id] ?? id).join('、')
  return list.join(key === 'acceptanceCriteria' ? '\n' : '、')
}

/**
 * 缺项判据，三条取或（§2.4 第 5 条）。
 *
 * 命中才在输入框上方亮提示条：`draft` 是高频入口，每次都开口就是干扰。
 */
export function draftGaps(
  task: { description: string; acceptanceCriteria: string[] },
  repositoryCount: number
): DraftGapKey[] {
  const gaps: DraftGapKey[] = []
  if (task.description.trim().length < MIN_DESCRIPTION_LENGTH) gaps.push('description')
  if (!task.acceptanceCriteria.length) gaps.push('acceptanceCriteria')
  if (repositoryCount === 0) gaps.push('repositories')
  return gaps
}
