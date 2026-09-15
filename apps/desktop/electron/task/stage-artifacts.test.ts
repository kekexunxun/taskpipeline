import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '@task-pipeline/core'

import {
  PLAN_REQUIRED_SECTIONS,
  PlanArtifactMismatchError,
  artifactFileName,
  checkPlanSections,
  execSummaryPath,
  exportPlanArtifact,
  normalizePlanText,
  planMarkdownPath,
  planMetaPath,
  readExecSummary,
  reconcilePlanArtifact,
  removeTaskArtifacts,
  sha256Hex,
  stageSnapshotPath,
  writeExecSummary,
  writeStageInputSnapshot,
  writeTestCases
} from './stage-artifacts.js'

function taskWith(overrides: Partial<Task> = {}): Task {
  return { id: 'task-1', title: 'T', planContent: '## 实施步骤\n\n改 a.ts\n', planRevision: 0, ...overrides } as Task
}

const PLAN_BODY = '## 实施步骤\n\n改 a.ts\n'

describe('normalizePlanText / sha256Hex', () => {
  it('行尾与首尾空白不影响指纹（对账要的是内容，不是编辑器习惯）', () => {
    const lf = normalizePlanText(PLAN_BODY)
    expect(normalizePlanText(PLAN_BODY.replace(/\n/g, '\r\n'))).toBe(lf)
    expect(normalizePlanText(`  \n${PLAN_BODY}  \n`)).toBe(lf)
    expect(lf.endsWith('\n')).toBe(true)
    expect(sha256Hex(normalizePlanText(PLAN_BODY))).toBe(sha256Hex(normalizePlanText(PLAN_BODY + '\n\n')))
  })

  it('sha256Hex 是标准实现（拿空串与已知值对齐，防止换成别的摘要）', () => {
    expect(sha256Hex('')).toBe(createHash('sha256').update('', 'utf8').digest('hex'))
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('checkPlanSections（§4.3 三段契约）', () => {
  it('标题层级与前导空格都宽松匹配，缺哪段就报哪段', () => {
    const complete = ['正文', '### 已定位文件与依据', 'x', '## 已否决方案与理由', 'y', '#### 验证方式', 'z'].join('\n')
    expect(checkPlanSections(complete)).toEqual({ complete: true, missing: [] })
    const partial = '## 实施步骤\n\n## 验证方式\n- 跑单测'
    const result = checkPlanSections(partial)
    expect(result.complete).toBe(false)
    expect(result.missing).toEqual([PLAN_REQUIRED_SECTIONS[0], PLAN_REQUIRED_SECTIONS[1]])
  })

  it('正文里出现「验证方式」字样不算命中（必须是标题行）', () => {
    expect(checkPlanSections('验证方式：跑单测').complete).toBe(false)
    expect(checkPlanSections(undefined).missing).toHaveLength(PLAN_REQUIRED_SECTIONS.length)
  })
})

describe('artifactFileName / 路径', () => {
  it('stageInstanceId 的冒号安全化，taskId 里的分隔符不能逃出目录', () => {
    expect(artifactFileName('task-1:implementation:2')).toBe('task-1_implementation_2')
    expect(artifactFileName('a/b')).toBe('a_b')
    expect(stageSnapshotPath('/d', 'task-1', 'task-1:test:3')).toBe(
      join('/d', 'tasks', 'task-1', 'stages', 'task-1_test_3.json')
    )
    expect(planMarkdownPath('/d', 'task-1', 4)).toBe(join('/d', 'tasks', 'task-1', 'plan.v4.md'))
  })
})

describe('exportPlanArtifact / reconcilePlanArtifact', () => {
  let dataDir = ''

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'stage-artifacts-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('无计划正文 → absent：不写文件（未经计划直接执行的任务没有交接契约）', async () => {
    const result = await reconcilePlanArtifact(dataDir, taskWith({ planContent: undefined }))
    expect(result.status).toBe('absent')
    expect(result.meta).toBeUndefined()
    expect(result.sections.complete).toBe(false)
  })

  it('首版导出 → written，再对账 → ok：三个文件逐字节可对账', async () => {
    const task = taskWith()
    const first = await reconcilePlanArtifact(dataDir, task)
    expect(first.status).toBe('written')
    expect(first.meta?.sha256).toBe(sha256Hex(normalizePlanText(PLAN_BODY)))
    expect(readFileSync(planMarkdownPath(dataDir, task.id, 0), 'utf8')).toBe(normalizePlanText(PLAN_BODY))

    const second = await reconcilePlanArtifact(dataDir, task)
    expect(second.status).toBe('ok')
    expect(second.meta?.planPath).toBe(planMarkdownPath(dataDir, task.id, 0))
  })

  it('显式导出会带 outcome / anchor / cliVersion（Trace 与跨机器定位用）', async () => {
    const meta = await exportPlanArtifact(dataDir, taskWith({ planRevision: 2 }), {
      editedBy: 'user',
      outcome: 'changes_required',
      sessionAnchor: 'a2',
      cliVersion: '1.1.23'
    })
    expect(meta).toMatchObject({
      revision: 2,
      editedBy: 'user',
      outcome: 'changes_required',
      sessionAnchor: 'a2',
      cliVersion: '1.1.23'
    })
    expect(JSON.parse(readFileSync(planMetaPath(dataDir, 'task-1', 2), 'utf8'))).toMatchObject({ editedBy: 'user' })
  })

  it('md 被外部改动 → 抛错且报出三方 sha（不允许静默取其一）', async () => {
    const task = taskWith()
    await exportPlanArtifact(dataDir, task, { editedBy: 'agent' })
    writeFileSync(planMarkdownPath(dataDir, task.id, 0), '被人手改过的一版\n', 'utf8')
    const error = await reconcilePlanArtifact(dataDir, task).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PlanArtifactMismatchError)
    const mismatch = (error as PlanArtifactMismatchError).mismatch
    expect(mismatch.dbSha256).toBe(sha256Hex(normalizePlanText(PLAN_BODY)))
    expect(mismatch.metaSha256).toBe(mismatch.dbSha256)
    expect(mismatch.fileSha256).toBe(sha256Hex('被人手改过的一版\n'))
    expect((error as Error).message).toContain('计划产物与数据库不一致')
    // 失败不能顺手改写文件：留给人在 DB / md 之间做决定。
    expect(readFileSync(planMarkdownPath(dataDir, task.id, 0), 'utf8')).toBe('被人手改过的一版\n')
  })

  it('写盘未完成（md 缺失或元信息落后）→ repaired：按 DB 补齐并留痕', async () => {
    const task = taskWith()
    await exportPlanArtifact(dataDir, task, { editedBy: 'agent' })
    rmSync(planMarkdownPath(dataDir, task.id, 0))
    expect((await reconcilePlanArtifact(dataDir, task)).status).toBe('repaired')

    // 元信息落后一个 revision 的内容，但 md 与 DB 相同 → 只是记账没跟上，补齐即可。
    writeFileSync(
      planMetaPath(dataDir, task.id, 0),
      JSON.stringify({ revision: 0, sha256: sha256Hex('旧的'), editedBy: 'agent', planPath: 'x', exportedAt: '' }),
      'utf8'
    )
    const repaired = await reconcilePlanArtifact(dataDir, task)
    expect(repaired.status).toBe('repaired')
    expect(repaired.meta?.sha256).toBe(sha256Hex(normalizePlanText(PLAN_BODY)))
  })

  it('revision 递增即换文件：旧版产物保留，可 diff 也可追溯', async () => {
    await exportPlanArtifact(dataDir, taskWith({ planRevision: 0 }), { editedBy: 'agent' })
    const v1 = taskWith({ planContent: '## 实施步骤\n\n改 b.ts\n', planRevision: 1 })
    expect((await reconcilePlanArtifact(dataDir, v1)).status).toBe('written')
    expect(existsSync(planMarkdownPath(dataDir, 'task-1', 0))).toBe(true)
    expect(existsSync(planMarkdownPath(dataDir, 'task-1', 1))).toBe(true)
    // 拿 v1 的 DB 去对 v0 的文件不会串版本。
    await expect(reconcilePlanArtifact(dataDir, v1)).resolves.toMatchObject({ status: 'ok' })
  })
})

describe('Exec / Test 交接产物与级联清理', () => {
  let dataDir = ''

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'stage-artifacts-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('exec.summary.md 写入后可读回；没有时 undefined（Test 阶段据此降级）', async () => {
    expect(await readExecSummary(dataDir, 'task-1')).toBeUndefined()
    const path = await writeExecSummary(dataDir, 'task-1', '## 实现结论\n\n改了 a.ts')
    expect(path).toBe(execSummaryPath(dataDir, 'task-1'))
    expect(await readExecSummary(dataDir, 'task-1')).toBe('## 实现结论\n\n改了 a.ts')
  })

  it('阶段输入快照按实例落盘，供 span output 点击展开', async () => {
    const path = await writeStageInputSnapshot(dataDir, {
      stageInstanceId: 'task-1:implementation:2',
      taskId: 'task-1',
      phase: 'implementation',
      sessionMode: 'fork',
      anchorEntryUuid: 'a2',
      promptChars: 1234,
      injected: ['任务描述', '计划正文']
    })
    const snap = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(snap).toMatchObject({ sessionMode: 'fork', anchorEntryUuid: 'a2', promptChars: 1234 })
    expect(typeof snap.createdAt).toBe('string')
  })

  it('test.cases.json 记录文件清单；removeTaskArtifacts 连目录一起清', async () => {
    await exportPlanArtifact(dataDir, taskWith(), { editedBy: 'agent' })
    const casesPath = await writeTestCases(dataDir, 'task-1', { files: ['a_test.ts'], summary: '3 例', finishedAt: '' })
    expect((JSON.parse(readFileSync(casesPath, 'utf8')) as { files: string[] }).files).toEqual(['a_test.ts'])
    await removeTaskArtifacts(dataDir, 'task-1')
    expect(existsSync(join(dataDir, 'tasks', 'task-1'))).toBe(false)
    // 目录本来不存在时也不能抛（reimplement / delete 都要能幂等）。
    await expect(removeTaskArtifacts(dataDir, 'task-1')).resolves.toBeUndefined()
  })
})
