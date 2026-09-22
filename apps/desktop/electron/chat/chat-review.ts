/**
 * chat-review.ts — Chat 流程的 CodeReview（与 Task 共用判定）
 *
 * 每轮正常对话结束后，若本轮存在文件变更（Edit/Write 命中的文件仍在工作区有改动），
 * 复用 Task 同款委托评审核心 `reviewPreparedDiff`（同一阻断级别口径、同一 ocr rule + LLM
 * 判定 + 解析），发现阻断问题时按 `reviewAutoFix` 用「独立修订调用」（Qoder acceptEdits）
 * 自动修正，受 `reviewAutoFixMaxRounds` 约束。
 *
 * 与 Task 的差异：
 * - diff 基准：本轮 Edit/Write 涉及的文件 ∩ 工作区未提交变更（vs HEAD），而非 base 分支 worktree；
 * - 修订：走 `QoderOrchestrator.runChatFix`（cwd = 对话工作目录），不进入会话历史、不占用户回合。
 */

import path from 'node:path'
import {
  reviewPreparedDiff,
  filterBlockingComments,
  asReviewer,
  type OpenCodeReviewService,
  type OpenAICompatReviewer,
  type DelegateReviewerInput,
  type ReviewResult,
  type ReviewComment
} from '@task-pipeline/integrations'
import type { AgentService } from '../agents/agent-service.js'
import type { QoderOrchestrator } from '../pi-extension/qoder/qoder-orchestrator.js'
import { buildReviewPromptForQoder, renderReviewFixLines } from '../task/task-runner.js'
import type { DriverPart } from './chat-types.js'

/** 只依赖对话工作区 git 状态的能力子集（便于注入假实现做单测）。 */
export type ChatGitService = {
  workingTreeStatus(cwd: string): Promise<Array<{ path: string; status: string }>>
  diffFile(cwd: string, filePath: string, status: string): Promise<string>
}

export type ChatReviewDeps = {
  gitService: ChatGitService
  ocrService: OpenCodeReviewService
  openAIReviewer: OpenAICompatReviewer
  agentService: AgentService
  qoderOrchestrator: QoderOrchestrator
  /** 读系统设置：reviewBlockingLevel / reviewAutoFix / reviewAutoFixMaxRounds。 */
  getSetting: (key: string) => string | undefined
  /** 判定本对话运行时：返回 driverId（'qoder' | 'openai' ...）。 */
  providerForChat: (chatId: string) => string
  /** 评审/修订使用的模型（可选，缺省时各 reviewer 走自身默认档）。 */
  modelForChat?: (chatId: string) => string | undefined
}

/**
 * ChatService 注入的静态依赖（不含逐回合的 provider/model——那两项随每次 stream 变化，
 * 由 ChatService 在调用处补全）。
 */
export type ChatReviewInfra = Omit<ChatReviewDeps, 'providerForChat' | 'modelForChat'>

/**
 * 评审结论卡片载荷（供前端渲染评审意见卡）：单张卡反映最终态，多轮修订时以替换式更新。
 * - outcome: passed=无阻断通过; blocked=有阻断需人工(自动修订关闭 / 非 Qoder 运行时);
 *   fixed=自动修订后复审通过; failed=达修订上限或修订/复审异常后仍有阻断。
 */
export type ChatReviewCard = {
  outcome: 'passed' | 'blocked' | 'fixed' | 'failed'
  /** 阻断级别口径（与 Task 同源 reviewBlockingLevel）。 */
  level: 'critical' | 'high' | 'medium'
  /** 阻断级意见（通过时为空）。 */
  comments: ReviewComment[]
  /** 本次评审覆盖的文件数。 */
  filesReviewed: number
  /** 实际执行的自动修订轮数。 */
  fixRounds: number
  /** 本轮是否开启了自动修订。 */
  autoFix: boolean
}

export type ChatReviewContext = {
  chatId: string
  workingDirectory: string
  /** 多目录工作区的全部根（含 workingDirectory 自身）；单目录对话即 [workingDirectory]。 */
  workspaceRoots: string[]
  /** 本轮用户消息正文，作为评审「需求」上下文。 */
  userText: string
  /** 本轮累积的 driver parts（用于采集 Edit/Write 命中的文件）。 */
  parts: DriverPart[]
  signal?: AbortSignal
  /** 状态事件（桥接前端对话事件 / trace）。 */
  onStatus: (title: string, detail?: string) => void
  /** 每轮评审结果回调（含阻断意见），供前端渲染评审意见卡。 */
  onReview?: (card: ChatReviewCard) => void
}

export type ChatReviewOutcome = {
  reviewed: boolean
  skippedReason?: string
  result?: ReviewResult
  blocking: ReviewComment[]
  fixRounds: number
}

/** 文件变更类工具（与 Qoder 记录侧口径一致：edit / write / multiedit / notebookedit 等）。 */
const FILE_MUTATION_TOOL =
  /^(edit|write|create|str_replace|replace|insert|delete|multiedit|patch|apply_patch|notebookedit)$/i

/** 从工具 input 提取目标文件路径（多种字段写法，与 log.ts filePathFromToolInput 对齐）。 */
function filePathFromToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  for (const key of ['file_path', 'filePath', 'path', 'file', 'filename', 'file_name', 'target']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/** 从本轮 parts 采集 Edit/Write 命中文件的绝对路径集合（相对路径按对话工作目录解析）。 */
export function collectTouchedFiles(parts: DriverPart[], workingDirectory: string): Set<string> {
  const touched = new Set<string>()
  for (const part of parts) {
    const isTool = part.type === 'qoder.tool-use' || part.type === 'openai.tool-call'
    if (!isTool) continue
    const { name, input } = part as { name?: unknown; input?: unknown }
    if (typeof name !== 'string' || !FILE_MUTATION_TOOL.test(name)) continue
    const p = filePathFromToolInput(input)
    if (!p) continue
    touched.add(path.resolve(workingDirectory, p))
  }
  return touched
}

/** 单根目录：本轮命中文件 ∩ 工作区未提交变更，返回仓库相对路径 + status。 */
async function matchRootChanges(
  root: string,
  touched: Set<string>,
  git: ChatGitService
): Promise<Array<{ path: string; status: string }>> {
  let status: Array<{ path: string; status: string }>
  try {
    status = await git.workingTreeStatus(root)
  } catch {
    return [] // 非 git 仓库 / 权限问题：跳过该根
  }
  return status.filter((file) => touched.has(path.resolve(root, file.path)))
}

/** 解析阻断级别（与 Task 同源：reviewBlockingLevel，默认 high）。 */
function reviewBlockingLevel(getSetting: (key: string) => string | undefined): 'critical' | 'high' | 'medium' {
  const raw = getSetting('reviewBlockingLevel')
  return raw === 'critical' || raw === 'medium' ? raw : 'high'
}

/** 修订最大轮数（默认 2，与 Task reviewAutoFixMaxRounds 同设置）。 */
function reviewAutoFixMaxRounds(getSetting: (key: string) => string | undefined): number {
  const raw = Number(getSetting('reviewAutoFixMaxRounds'))
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2
}

/**
 * 对给定根目录集合跑一次委托评审：逐根取 diff → reviewPreparedDiff → 合并意见。
 * 返回聚合 ReviewResult（comments 拼接、summary 累加）。
 */
async function reviewGroups(
  deps: ChatReviewDeps,
  ctx: ChatReviewContext,
  groups: Array<{ root: string; files: Array<{ path: string; status: string }> }>
): Promise<ReviewResult> {
  const model = deps.modelForChat?.(ctx.chatId)
  const reviewer = asReviewer(
    async (input: DelegateReviewerInput, scopeId: string, m?: string, signal?: AbortSignal) => {
      if (deps.providerForChat(ctx.chatId) === 'qoder') {
        const { roleBody } = deps.agentService.resolveOperationAgent('review')
        const prompt = buildReviewPromptForQoder(input, roleBody)
        return deps.qoderOrchestrator.callReviewer(prompt, scopeId, m, signal)
      }
      return deps.openAIReviewer.call(input, scopeId, m, signal)
    }
  )

  const allComments: ReviewComment[] = []
  let totalFiles = 0
  for (const group of groups) {
    ctx.signal?.throwIfAborted()
    const repoName = path.basename(group.root.replace(/[\\/]+$/, '')) || group.root
    const files = group.files.map((f) => f.path)
    let diff = ''
    for (const file of group.files) {
      try {
        diff += await deps.gitService.diffFile(group.root, file.path, file.status)
        diff += '\n'
      } catch {
        /* 单文件取 diff 失败：跳过该文件，不影响其余 */
      }
    }
    if (!diff.trim()) {
      ctx.onStatus(`${repoName}: diff 为空,跳过 LLM`)
      continue
    }
    const result = await reviewPreparedDiff({
      ocr: deps.ocrService,
      reviewer,
      worktree: group.root,
      repoName,
      taskTitle: ctx.userText.slice(0, 500),
      reviewScopeId: ctx.chatId,
      files,
      diff,
      ...(model ? { model } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onStatus: ctx.onStatus
    })
    allComments.push(...result.comments)
    totalFiles += files.length
  }
  return { status: 'completed', comments: allComments, summary: { files: totalFiles, comments: allComments.length } }
}

/** 把阻断意见渲染成 Chat 修订 prompt（复用 Task 意见格式，指令改为在对话工作目录直接改文件）。 */
export function buildChatReviewFixPrompt(blocking: ReviewComment[]): string {
  const lines = renderReviewFixLines(
    blocking.map((comment) => ({
      severity: comment.severity,
      path: comment.path,
      line: comment.line,
      message: comment.message
    }))
  )
  return [
    'Code review 未通过，以下是对本轮改动文件的阻断级问题。请逐一修复，不要遗漏；',
    '只改这些文件、不要引入与这些问题无关的改动，不要执行任何命令。',
    '',
    ...lines
  ].join('\n')
}

/**
 * Chat 每轮结束后的 CodeReview 主流程。调用方（ChatService）负责：
 * - 判定时机（status==='done' 且非 plan 模式且有工作目录）；
 * - 用 trace 阶段容器包裹本函数（phase='review'）；
 * - 把 onStatus / onReview 桥接到前端事件。
 * 本函数内部全程 try/catch 交由调用方兜底（评审异常绝不阻断对话）。
 */
export async function runChatCodeReview(deps: ChatReviewDeps, ctx: ChatReviewContext): Promise<ChatReviewOutcome> {
  const touched = collectTouchedFiles(ctx.parts, ctx.workingDirectory)
  if (touched.size === 0) return { reviewed: false, skippedReason: '本轮无文件变更', blocking: [], fixRounds: 0 }

  const roots = ctx.workspaceRoots.length > 0 ? ctx.workspaceRoots : [ctx.workingDirectory]
  const matchedGroups: Array<{ root: string; files: Array<{ path: string; status: string }> }> = []
  for (const root of roots) {
    const files = await matchRootChanges(root, touched, deps.gitService)
    if (files.length > 0) matchedGroups.push({ root, files })
  }
  if (matchedGroups.length === 0) {
    return { reviewed: false, skippedReason: '本轮命中文件在工作区已无变更', blocking: [], fixRounds: 0 }
  }

  ctx.onStatus('开始代码审查（CodeReview）', `覆盖 ${matchedGroups.length} 个目录, ${touched.size} 个命中文件`)
  let result: ReviewResult
  try {
    result = await reviewGroups(deps, ctx, matchedGroups)
  } catch (error) {
    if (ctx.signal?.aborted) throw error
    ctx.onStatus('代码审查执行失败', error instanceof Error ? error.message : String(error))
    return { reviewed: false, skippedReason: '评审执行失败', blocking: [], fixRounds: 0 }
  }

  const level = reviewBlockingLevel(deps.getSetting)
  const autoFix = deps.getSetting('reviewAutoFix') === 'true'
  // 评审卡以「终态单卡」发射：passed / blocked（需人工）在初次判定后即定，修订循环只在
  // fixed（复审通过）或 failed（达上限 / 修订或复审异常）时发射，前端按 type 替换式更新。
  const emitCard = (outcome: ChatReviewCard['outcome'], comments: ReviewComment[], fixRounds: number): void => {
    ctx.onReview?.({
      outcome,
      level,
      comments,
      filesReviewed: Number(result.summary?.files ?? 0),
      fixRounds,
      autoFix
    })
  }
  let blocking = filterBlockingComments(result.comments, level)
  if (blocking.length === 0) {
    ctx.onStatus('代码审查通过', `无阻断级问题（阻断级别：${level}）`)
    emitCard('passed', [], 0)
    return { reviewed: true, result, blocking: [], fixRounds: 0 }
  }
  ctx.onStatus('代码审查发现阻断问题', `${blocking.length} 条 ${level} 及以上意见`)

  if (!autoFix) {
    emitCard('blocked', blocking, 0)
    return { reviewed: true, result, blocking, fixRounds: 0 }
  }
  if (deps.providerForChat(ctx.chatId) !== 'qoder') {
    ctx.onStatus('自动修订仅支持 Qoder 运行时', '已展示阻断意见，需手动处理')
    emitCard('blocked', blocking, 0)
    return { reviewed: true, result, blocking, fixRounds: 0 }
  }

  const maxRounds = reviewAutoFixMaxRounds(deps.getSetting)
  const model = deps.modelForChat?.(ctx.chatId)
  let fixRounds = 0
  for (let round = 1; round <= maxRounds; round++) {
    ctx.signal?.throwIfAborted()
    fixRounds = round
    ctx.onStatus(`按 Review 意见自动修订（第 ${round}/${maxRounds} 轮）`)
    try {
      await deps.qoderOrchestrator.runChatFix(buildChatReviewFixPrompt(blocking), {
        cwd: ctx.workingDirectory,
        ...(model ? { model } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {})
      })
    } catch (error) {
      if (ctx.signal?.aborted) throw error
      ctx.onStatus('自动修订执行失败', error instanceof Error ? error.message : String(error))
      break
    }
    // 修订后基于同一批文件重取 diff 复审（改动仍收敛在本轮命中文件内）
    try {
      result = await reviewGroups(deps, ctx, matchedGroups)
    } catch (error) {
      if (ctx.signal?.aborted) throw error
      ctx.onStatus('修订后复审失败', error instanceof Error ? error.message : String(error))
      break
    }
    blocking = filterBlockingComments(result.comments, level)
    if (blocking.length === 0) {
      ctx.onStatus('自动修订后复审通过')
      emitCard('fixed', [], round)
      return { reviewed: true, result, blocking: [], fixRounds: round }
    }
  }
  if (blocking.length > 0) {
    ctx.onStatus('已到达 Review 自动修订上限', `剩余 ${blocking.length} 条阻断意见需人工处理`)
    emitCard('failed', blocking, fixRounds)
  }
  return { reviewed: true, result, blocking, fixRounds }
}
