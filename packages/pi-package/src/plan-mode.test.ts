import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanModeContext } from '@task-pipeline/core'
import { buildPlannerEnv, extractLastAssistantText, generateNonce, PiAgentPlanModeProvider } from './plan-mode.js'

// === spawn mock =============================================================

interface FakeChild extends EventEmitter {
  pid: number
  stdout: EventEmitter & { setEncoding?: (e: string) => void }
  stderr: EventEmitter & { setEncoding?: (e: string) => void }
  kill: ReturnType<typeof vi.fn>
  killed: boolean
  spawnargs: string[]
  spawnfile: string
}

function makeFakeChild(args: { spawnargs: string[]; spawnfile: string }): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = 12345
  child.stdout = new EventEmitter() as FakeChild['stdout']
  child.stderr = new EventEmitter() as FakeChild['stderr']
  child.killed = false
  child.kill = vi.fn(() => {
    child.killed = true
    return true
  })
  child.spawnargs = args.spawnargs
  child.spawnfile = args.spawnfile
  return child
}

const spawnMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdtemp: vi.fn(actual.mkdtemp),
    writeFile: vi.fn(actual.writeFile),
    rm: vi.fn(actual.rm)
  }
})

const TEST_CTX: PlanModeContext = {
  task: {
    title: '添加用户登录',
    description: '实现一个支持邮箱密码登录的端点',
    acceptanceCriteria: ['输入合法凭据返回 token', '错误凭据返回 401']
  }
}

const TEST_CTX_WITH_FEEDBACK: PlanModeContext = {
  task: TEST_CTX.task,
  feedback: '请考虑 OAuth'
}

afterEach(() => {
  spawnMock.mockReset()
  vi.restoreAllMocks()
})

// === 基础方法 ================================================================

describe('PiAgentPlanModeProvider.instruction', () => {
  it('包含任务标题、描述、验收标准', () => {
    const provider = new PiAgentPlanModeProvider()
    const text = provider.instruction(TEST_CTX)
    expect(text).toContain('添加用户登录')
    expect(text).toContain('实现一个支持邮箱密码登录的端点')
    expect(text).toContain('- 输入合法凭据返回 token')
    expect(text).toContain('- 错误凭据返回 401')
    expect(text).toContain('不可以修改任何文件')
    expect(text).toContain('already_satisfied')
    expect(text).toContain('changes_required')
  })

  it('有 feedback 时追加调整意见段', () => {
    const provider = new PiAgentPlanModeProvider()
    const text = provider.instruction(TEST_CTX_WITH_FEEDBACK)
    expect(text).toContain('上一次计划的调整意见')
    expect(text).toContain('请考虑 OAuth')
  })

  it('无 feedback 时不出现调整意见段', () => {
    const provider = new PiAgentPlanModeProvider()
    const text = provider.instruction(TEST_CTX)
    expect(text).not.toContain('上一次计划的调整意见')
  })
})

describe('PiAgentPlanModeProvider.parseOutput', () => {
  const provider = new PiAgentPlanModeProvider()
  it('解析 already_satisfied', () => {
    expect(provider.parseOutput('{"outcome":"already_satisfied","summary":"x"}')).toEqual({
      outcome: 'already_satisfied',
      summary: 'x'
    })
  })
  it('解析 changes_required', () => {
    expect(provider.parseOutput('前缀文本 {"outcome":"changes_required","plan":"do X"} 后缀')).toEqual({
      outcome: 'changes_required',
      plan: 'do X'
    })
  })
  it('garbled 走 unparsed', () => {
    expect(provider.parseOutput('garbled')).toEqual({ outcome: 'unparsed', raw: 'garbled' })
  })
  it('缺 outcome 字段走 unparsed', () => {
    expect(provider.parseOutput('{"foo":1}')).toEqual({ outcome: 'unparsed', raw: '{"foo":1}' })
  })
})

describe('extractLastAssistantText', () => {
  it('返回最后一条 assistant 文本', () => {
    const stdout = [
      JSON.stringify({ type: 'message_start' }),
      JSON.stringify({ type: 'message_end', message: { role: 'user', content: [] } }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] }
      }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] }
      })
    ].join('\n')
    expect(extractLastAssistantText(stdout)).toBe('second')
  })
  it('没有 assistant 事件时返回空串', () => {
    const stdout = JSON.stringify({ type: 'message_start' })
    expect(extractLastAssistantText(stdout)).toBe('')
  })
  it('忽略解析失败的行', () => {
    const stdout = `garbled\n${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })}`
    expect(extractLastAssistantText(stdout)).toBe('ok')
  })
})

// === 防御层:env 净化 + nonce ===================================================

describe('buildPlannerEnv', () => {
  /** 保存原始 env,避免污染后续测试。 */
  const originalEnv = process.env
  let savedKeys: string[]

  beforeEach(() => {
    // 拷贝到可变对象,防止改原 process.env
    process.env = { ...originalEnv }
    savedKeys = []
  })

  afterEach(() => {
    // 清理测试临时设的 key
    for (const key of savedKeys) delete process.env[key]
    process.env = originalEnv
  })

  function setEnv(key: string, value: string): void {
    process.env[key] = value
    if (!savedKeys.includes(key)) savedKeys.push(key)
  }

  it('仅透传 LLM API key 类型的 env', () => {
    setEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx')
    setEnv('OPENAI_API_KEY', 'sk-openai-xxx')
    setEnv('GOOGLE_API_KEY', 'AIza-xxx')
    setEnv('JIRA_TOKEN', 'secret-jira')
    setEnv('DOCKER_HOST', 'tcp://1.2.3.4:2375')
    setEnv('ATLAS_URI', 'mongodb://host:27017')
    const env = buildPlannerEnv()
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-xxx')
    expect(env.OPENAI_API_KEY).toBe('sk-openai-xxx')
    expect(env.GOOGLE_API_KEY).toBe('AIza-xxx')
  })

  it('drop 宿主凭据:JIRA_TOKEN / DOCKER_* / *_SECRET / ATLAS', () => {
    setEnv('JIRA_TOKEN', 'secret-jira')
    setEnv('DOCKER_HOST', 'tcp://1.2.3.4:2375')
    setEnv('DOCKER_TLS_VERIFY', '1')
    setEnv('GITLAB_TOKEN_SECRET', 'shhh')
    setEnv('ATLAS_URI', 'mongodb://host:27017')
    setEnv('TASK_PIPELINE_DATA_DIR', '/private/data')
    const env = buildPlannerEnv()
    expect(env.JIRA_TOKEN).toBeUndefined()
    expect(env.DOCKER_HOST).toBeUndefined()
    expect(env.DOCKER_TLS_VERIFY).toBeUndefined()
    expect(env.GITLAB_TOKEN_SECRET).toBeUndefined()
    expect(env.ATLAS_URI).toBeUndefined()
  })

  it('透传运行时 PATH / HOME / NODE_ENV(子进程需要 node_modules 解析)', () => {
    setEnv('PATH', '/usr/local/bin:/usr/bin')
    setEnv('HOME', '/root')
    setEnv('NODE_ENV', 'test')
    const env = buildPlannerEnv()
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin')
    expect(env.HOME).toBe('/root')
    expect(env.NODE_ENV).toBe('test')
  })

  it('支持前缀白名单:CUSTOM_LLM_* / INFERENCE_* 可透传', () => {
    setEnv('CUSTOM_LLM_API_KEY', 'vendor-key')
    setEnv('CUSTOM_LLM_BASE_URL', 'https://vendor.example.com')
    setEnv('INFERENCE_REGION', 'us-west-2')
    setEnv('NOT_ALLOWED_PREFIX', 'x')
    const env = buildPlannerEnv()
    expect(env.CUSTOM_LLM_API_KEY).toBe('vendor-key')
    expect(env.CUSTOM_LLM_BASE_URL).toBe('https://vendor.example.com')
    expect(env.INFERENCE_REGION).toBe('us-west-2')
    expect(env.NOT_ALLOWED_PREFIX).toBeUndefined()
  })

  it('返回值不含未声明的 key(不会误透传宿主 env 整体)', () => {
    setEnv('SOME_RANDOM_HOST_KEY', 'hacker')
    const env = buildPlannerEnv()
    // 不应包含,但只断言几个明确的"被禁"key,避免因为 PATH 已有导致 false negative
    expect(Object.keys(env)).not.toContain('SOME_RANDOM_HOST_KEY')
  })
})

describe('generateNonce', () => {
  it('生成 32 字符 hex(16 字节)', () => {
    const n = generateNonce()
    expect(n).toMatch(/^[0-9a-f]{32}$/)
  })

  it('两次调用结果不同(避免固定 nonce 被预测)', () => {
    const a = generateNonce()
    const b = generateNonce()
    expect(a).not.toBe(b)
  })
})

// === runPlan 行为 =============================================================

async function runProvider(child: FakeChild): Promise<unknown> {
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess)
  const provider = new PiAgentPlanModeProvider()
  // 用 vi.useFakeTimers 不太好(我们用了 promise + 真实流),这里直接 await。
  return provider.runPlan(TEST_CTX, { cwd: '/tmp/workspace', hardTimeoutMs: 60_000 })
}

/** 等待 spawnMock 被调用(避免 mkdtemp await 期间 emit 错失 handler) */
async function waitForSpawn(): Promise<void> {
  while (spawnMock.mock.calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function emitAssistant(child: FakeChild, text: string): void {
  child.stdout.emit(
    'data',
    Buffer.from(
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text }] }
      })
    )
  )
}

describe('PiAgentPlanModeProvider.runPlan', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('spawn 收到 --tools read,grep,find,ls + TASK_PIPELINE_SUBAGENT=1', async () => {
    const child = makeFakeChild({ spawnargs: ['pi', '--mode', 'json'], spawnfile: '/usr/bin/node' })
    const promise = runProvider(child)
    await waitForSpawn()
    queueMicrotask(() => {
      emitAssistant(child, '{"outcome":"changes_required","plan":"do X"}')
      child.emit('close', 0, null)
    })
    await expect(promise).resolves.toEqual({ outcome: 'changes_required', plan: 'do X' })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [execPath, args, opts] = spawnMock.mock.calls[0]!
    expect(execPath).toBe(process.execPath)
    expect(args).toEqual(expect.arrayContaining(['--mode', 'json', '-p', '--no-session']))
    const argList = args as string[]
    const appendIdx = argList.indexOf('--append-system-prompt')
    expect(appendIdx).toBeGreaterThan(-1)
    expect(argList[appendIdx + 1]).toMatch(/planner\.md$/)
    const toolsIdx = argList.indexOf('--tools')
    expect(argList[toolsIdx + 1]).toBe('read,grep,find,ls')
    expect(argList).toContain('--cwd')
    expect(argList).toContain('/tmp/workspace')
    expect((opts as { cwd: string }).cwd).toBe('/tmp/workspace')
    expect((opts as { env: Record<string, string> }).env.TASK_PIPELINE_SUBAGENT).toBe('1')
    expect((opts as { env: Record<string, string> }).env.PATH).toBeDefined()
  })

  it('L4: spawn 包含 --no-extensions,防三方 extension 重新引入 bash', async () => {
    const child = makeFakeChild({ spawnargs: [], spawnfile: '' })
    const promise = runProvider(child)
    await waitForSpawn()
    queueMicrotask(() => {
      emitAssistant(child, '{"outcome":"changes_required","plan":"x"}')
      child.emit('close', 0, null)
    })
    await promise
    const args = spawnMock.mock.calls[0]?.[1] as string[]
    expect(args).toContain('--no-extensions')
  })

  it('L7: spawn 包含 --subagent-nonce 且与 env 中 TASK_PIPELINE_SUBAGENT_NONCE 一致', async () => {
    const child = makeFakeChild({ spawnargs: [], spawnfile: '' })
    const promise = runProvider(child)
    await waitForSpawn()
    queueMicrotask(() => {
      emitAssistant(child, '{"outcome":"changes_required","plan":"x"}')
      child.emit('close', 0, null)
    })
    await promise
    const args = spawnMock.mock.calls[0]?.[1] as string[]
    const opts = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> }
    const nonceIdx = args.indexOf('--subagent-nonce')
    expect(nonceIdx).toBeGreaterThan(-1)
    const flagNonce = args[nonceIdx + 1]
    expect(flagNonce).toMatch(/^[0-9a-f]{32}$/)
    expect(opts.env.TASK_PIPELINE_SUBAGENT_NONCE).toBe(flagNonce)
  })

  it('L5: spawn env 净化:宿主凭据 JIRA_TOKEN / DOCKER_* 不会透传到子进程', async () => {
    const child = makeFakeChild({ spawnargs: [], spawnfile: '' })
    const savedJira = process.env.JIRA_TOKEN
    const savedDocker = process.env.DOCKER_HOST
    process.env.JIRA_TOKEN = 'secret-jira'
    process.env.DOCKER_HOST = 'tcp://1.2.3.4:2375'
    try {
      const promise = runProvider(child)
      await waitForSpawn()
      queueMicrotask(() => {
        emitAssistant(child, '{"outcome":"changes_required","plan":"x"}')
        child.emit('close', 0, null)
      })
      await promise
      const opts = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> }
      expect(opts.env.JIRA_TOKEN).toBeUndefined()
      expect(opts.env.DOCKER_HOST).toBeUndefined()
      // 标记位仍然存在
      expect(opts.env.TASK_PIPELINE_SUBAGENT).toBe('1')
    } finally {
      if (savedJira === undefined) delete process.env.JIRA_TOKEN
      else process.env.JIRA_TOKEN = savedJira
      if (savedDocker === undefined) delete process.env.DOCKER_HOST
      else process.env.DOCKER_HOST = savedDocker
    }
  })

  it('退出码 0 + 正常 assistant 文本 → 解析 ParsedPlan', async () => {
    const child = makeFakeChild({ spawnargs: [], spawnfile: '' })
    const promise = runProvider(child)
    await waitForSpawn()
    queueMicrotask(() => {
      emitAssistant(child, '{"outcome":"already_satisfied","summary":"代码已满足"}')
      child.emit('close', 0, null)
    })
    await expect(promise).resolves.toEqual({ outcome: 'already_satisfied', summary: '代码已满足' })
  })

  it('退出码非 0 → 抛出含 stderr 末尾的 Error', async () => {
    const child = makeFakeChild({ spawnargs: [], spawnfile: '' })
    const promise = runProvider(child)
    await waitForSpawn()
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('ENOENT spawn failed'))
      child.emit('close', 1, null)
    })
    await expect(promise).rejects.toThrow(/planner 退出码 1/)
    await expect(promise).rejects.toThrow(/ENOENT spawn failed/)
  })

  it('进程被信号终止 → 抛出含信号名的 Error', async () => {
    const child = makeFakeChild({ spawnargs: [], spawnfile: '' })
    const promise = runProvider(child)
    await waitForSpawn()
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
    await expect(promise).rejects.toThrow(/SIGTERM/)
  })

  it("signal abort 触发 kill('SIGTERM')", async () => {
    const child = makeFakeChild({ spawnargs: [], spawnfile: '' })
    spawnMock.mockReturnValueOnce(child as unknown as ChildProcess)
    const provider = new PiAgentPlanModeProvider()
    const controller = new AbortController()
    const promise = provider.runPlan(TEST_CTX, {
      cwd: '/tmp/workspace',
      hardTimeoutMs: 60_000,
      signal: controller.signal
    })
    await waitForSpawn()
    controller.abort()
    // 等 microtask 让 onAbort 跑
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    // 收尾:触发 close 让 promise 落地
    child.emit('close', null, 'SIGTERM')
    await expect(promise).rejects.toThrow(/SIGTERM/)
  })

  it("进程 error 事件 → 抛出含'planner 启动失败'", async () => {
    const child = makeFakeChild({ spawnargs: [], spawnfile: '' })
    const promise = runProvider(child)
    await waitForSpawn()
    queueMicrotask(() => child.emit('error', new Error('ENOENT: not found')))
    await expect(promise).rejects.toThrow(/planner 启动失败/)
    await expect(promise).rejects.toThrow(/ENOENT/)
  })

  it('spawn 失败时清理 tmp 目录', async () => {
    const child = makeFakeChild({ spawnargs: [], spawnfile: '' })
    const rmSpy = vi.mocked(rm)
    const promise = runProvider(child)
    await waitForSpawn()
    queueMicrotask(() => child.emit('error', new Error('ENOENT')))
    await expect(promise).rejects.toThrow()
    // 至少一次 rm 调用是 cleanup 路径
    expect(rmSpy).toHaveBeenCalled()
    const cleanupCall = rmSpy.mock.calls.find((call) => {
      const arg = call[0] as string
      return /task-pipeline-planner-/.test(arg)
    })
    expect(cleanupCall).toBeDefined()
  })
})
