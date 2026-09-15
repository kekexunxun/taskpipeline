/**
 * 阶段产物契约（P2）—— `<dataDir>/tasks/<taskId>/`。
 *
 * 会话绑阶段实例解决「上下文继承」，产物文件解决「跨人工闸门的真值交接」：
 *  - `plan.v<n>.md`     计划正文（人可读、可 diff，Exec 阶段直接 Read 局部取用）
 *  - `plan.v<n>.json`   计划元信息（sha256 / editedBy / sessionAnchor / cliVersion）
 *  - `exec.summary.md`  实际改动摘要（Test 阶段的输入）
 *  - `test.cases.json`  用例清单
 *  - `stages/<实例>.json` 阶段实例的输入快照（fork 点、注入片段、降级原因）
 *
 * 三条硬规则（docs/task-stage-session-boundary-plan.md §4）：
 *  1. **DB 仍是真值**，md 是导出视图 —— md 永远由 DB 里的 `planContent` 导出，不从 md 反向合并；
 *  2. **文件 ≠ DB 即报错**，不允许静默取其一（同一 revision 的 sha 对不上就是异常）；
 *  3. **绝不写 worktree** —— 工具产物落进任务 worktree 会污染提交并阻断合并。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Task } from '@task-pipeline/core'

/** plan.md 强制三段（§4.3）：缺任一段 → 首版不拆 Exec，继续共享上一阶段会话。 */
export const PLAN_REQUIRED_SECTIONS = ['已定位文件与依据', '已否决方案与理由', '验证方式'] as const

/** 三段的完整标题文本（拼 prompt 用，避免各处手写出现措辞漂移）。 */
export const PLAN_SECTION_REQUIREMENT = `计划正文（plan 字段）必须包含以下三个 Markdown 小节，标题原文照抄：
## 已定位文件与依据
（每个文件一行：路径 + 为什么相关，供执行阶段免重复检索）
## 已否决方案与理由
（防止执行阶段重新走回头路；没有就写「无」）
## 验证方式
（测试与人工验证的输入，必须可执行、可对账）`

export function tasksArtifactRoot(dataDir: string): string {
  return join(dataDir, 'tasks')
}

export function taskArtifactDir(dataDir: string, taskId: string): string {
  return join(tasksArtifactRoot(dataDir), artifactFileName(taskId))
}

/**
 * 文件名安全化：`taskId` 不含特殊字符，但 `stageInstanceId` 形如 `taskId:phase:seq`，
 * `:` 在 Windows 上是非法路径字符（macOS/Linux 上也会让 grep/编辑体验变差）。
 */
export function artifactFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function planMarkdownPath(dataDir: string, taskId: string, revision: number): string {
  return join(taskArtifactDir(dataDir, taskId), `plan.v${revision}.md`)
}

export function planMetaPath(dataDir: string, taskId: string, revision: number): string {
  return join(taskArtifactDir(dataDir, taskId), `plan.v${revision}.json`)
}

export function execSummaryPath(dataDir: string, taskId: string): string {
  return join(taskArtifactDir(dataDir, taskId), 'exec.summary.md')
}

export function testCasesPath(dataDir: string, taskId: string): string {
  return join(taskArtifactDir(dataDir, taskId), 'test.cases.json')
}

export function stageSnapshotPath(dataDir: string, taskId: string, stageInstanceId: string): string {
  return join(taskArtifactDir(dataDir, taskId), 'stages', `${artifactFileName(stageInstanceId)}.json`)
}

/** 与 `writeFile(md, normalizedPlan)` 逐字节一致的归一化：CRLF → LF、去首尾空白、补尾换行。 */
export function normalizePlanText(content: string): string {
  return `${content.replace(/\r\n/g, '\n').trim()}\n`
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 计划正文是否含全部必需小节（标题按「## …」形式宽松匹配）。 */
export function checkPlanSections(content: string | undefined): { complete: boolean; missing: string[] } {
  const body = content?.trim() ?? ''
  if (!body) return { complete: false, missing: [...PLAN_REQUIRED_SECTIONS] }
  const missing = PLAN_REQUIRED_SECTIONS.filter((section) => !new RegExp(`^#{1,6}\\s*${section}`, 'm').test(body))
  return { complete: missing.length === 0, missing }
}

export type PlanEditedBy = 'agent' | 'user'

export type PlanArtifactMeta = {
  revision: number
  sha256: string
  editedBy: PlanEditedBy
  planPath: string
  exportedAt: string
  /** 计划结论（changes_required / already_satisfied）；导出方不知道时可缺省。 */
  outcome?: string
  /** 产出该计划的会话里被保留的最后一个 turn 尾部 entry uuid（下一阶段的 fork 点候选）。 */
  sessionAnchor?: string
  /** 导出时的 qodercli 版本（跨机器对不上时的定位依据）。 */
  cliVersion?: string
}

export type PlanArtifactMismatch = {
  revision: number
  /** 期望值：`sha256(normalize(DB.planContent))`。 */
  dbSha256: string
  /** `plan.v<n>.json` 里记录的 sha（文件缺失时 undefined）。 */
  metaSha256?: string
  /** `plan.v<n>.md` 实际内容的 sha（文件缺失时 undefined）。 */
  fileSha256?: string
}

/** 同一 revision 的产物与 DB 不一致：必须报错，不能静默挑一个当输入。 */
export class PlanArtifactMismatchError extends Error {
  readonly mismatch: PlanArtifactMismatch
  constructor(mismatch: PlanArtifactMismatch) {
    super(
      `计划产物与数据库不一致（第 ${mismatch.revision} 版）：` +
        `DB sha=${mismatch.dbSha256.slice(0, 12)}，` +
        `元信息 sha=${mismatch.metaSha256?.slice(0, 12) ?? '无'}，` +
        `文件 sha=${mismatch.fileSha256?.slice(0, 12) ?? '无'}`
    )
    this.name = 'PlanArtifactMismatchError'
    this.mismatch = mismatch
  }
}

/** md 是 DB 的导出视图，写两个文件即可；返回元信息供 span / 事件引用。 */
export async function exportPlanArtifact(
  dataDir: string,
  task: Task,
  options: { editedBy: PlanEditedBy; outcome?: string; sessionAnchor?: string; cliVersion?: string } = {
    editedBy: 'agent'
  }
): Promise<PlanArtifactMeta | undefined> {
  const body = task.planContent?.trim()
  if (!body) return undefined
  const revision = task.planRevision ?? 0
  const dir = taskArtifactDir(dataDir, task.id)
  await mkdir(dir, { recursive: true })
  const markdown = normalizePlanText(body)
  const mdPath = planMarkdownPath(dataDir, task.id, revision)
  const meta: PlanArtifactMeta = {
    revision,
    sha256: sha256Hex(markdown),
    editedBy: options.editedBy,
    planPath: mdPath,
    exportedAt: new Date().toISOString(),
    ...(options.outcome ? { outcome: options.outcome } : {}),
    ...(options.sessionAnchor ? { sessionAnchor: options.sessionAnchor } : {}),
    ...(options.cliVersion ? { cliVersion: options.cliVersion } : {})
  }
  await writeFile(mdPath, markdown, 'utf8')
  await writeFile(planMetaPath(dataDir, task.id, revision), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return meta
}

export type PlanReconcile = {
  /**
   * - `absent`   任务没有计划正文（未经计划直接执行）；
   * - `written`  首次导出（此前没有产物）；
   * - `repaired` md 与元信息不一致但元信息可信 DB：按 DB 重新导出（会落任务事件）；
   * - `ok`       产物与 DB 完全一致。
   */
  status: 'absent' | 'written' | 'repaired' | 'ok'
  meta?: PlanArtifactMeta
  sections: { complete: boolean; missing: string[] }
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

async function readMeta(path: string): Promise<PlanArtifactMeta | undefined> {
  const raw = await readIfExists(path)
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as PlanArtifactMeta
    return typeof parsed?.sha256 === 'string' && typeof parsed?.planPath === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Exec 起跑前对账：产物必须存在且与 DB 逐字节一致，否则要么补齐、要么报错。
 *
 * 「md 缺失 → 按 DB 导出」不算静默取值（DB 是唯一真值，导出本来就是单向的）；
 * 「同一 revision 内容不同」说明有一次写盘没完成或有外部改动，必须让阶段失败。
 */
export async function reconcilePlanArtifact(
  dataDir: string,
  task: Task,
  options: { editedBy?: PlanEditedBy; outcome?: string; sessionAnchor?: string; cliVersion?: string } = {}
): Promise<PlanReconcile> {
  const body = task.planContent?.trim()
  const sections = checkPlanSections(body)
  if (!body) return { status: 'absent', sections }
  const revision = task.planRevision ?? 0
  const markdown = normalizePlanText(body)
  const dbSha256 = sha256Hex(markdown)
  const mdPath = planMarkdownPath(dataDir, task.id, revision)
  const meta = await readMeta(planMetaPath(dataDir, task.id, revision))
  const fileRaw = await readIfExists(mdPath)

  if (!meta && fileRaw === undefined) {
    const written = await exportPlanArtifact(dataDir, task, {
      editedBy: options.editedBy ?? 'agent',
      ...(options.outcome ? { outcome: options.outcome } : {}),
      ...(options.sessionAnchor ? { sessionAnchor: options.sessionAnchor } : {}),
      ...(options.cliVersion ? { cliVersion: options.cliVersion } : {})
    })
    return { status: 'written', meta: written, sections }
  }
  const fileSha256 = fileRaw === undefined ? undefined : sha256Hex(fileRaw)
  if (meta?.sha256 === dbSha256 && fileSha256 === dbSha256) return { status: 'ok', meta, sections }
  // md 是模型真正会 Read 的那份：它与 DB 分叉 ⇒ 必须让人裁决，不能拿元信息或 DB 静默盖写。
  if (fileSha256 !== undefined && fileSha256 !== dbSha256)
    throw new PlanArtifactMismatchError({
      revision,
      dbSha256,
      ...(meta ? { metaSha256: meta.sha256 } : {}),
      fileSha256
    })
  // 走到这里 = md 缺失或与 DB 逐字节相同，只是元信息缺失/落后（写盘未完成）→ 按 DB 重新导出。
  const repaired = await exportPlanArtifact(dataDir, task, {
    editedBy: options.editedBy ?? 'agent',
    ...(options.outcome ? { outcome: options.outcome } : {}),
    ...(options.sessionAnchor ? { sessionAnchor: options.sessionAnchor } : {}),
    ...(options.cliVersion ? { cliVersion: options.cliVersion } : {})
  })
  return { status: 'repaired', meta: repaired, sections }
}

/** 阶段实例的输入快照：Trace span 的 `output` 指向它，实现「点阶段看它到底读了什么」。 */
export type StageInputSnapshot = {
  stageInstanceId: string
  taskId: string
  phase: string
  sessionMode: string
  parentSessionId?: string
  anchorEntryUuid?: string
  downgradeStep?: number
  fallback?: string
  /** 本阶段 prompt 的字符数与注入块清单（不落全文，全文在该 span 的 input 里）。 */
  promptChars: number
  injected: string[]
  planPath?: string
  planSha256?: string
  planSectionsComplete?: boolean
  execSummaryPath?: string
  createdAt: string
}

export async function writeStageInputSnapshot(
  dataDir: string,
  snapshot: Omit<StageInputSnapshot, 'createdAt'>
): Promise<string> {
  const path = stageSnapshotPath(dataDir, snapshot.taskId, snapshot.stageInstanceId)
  await mkdir(join(path, '..'), { recursive: true })
  const full: StageInputSnapshot = { ...snapshot, createdAt: new Date().toISOString() }
  await writeFile(path, `${JSON.stringify(full, null, 2)}\n`, 'utf8')
  return path
}

export async function writeExecSummary(dataDir: string, taskId: string, markdown: string): Promise<string> {
  const path = execSummaryPath(dataDir, taskId)
  await mkdir(taskArtifactDir(dataDir, taskId), { recursive: true })
  await writeFile(path, normalizePlanText(markdown), 'utf8')
  return path
}

export async function readExecSummary(dataDir: string, taskId: string): Promise<string | undefined> {
  return (await readIfExists(execSummaryPath(dataDir, taskId)))?.trim()
}

export type TestCasesArtifact = {
  files: string[]
  commitSha?: string
  summary?: string
  finishedAt: string
}

export async function writeTestCases(dataDir: string, taskId: string, result: TestCasesArtifact): Promise<string> {
  const path = testCasesPath(dataDir, taskId)
  await mkdir(taskArtifactDir(dataDir, taskId), { recursive: true })
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return path
}

/** 任务删除 / 重置时级联清掉产物目录（DB 删了留着一堆孤儿 md 只会误导复盘）。 */
export async function removeTaskArtifacts(dataDir: string, taskId: string): Promise<void> {
  await rm(taskArtifactDir(dataDir, taskId), { recursive: true, force: true })
}
