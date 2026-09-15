import type { TaskState } from '@task-pipeline/core'

export type ImplementationOutcome = 'needs_input' | 'already_satisfied' | 'completed' | 'unknown'
export type ImplementationNextStep = 'await_input' | 'complete_without_changes' | 'validate' | 'await_confirmation'
export type PlanNextStep = 'complete_without_changes' | 'await_plan_approval'

export type ImplementationDecision = {
  outcome: ImplementationOutcome
  content: string
}

const outcomeMarker = /<!--\s*task-pipeline-outcome:(needs_input|already_satisfied|completed)\s*-->/i

export const implementationOutcomeInstruction = [
  '本轮结束前必须明确当前执行结果，并在最终回复最后一行输出且只输出以下标记之一：',
  '<!-- task-pipeline-outcome:needs_input -->：信息不足、存在阻塞、需要用户回答，或实现尚未完成；即使已经修改了部分文件也使用此项。',
  '<!-- task-pipeline-outcome:already_satisfied -->：已核实当前仓库满足任务要求且无需修改任何文件。',
  '<!-- task-pipeline-outcome:completed -->：要求的代码修改已经全部完成，可以进入校验。',
  '不要把一次对话结束当作实现完成。无法确定时必须使用 needs_input。'
].join('\n')

/**
 * 测试用例生成阶段的 Agent 指引。
 *
 * 放在这里而不是某个 driver 内部：Plan/Exec 之外的阶段同样需要“同一份约束”——
 * Pi 与 Qoder 两条运行时如果各自维护一份提示词，产出契约（末尾的 JSON，由
 * `parseTestCaseGeneration` 解析）就会与提示词漂移，一个运行时能解析另一个不能。
 */
export const testCaseGenerationInstruction = [
  '你是一个测试用例生成 Agent，专为当前 Coding 任务生成最小测试集。',
  '硬性约束：',
  '1. 不得修改任何业务逻辑文件、不得重构、不得调整非测试相关的配置。',
  '2. 仅为本次改动产出可被现有 testCommand 跑通的最小测试集（单元测试为主，必要时一个集成测试）。',
  '3. 若现有 testCommand 不存在或无法识别测试文件，请按仓库常见约定新增。',
  '4. 所有新增文件必须以 _test.* / .test.* / .spec.* 结尾，并放到合理的测试目录。',
  '5. 完成后请把测试相关的修改 commit 到当前 feature 分支（一个 commit 即可），commit message 形如 `test: <简短说明>`。',
  '',
  '请在最后输出一个 JSON 对象（不要输出额外说明）：',
  '{"files":["path/to/test1", "path/to/test2"], "commitSha":"<短 sha 或全 sha>", "summary":"<一句话概述>"}',
  '若没有任何可测试的逻辑面，输出 {"files":[], "summary":"<解释原因>"}。'
].join('\n')

export function parseImplementationDecision(texts: string[]): ImplementationDecision {
  // 先把流式增量片段按顺序拼成完整文本再解析(兼容消息粒度与 delta 碎片粒度):
  // outcome marker 或 JSON 可能横跨多条碎片,逐条解析会漏判,导致实现结果被误判。
  const full = texts.join('').trim()
  const marker = full.match(outcomeMarker)?.[1] as Exclude<ImplementationOutcome, 'unknown'> | undefined
  if (marker) return { outcome: marker, content: full.replace(outcomeMarker, '').trim() }

  const start = full.lastIndexOf('{')
  const end = full.lastIndexOf('}')
  let parsedValue: { outcome?: string; summary?: string; question?: string } | undefined
  if (start >= 0 && end > start) {
    try {
      parsedValue = JSON.parse(full.slice(start, end + 1))
    } catch {
      // 模型常见瑕疵:尾逗号。修复后重试。
      try {
        parsedValue = JSON.parse(full.replace(/,\s*([}\]])/g, '$1').slice(start, end + 1))
      } catch {
        /* fall through to natural-language heuristics */
      }
    }
  }
  if (parsedValue && ['needs_input', 'already_satisfied', 'completed'].includes(parsedValue.outcome ?? '')) {
    return {
      outcome: parsedValue.outcome as Exclude<ImplementationOutcome, 'unknown'>,
      content: String(parsedValue.summary || parsedValue.question || full).trim()
    }
  }

  if (
    /(?:需要|请)(?:你|您)?(?:补充|提供|确认|说明|澄清)|信息(?:不足|缺失|不完整)|无法(?:开始|继续|确定)|等待(?:你|您)?(?:回复|确认)|before I can (?:start|continue|proceed)|(?:need|require)(?:s|ed)? (?:more |additional )?(?:information|details|requirements|clarification)|could you (?:share|provide|clarify|confirm)|acceptance criteria (?:appears? )?(?:empty|missing)/i.test(
      full
    )
  ) {
    return { outcome: 'needs_input', content: full }
  }
  if (
    /(?:该任务|当前代码|代码|仓库)?(?:已经|已)(?:满足|实现)(?:任务|需求|要求)|无需(?:任何)?(?:代码)?修改|无需改动|already satisfied|no (?:code )?changes? (?:are )?required/i.test(
      full
    )
  ) {
    return { outcome: 'already_satisfied', content: full }
  }
  return { outcome: 'unknown', content: full }
}

export function nextStepForImplementation(
  outcome: ImplementationOutcome,
  changedFileCount: number
): ImplementationNextStep {
  if (outcome === 'needs_input') return 'await_input'
  if (outcome === 'already_satisfied' && changedFileCount === 0) return 'complete_without_changes'
  if (outcome === 'completed' && changedFileCount > 0) return 'validate'
  return 'await_confirmation'
}

export function nextStepForPlan(
  outcome: 'changes_required' | 'already_satisfied',
  changedFileCount: number
): PlanNextStep {
  return outcome === 'already_satisfied' && changedFileCount === 0 ? 'complete_without_changes' : 'await_plan_approval'
}

export function isExplicitNoChangeCompletionRequest(message: string): boolean {
  const normalized = message.trim().replace(/\s+/g, ' ')
  const noWorkRequested =
    /(?:什么|任何事情|任何东西|任何)?都?(?:不用|不需要|无需|不要)(?:再)?(?:做|进行)?(?:任何)?(?:改|修改|改动|处理|操作|实现)?|(?:nothing|no changes?|no modifications?|no work)\s+(?:(?:is|are)\s+)?(?:needed|required|necessary)|don['’]?t (?:change|modify|do) anything/i.test(
      normalized
    )
  const completionRequested =
    /(?:直接|就)(?:完成|结束)|(?:可以|请)?(?:完成|结束|关闭)(?:这个|该)?任务|(?:complete|finish|close|end)(?:\s+this|\s+the)?\s+task/i.test(
      normalized
    )
  return noWorkRequested && completionRequested
}

/**
 * 澄清对话的入口判据（§2.4）：只有 `draft` 能开口。
 *
 * 为什么不跟实现期对话共用判据：那条入口会把状态推到 `implementing`，而澄清的全部意义
 * 就在「还没开工」——在别的状态上开口等于替用户启动了链路。
 */
export function assertDraftIntake(state: TaskState): void {
  if (state !== 'draft') throw new Error('只有待处理的任务可以让 Agent 补全定义')
}
