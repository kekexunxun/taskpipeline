import { describe, expect, it, vi } from 'vitest'

/**
 * 阶段实例 / fork 锚点算法单测。
 *
 * 假 SDK 只提供两样东西：`getSessionMessages`（读父会话条目树，可用 __setTranscript / __failTranscript
 * 编排）与 `QoderCliProcessError`（降级重试的判据）。锚点算法与降级阶梯都是纯逻辑，不需要起真会话。
 */
vi.mock('@qoder-ai/qoder-agent-sdk', () => {
  const state: { entries: Array<{ type: string; uuid: string }>; fail: boolean } = { entries: [], fail: false }
  return {
    getSessionMessages: async () => {
      if (state.fail) throw new Error('EACCES: permission denied')
      return [...state.entries]
    },
    QoderCliProcessError: class QoderCliProcessError extends Error {
      readonly exitCode: number | null
      readonly stderr: string
      constructor(message: string, options?: { exitCode?: number | null; stderr?: string }) {
        super(message)
        this.name = 'QoderCliProcessError'
        this.exitCode = options?.exitCode ?? null
        this.stderr = options?.stderr ?? ''
      }
    },
    __setTranscript: (entries: Array<{ type: string; uuid: string }>) => {
      state.entries = entries
      state.fail = false
    },
    __failTranscript: (fail: boolean) => {
      state.fail = fail
    }
  }
})

const {
  describeLaunch,
  hasSessionTranscript,
  inheritsContext,
  isResumableStartupFailure,
  nextLaunch,
  permissionsForStage,
  resolveForkAnchorUuid,
  stageIdOfTask,
  stageInstanceId,
  stagePhaseOf
} = await import('./stage-session.js')
const { QoderCliProcessError, __setTranscript, __failTranscript } = (await import(
  '@qoder-ai/qoder-agent-sdk'
)) as unknown as {
  QoderCliProcessError: new (message: string, options?: { exitCode?: number | null; stderr?: string }) => Error
  __setTranscript: (entries: Array<{ type: string; uuid: string }>) => void
  __failTranscript: (fail: boolean) => void
}

/** SessionLaunch 的结构别名（避免为单个用例 import type）。 */
type SessionLaunchShape = Parameters<typeof describeLaunch>[0]

const CWD = '/tmp/repo'

describe('stagePhaseOf / 阶段实例标识', () => {
  it('test_generation 自 P2 起是独立阶段实例（输入是 exec.summary，不是实现推理）', () => {
    expect(stagePhaseOf('planning')).toBe('planning')
    expect(stagePhaseOf('implementation')).toBe('implementation')
    expect(stagePhaseOf('test_generation')).toBe('test')
  })

  it('stageInstanceId 以 taskId 开头，可按任务前缀级联清理', () => {
    const id = stageInstanceId('task-1', 'implementation', 2)
    expect(id).toBe('task-1:implementation:2')
    expect(stageIdOfTask(id, 'task-1')).toBe(true)
    expect(stageIdOfTask(id, 'task')).toBe(false)
  })
})

describe('resolveForkAnchorUuid', () => {
  it('取最后一个 turn 的最后一条 entry，而不是它的 user 条目', async () => {
    // 指到 user 条目会被 CLI 判为「丢弃范围不以该 turn 的 prompt 开头」→ exit 42（实测 V3）。
    __setTranscript([
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a1' },
      { type: 'user', uuid: 'u2' },
      { type: 'assistant', uuid: 'a2' }
    ])
    expect(await resolveForkAnchorUuid('sess-1', CWD)).toBe('a2')
  })

  it('忽略 user / assistant 之外的条目（runtime-config / last-prompt 等）', async () => {
    __setTranscript([
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a1' },
      { type: 'runtime-config', uuid: 'r1' },
      { type: 'last-prompt', uuid: 'l1' }
    ])
    expect(await resolveForkAnchorUuid('sess-1', CWD)).toBe('a1')
  })

  it('最后一个 turn 只有 user 条目时返回该 user（这是唯一可保留的尾部）', async () => {
    __setTranscript([
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a1' },
      { type: 'user', uuid: 'u2' }
    ])
    expect(await resolveForkAnchorUuid('sess-1', CWD)).toBe('u2')
  })

  it('会话不存在 / 无 user turn → undefined（交给降级链，不抛）', async () => {
    __setTranscript([])
    expect(await resolveForkAnchorUuid('missing-sess', CWD)).toBeUndefined()
    __setTranscript([{ type: 'runtime-config', uuid: 'r1' }])
    expect(await resolveForkAnchorUuid('sess-1', CWD)).toBe('r1')
  })

  it('读会话文件失败与「会话不存在」同档处理', async () => {
    __failTranscript(true)
    await expect(resolveForkAnchorUuid('sess-1', CWD)).resolves.toBeUndefined()
    await expect(hasSessionTranscript('sess-1', CWD)).resolves.toBe(false)
  })

  it('hasSessionTranscript 决定要不要直接跳到全量重放', async () => {
    __setTranscript([{ type: 'user', uuid: 'u1' }])
    await expect(hasSessionTranscript('sess-1', CWD)).resolves.toBe(true)
    __setTranscript([])
    await expect(hasSessionTranscript('sess-1', CWD)).resolves.toBe(false)
  })
})

describe('降级阶梯', () => {
  const forkWithAnchor = {
    mode: 'fork' as const,
    stageInstanceId: 'task-1:implementation:1',
    resume: 'sess-plan',
    forkSession: true,
    resumeSessionAt: 'a2',
    anchorEntryUuid: 'a2'
  }

  it('fork(anchor) → fork(全量继承) → 全量重放 → 阶梯到头', () => {
    const step1 = nextLaunch(forkWithAnchor, 'anchor-rejected')
    expect(step1?.mode).toBe('fork')
    expect(step1?.resumeSessionAt).toBeUndefined()
    expect(step1?.downgradeStep).toBe(1)
    expect(step1?.fallback).toBe('anchor-rejected')

    const step2 = nextLaunch(step1!, 'fork-failed')
    expect(step2?.mode).toBe('new')
    expect(step2?.resume).toBeUndefined()
    expect(step2?.fallback).toBe('fork-failed')

    expect(nextLaunch(step2!, 'fork-failed')).toBeUndefined()
  })

  it('resume 失败只降一档：全量 prompt 重放', () => {
    const step = nextLaunch({ mode: 'resume', stageInstanceId: 's', resume: 'sess-1' }, 'resume-failed')
    expect(step).toEqual({ mode: 'new', stageInstanceId: 's', downgradeStep: 1, fallback: 'resume-failed' })
  })

  it('continue（活会话已死）→ resume → 全量重放', () => {
    const step1 = nextLaunch({ mode: 'continue', stageInstanceId: 's', resume: 'sess-1' }, 'session-lost')
    expect(step1?.mode).toBe('resume')
    expect(step1?.resume).toBe('sess-1')
    const step2 = nextLaunch(step1!, 'resume-failed')
    expect(step2?.mode).toBe('new')
    expect(nextLaunch(step2!, 'resume-failed')).toBeUndefined()
  })

  it('plan_schema_incomplete 不拆出的实例仍可走普通降级（只是起点不同）', () => {
    // 不拆边界 = 继续用上一阶段的活会话；它挂了就照 continue 的阶梯往下走。
    const reused: SessionLaunchShape = {
      mode: 'continue',
      stageInstanceId: 'task-1:planning:1',
      resume: 'sess-plan',
      downgradeStep: 1,
      fallback: 'plan_schema_incomplete'
    }
    expect(describeLaunch(reused)).toBe('同会话续接（降级第 1 档）')
    const step = nextLaunch(reused, 'session-lost')
    expect(step?.mode).toBe('resume')
    expect(step?.downgradeStep).toBe(2)
  })

  it('continue 且无 sessionId 可续时直接全量重放', () => {
    const step = nextLaunch({ mode: 'continue', stageInstanceId: 's' }, 'session-lost')
    expect(step?.mode).toBe('new')
  })

  it('只有启动期进程错误才允许降级重试（已有输出 = 可能已有副作用）', () => {
    expect(isResumableStartupFailure(new QoderCliProcessError('exited with code 42', { exitCode: 42 }))).toBe(true)
    expect(isResumableStartupFailure(new Error('boom'))).toBe(false)
    expect(isResumableStartupFailure(undefined)).toBe(false)
  })

  it('inheritsContext:除全量重放外都算继承了上下文', () => {
    expect(inheritsContext({ mode: 'new', stageInstanceId: 's' })).toBe(false)
    expect(inheritsContext({ mode: 'continue', stageInstanceId: 's' })).toBe(true)
    expect(inheritsContext({ mode: 'resume', stageInstanceId: 's', resume: 'r' })).toBe(true)
    expect(inheritsContext({ mode: 'fork', stageInstanceId: 's', resume: 'r', forkSession: true })).toBe(true)
  })

  it('describeLaunch 把降级档位说人话（Trace / 任务事件不能只剩英文枚举）', () => {
    expect(describeLaunch(forkWithAnchor)).toBe('fork（截断到 anchor）')
    expect(
      describeLaunch({ ...forkWithAnchor, resumeSessionAt: undefined, downgradeStep: 1, fallback: 'fork-failed' })
    ).toBe('fork（全量继承）（降级第 1 档）')
    expect(describeLaunch({ mode: 'new', stageInstanceId: 's' })).toBe('全量 prompt 重放')
  })
})

describe('阶段级会话权限（P4）', () => {
  it('Plan 阶段：default 档位 + 写类工具从 CLI 层禁掉', () => {
    const plan = permissionsForStage('planning')
    expect(plan.permissionMode).toBe('default')
    // 名字必须是 V10 实测 init tools 里的写法；猜错的名字 SDK 不报错，只会静默地不禁
    expect(plan.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit'])
  })

  it('实现 / 测试阶段：acceptEdits 且不禁工具（测试路径约束在 core L1）', () => {
    expect(permissionsForStage('implementation')).toEqual({ permissionMode: 'acceptEdits' })
    expect(permissionsForStage('test')).toEqual({ permissionMode: 'acceptEdits' })
  })

  it('上下文超预算算可解释的降级原因（fork 不是免费的）', () => {
    const launch: SessionLaunchShape = {
      mode: 'new',
      stageInstanceId: 'task-1:implementation:2',
      downgradeStep: 1,
      fallback: 'context-budget'
    }
    expect(inheritsContext(launch)).toBe(false)
    // 全量重放是阶梯终点：不能再往下降
    expect(nextLaunch(launch, 'context-budget')).toBeUndefined()
  })
})
