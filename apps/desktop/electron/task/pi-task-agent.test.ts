import { describe, expect, it, vi } from 'vitest'
import type { Task, TaskStore } from '@task-pipeline/core'

/**
 * Pi 运行时的阶段边界判定单测（P3）。
 *
 * `pi-session.ts` 是机制层（真开会话要绑扩展、读 models.json），这里全部换成脚本化假实现：
 * 被测对象只剩「拆不拆实例、产物从哪儿取、降级要不要留痕」这三件 driver 自己的事。
 */
const sessionCalls: Array<{ taskId: string; body: string; context?: { stageInstanceId?: string } }> = []
const forkCalls: Array<{ taskId: string }> = []

const state: {
  forkResult: { file?: string; error?: string }
  captureText: string
  captureError: string | undefined
  agentEndTexts: string[]
  sessionId: string | undefined
  promptError: unknown
} = {
  forkResult: { file: 'pi-sessions/forked.jsonl' },
  captureText: '',
  captureError: undefined,
  agentEndTexts: [],
  sessionId: undefined,
  promptError: undefined
}

vi.mock('./pi-session.js', () => ({
  ensurePiSession: async (taskId: string, context?: { stageInstanceId?: string; phase?: string }) => {
    sessionCalls.push({ taskId, body: '', ...(context ? { context } : {}) })
    return {
      prompt: async (body: string) => {
        if (state.promptError) throw state.promptError
        sessionCalls.at(-1)!.body = body
      },
      waitForIdle: async () => undefined
    }
  },
  forkPiStage: async (taskId: string) => {
    forkCalls.push({ taskId })
    return state.forkResult
  },
  beginPiCapture: () => undefined,
  endPiCapture: () => ({ text: state.captureText, error: state.captureError }),
  takePiAgentEndTexts: () => {
    const texts = [...state.agentEndTexts]
    state.agentEndTexts = []
    return texts
  },
  getPiSessionInfo: (taskId: string) => (state.sessionId ? { taskId, sessionId: state.sessionId } : undefined),
  releasePiSession: async () => undefined
}))

const { decidePiFork, PiTaskAgent } = await import('./pi-task-agent.js')

const COMPLETE_PLAN = [
  '## 实施步骤',
  '',
  '第 1 步：改 a.ts',
  '',
  '## 已定位文件与依据',
  '',
  '- a.ts：唯一引用点',
  '',
  '## 已否决方案与理由',
  '',
  '- 新建包装层：改动面更大',
  '',
  '## 验证方式',
  '',
  '- 跑单测'
].join('\n')

function makeStore(task: Partial<Task> & { id: string }): TaskStore {
  return {
    getTask: () => ({ ...task }) as Task,
    updateTask: () => undefined
  } as unknown as TaskStore
}

function agent(task: Partial<Task> & { id: string } = { id: 'task-1' }) {
  const logs: Array<{ taskId: string; title: string; detail: string }> = []
  const a = new PiTaskAgent({
    store: makeStore(task),
    logStage: (taskId, title, detail) => logs.push({ taskId, title, detail })
  })
  return { a, logs }
}

function resetSessionState(): void {
  sessionCalls.length = 0
  forkCalls.length = 0
  state.forkResult = { file: 'pi-sessions/forked.jsonl' }
  state.captureText = ''
  state.captureError = undefined
  state.agentEndTexts = []
  state.sessionId = undefined
  state.promptError = undefined
}

describe('decidePiFork', () => {
  it('Plan 是链路起点：任何时候都不 fork', () => {
    expect(decidePiFork({ phase: 'planning', hasParentSession: true, planComplete: true })).toEqual({
      fork: false,
      reason: 'first-stage'
    })
    expect(
      decidePiFork({ phase: 'planning', currentPhase: 'implementation', hasParentSession: true, planComplete: true })
        .reason
    ).toBe('first-stage')
  })

  it('同一阶段实例内续接优先于阶段边界（重跑计划 / auto-fix / 追加消息）', () => {
    expect(
      decidePiFork({
        phase: 'implementation',
        currentPhase: 'implementation',
        hasParentSession: true,
        planComplete: true
      }).reason
    ).toBe('same-stage-reuse')
    expect(
      decidePiFork({
        phase: 'implementation',
        trigger: 'followup',
        currentPhase: 'planning',
        hasParentSession: true,
        planComplete: true
      }).reason
    ).toBe('same-stage-reuse')
  })

  it('计划缺三段时 Exec 不拆实例（存量任务不重探仓库）', () => {
    expect(
      decidePiFork({ phase: 'implementation', currentPhase: 'planning', hasParentSession: true, planComplete: false })
        .reason
    ).toBe('plan-schema-incomplete')
  })

  it('Test 阶段不看计划三段：它要的是「改了什么」，不是计划契约', () => {
    expect(
      decidePiFork({
        phase: 'test_generation',
        currentPhase: 'implementation',
        hasParentSession: true,
        planComplete: false
      }).reason
    ).toBe('stage-boundary')
  })

  it('没有可继承的会话文件时不 fork（改新开会话）', () => {
    expect(
      decidePiFork({ phase: 'implementation', currentPhase: 'planning', hasParentSession: false, planComplete: true })
        .reason
    ).toBe('no-parent-session')
  })

  it('阶段边界 + 有父会话 = fork', () => {
    expect(
      decidePiFork({ phase: 'implementation', currentPhase: 'planning', hasParentSession: true, planComplete: true })
    ).toEqual({ fork: true, reason: 'stage-boundary' })
  })
})

describe('PiTaskAgent.runStage', () => {
  it('capabilities：Pi 能 fork / 能按叶子截断，但没有按阶段设权限的原语', () => {
    const { a } = agent()
    expect(a.capabilities()).toEqual({ fork: true, truncateAt: true, perPhasePermission: false })
  })

  it('Plan → Exec 拆阶段实例：exec 从 plan 会话 fork，实例 id 换阶段且序号重起', async () => {
    resetSessionState()
    state.captureText = '第 1 步：改 a.ts'
    const { a } = agent({ id: 'task-1', planContent: COMPLETE_PLAN, piSessionPath: 'pi-sessions/plan.jsonl' })
    const plan = await a.runStage({ taskId: 'task-1', phase: 'planning', body: '出个计划' })
    expect(plan.stageInstanceId).toBe('task-1:planning:1')
    expect(plan.sessionMode).toBe('new')
    // 计划阶段产物来自回捞文本（编排层要拿它 parse 决策 JSON）。
    expect(plan.responseTexts).toEqual(['第 1 步：改 a.ts'])

    state.captureText = ''
    const exec = await a.runStage({ taskId: 'task-1', phase: 'implementation', body: '按计划改' })
    expect(forkCalls).toEqual([{ taskId: 'task-1' }])
    expect(exec.stageInstanceId).toBe('task-1:implementation:1')
    expect(exec.sessionMode).toBe('fork')
    // 会话归属跟着阶段实例走，事件层才能标出「这条 delta 属于哪个阶段」。
    expect(sessionCalls.at(-1)?.context?.stageInstanceId).toBe('task-1:implementation:1')
  })

  it('同阶段重跑不 fork，沿用实例并把会话标为续接', async () => {
    resetSessionState()
    const { a } = agent({ id: 'task-1', planContent: COMPLETE_PLAN })
    await a.runStage({ taskId: 'task-1', phase: 'planning', body: '第一版' })
    const second = await a.runStage({ taskId: 'task-1', phase: 'planning', body: '第二版' })
    expect(forkCalls.length).toBe(0)
    expect(second.stageInstanceId).toBe('task-1:planning:1')
    expect(second.sessionMode).toBe('continue')
    expect(sessionCalls.length).toBe(2)
    expect(sessionCalls[1]?.body).toBe('第二版')
  })

  it('实现阶段产物取 agent_end，而不是流式增量', async () => {
    resetSessionState()
    state.agentEndTexts = ['已完成：改了 a.ts']
    const { a } = agent({ id: 'task-1', planContent: COMPLETE_PLAN })
    const exec = await a.runStage({ taskId: 'task-1', phase: 'implementation', body: '改吧' })
    expect(exec.responseTexts).toEqual(['已完成：改了 a.ts'])
    // 实现阶段不看回捞：capture 不该被打开。
    expect(exec.sessionMode).toBe('new')
  })

  it('计划缺三段：不 fork、沿用计划实例，且必须留一条可见的降级说明', async () => {
    resetSessionState()
    const { a, logs } = agent({
      id: 'task-1',
      planContent: '第 1 步：改 a.ts',
      piSessionPath: 'pi-sessions/plan.jsonl'
    })
    await a.runStage({ taskId: 'task-1', phase: 'planning', body: '出个计划' })
    const exec = await a.runStage({ taskId: 'task-1', phase: 'implementation', body: '改吧' })
    expect(forkCalls.length).toBe(0)
    // 不拆实例 = 实现继续挂在计划实例上（与 Qoder 侧同一档处理）。
    expect(exec.stageInstanceId).toBe('task-1:planning:1')
    expect(logs.map((log) => log.title)).toContain('实现阶段未拆会话边界')
    expect(logs.at(-1)?.detail).toContain('plan-schema-incomplete')
  })

  it('fork 失败不让任务失败：退化成新开会话并记一笔（降级不许静默）', async () => {
    resetSessionState()
    state.forkResult = { error: 'Cannot fork: source session file is empty or invalid' }
    const { a, logs } = agent({ id: 'task-1', planContent: COMPLETE_PLAN, piSessionPath: 'pi-sessions/plan.jsonl' })
    await a.runStage({ taskId: 'task-1', phase: 'planning', body: '出个计划' })
    const exec = await a.runStage({ taskId: 'task-1', phase: 'implementation', body: '改吧' })
    expect(forkCalls.length).toBe(1)
    expect(exec.stageInstanceId).toBe('task-1:implementation:1')
    // 新会话没继承前缀 → 启动方式必须是 new，不能谎报 fork。
    expect(exec.sessionMode).toBe('new')
    expect(logs.map((log) => log.title)).toContain('实现阶段 fork 失败')
    // 降级原因要能到人事后看出是「抛错」还是「根本没会话文件」，否则等于静默降级。
    expect(logs.at(-1)?.detail).toContain('source session file is empty or invalid')
  })

  it('追加消息（trigger）跨阶段也不拆实例', async () => {
    resetSessionState()
    const { a } = agent({ id: 'task-1', planContent: COMPLETE_PLAN, piSessionPath: 'pi-sessions/plan.jsonl' })
    await a.runStage({ taskId: 'task-1', phase: 'planning', body: '出个计划' })
    const followup = await a.runStage({
      taskId: 'task-1',
      phase: 'implementation',
      body: '再补一点',
      trigger: 'followup'
    })
    expect(forkCalls.length).toBe(0)
    expect(followup.stageInstanceId).toBe('task-1:planning:1')
    expect(followup.sessionMode).toBe('continue')
  })

  it('回捞期报错按阶段失败上抛，不把半截文本当产物交回', async () => {
    resetSessionState()
    state.captureError = 'provider 401'
    const { a } = agent({ id: 'task-1' })
    await expect(a.runStage({ taskId: 'task-1', phase: 'planning', body: '出个计划' })).rejects.toThrow('provider 401')
  })

  it('会话 id 落到阶段产物上（失败后续接与对账用）', async () => {
    resetSessionState()
    state.sessionId = 'pi-sess-9'
    const { a } = agent({ id: 'task-1' })
    const plan = await a.runStage({ taskId: 'task-1', phase: 'planning', body: 'x' })
    expect(plan.sessionId).toBe('pi-sess-9')
    expect(a.collectResult('task-1', 'planning').sessionId).toBe('pi-sess-9')
  })

  it('forgetTask 后阶段实例与产物一起丢（reset 不能续旧会话标签）', async () => {
    resetSessionState()
    state.captureText = '第一版计划'
    const { a } = agent({ id: 'task-1' })
    await a.runStage({ taskId: 'task-1', phase: 'planning', body: '出个计划' })
    expect(a.collectResult('task-1', 'planning').responseTexts).toEqual(['第一版计划'])
    a.forgetTask('task-1')
    expect(a.stageOf('task-1')).toBeUndefined()
    expect(a.collectResult('task-1', 'planning').responseTexts).toEqual([])
    // 新一轮计划是新实例（序号从 1 重起），不会续上一轮的会话归属。
    state.captureText = '第二版计划'
    const again = await a.runStage({ taskId: 'task-1', phase: 'planning', body: '重新出' })
    expect(again.stageInstanceId).toBe('task-1:planning:1')
    expect(again.sessionMode).toBe('new')
  })

  it('任务不存在时直接失败，不开会话', async () => {
    resetSessionState()
    const logs: string[] = []
    const a = new PiTaskAgent({
      store: { getTask: () => undefined, updateTask: () => undefined } as unknown as TaskStore,
      logStage: (_taskId, title) => logs.push(title)
    })
    await expect(a.runStage({ taskId: 'missing', phase: 'planning', body: 'x' })).rejects.toThrow('Task not found')
    expect(sessionCalls.length).toBe(0)
  })
})
