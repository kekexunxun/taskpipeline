import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { ParsedPlan, PlanModeContext, PlanModeProvider, RunPlanOptions } from '@task-pipeline/core'

/** planner 子 agent 允许的工具集 — 全部只读 */
const PLANNER_TOOLS = ['read', 'grep', 'find', 'ls'] as const

/**
 * 显式透传到子进程的 env 变量名(脱敏名不在表里者全部 drop)。
 * - LLM API key: Anthropic / OpenAI / Google / xAI / Mistral
 * - LLM 路由/baseUrl
 * - 运行时: PATH(让 pi 能找到 node_modules / shell),HOME(让 LLM 工具读到 ~/.config)
 * - 显式标记: TASK_PIPELINE_SUBAGENT + TASK_PIPELINE_SUBAGENT_NONCE(在 spawn env 里硬设)
 *
 * **不放** 的:JIRA_TOKEN / DOCKER_* / TASK_PIPELINE_DATA_DIR / 任何 *_SECRET / 任何
 * 宿主进程的 ATLAS / 数据库 / 业务凭据。子进程被攻陷后,只能调 LLM + 读 env 净化后的 PATH。
 */
const PLANNER_ENV_ALLOWLIST = [
  // LLM 提供商
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
  // LLM 路由/baseUrl
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  // 运行时
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'NODE_ENV',
  'NO_COLOR',
  'TERM'
] as const

/** 额外允许的前缀(用于供应商自定义 env,例如 CUSTOM_LLM_API_KEY)。 */
const PLANNER_ENV_PREFIXES = ['CUSTOM_LLM_', 'INFERENCE_'] as const

/**
 * 从父进程 env 中提炼出子进程可用的最小子集。
 * 防止 JIRA_TOKEN / DOCKER_* / 宿主 secret 一同进入子进程,
 * 即便子进程被攻陷,宿主凭据不会泄露。
 */
export function buildPlannerEnv(): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const key of PLANNER_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) sanitized[key] = value
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (PLANNER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      sanitized[key] = value
    }
  }
  return sanitized
}

/** 生成 16 字节 hex 的 nonce,父设子验,防 env 手动 set 绕过。 */
export function generateNonce(): string {
  return randomBytes(16).toString('hex')
}

interface PlannerResult {
  raw: string
  exitCode: number
  signal: NodeJS.Signals | null
  stderr: string
  durationMs: number
}

/**
 * Pi-agent / pi-package 端的 PlanModeProvider — 子 agent 隔离实现。
 *
 * plan 阶段不修改主 session 的 active tools / hook,改成 spawn 一个子 pi 进程
 * 跑 planner(tools = read/grep/find/ls)。子进程是 separate process,根本不可能
 * 改写主 session 的工作区。
 */
export class PiAgentPlanModeProvider implements PlanModeProvider {
  readonly providerId = 'pi-agent' as const

  instruction(ctx: PlanModeContext): string {
    return [
      '你是一个只读分析 agent。只能使用 read / grep / find / ls 工具探索代码,绝对不可以修改任何文件,也不可以执行会改变工作区的命令。',
      '任务结束时必须输出一个 JSON 对象(不要输出过程说明或 Markdown 代码块):',
      '- 如果代码已满足任务要求,输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}',
      '- 否则输出 {"outcome":"changes_required","plan":"完整实施计划,包含涉及文件、实施步骤、验证方式和风险"}',
      '',
      '## 任务信息',
      `标题: ${ctx.task.title}`,
      '',
      '描述:',
      ctx.task.description,
      '',
      '验收标准:',
      ...ctx.task.acceptanceCriteria.map((item) => `- ${item}`),
      ctx.feedback ? `\n## 上一次计划的调整意见\n${ctx.feedback}` : ''
    ].join('\n')
  }

  parseOutput(raw: string): ParsedPlan {
    const match = /\{[\s\S]*?"outcome"[\s\S]*?\}/.exec(raw)
    if (!match) return { outcome: 'unparsed', raw }
    try {
      const parsed = JSON.parse(match[0]) as { outcome?: string; summary?: string; plan?: string }
      if (parsed.outcome === 'already_satisfied' && typeof parsed.summary === 'string') {
        return { outcome: 'already_satisfied', summary: parsed.summary }
      }
      if (parsed.outcome === 'changes_required' && typeof parsed.plan === 'string') {
        return { outcome: 'changes_required', plan: parsed.plan }
      }
    } catch {
      /* fallthrough */
    }
    return { outcome: 'unparsed', raw }
  }

  async runPlan(ctx: PlanModeContext, options: RunPlanOptions = {}): Promise<ParsedPlan> {
    const { signal, cwd, hardTimeoutMs = 5 * 60_000 } = options
    const result = await this.spawnPlanner(ctx, { signal, cwd, hardTimeoutMs })
    if (result.signal) throw new Error(`planner 被信号 ${result.signal} 终止`)
    if (result.exitCode !== 0) {
      throw new Error(`planner 退出码 ${result.exitCode},stderr 末尾: ${result.stderr.slice(-2000)}`)
    }
    return this.parseOutput(result.raw)
  }

  private async spawnPlanner(
    ctx: PlanModeContext,
    options: { signal?: AbortSignal; cwd?: string; hardTimeoutMs: number }
  ): Promise<PlannerResult> {
    const tmpDir = await mkdtemp(join(tmpdir(), 'task-pipeline-planner-'))
    const promptFile = join(tmpDir, 'planner.md')
    try {
      await writeFile(promptFile, this.instruction(ctx), { encoding: 'utf-8', mode: 0o600 })
    } catch (error) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
      throw new Error(`planner 写入 prompt 失败: ${error instanceof Error ? error.message : String(error)}`)
    }

    // process.argv[1] 在 pi CLI 启动时是 pi 的入口脚本路径;Electron 环境下需调用方
    // 通过 RunPlanOptions 显式覆盖(本 provider 不在此处处理跨环境,风险见 plan 6.1)。
    const scriptPath = process.argv[1] ?? 'pi'
    const userMessage = `请开始分析下面的任务并输出 plan JSON。\n\n标题: ${ctx.task.title}\n\n${ctx.task.description}`
    const nonce = generateNonce()
    const args: string[] = [
      '--mode',
      'json',
      '-p', // non-interactive print mode
      '--no-session',
      '--no-extensions', // L4: 不加载任何 extension,工具集仅来自 --tools
      '--append-system-prompt',
      promptFile,
      '--tools',
      [...PLANNER_TOOLS].join(','),
      '--subagent-nonce',
      nonce // 传给子进程,子进程 guard 验
    ]
    if (options.cwd) args.push('--cwd', options.cwd)

    const started = performance.now()
    // L5 env 净化:只透传 LLM/运行时 env,JIRA_TOKEN / DOCKER_* / 宿主 secret 全部 drop
    // L6 nonce env 标记:让子进程 guard 能验证身份(双重身份校验)
    const sanitizedEnv = buildPlannerEnv()
    const proc: ChildProcess = spawn(process.execPath, [scriptPath, ...args, userMessage], {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...sanitizedEnv,
        TASK_PIPELINE_SUBAGENT: '1',
        TASK_PIPELINE_SUBAGENT_NONCE: nonce
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let killedByUs = false

    const cleanup = (): void => {
      rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    }

    const onAbort = (): void => {
      if (killedByUs) return
      killedByUs = true
      try {
        proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (!proc.killed) {
          try {
            proc.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }
      }, 5_000)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const hardTimer = setTimeout(() => {
      if (killedByUs) return
      killedByUs = true
      try {
        proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }, options.hardTimeoutMs)

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    return new Promise<PlannerResult>((resolve, reject) => {
      proc.on('error', (error) => {
        clearTimeout(hardTimer)
        options.signal?.removeEventListener('abort', onAbort)
        cleanup()
        reject(new Error(`planner 启动失败: ${error.message}`))
      })

      proc.on('close', (code, signal) => {
        clearTimeout(hardTimer)
        options.signal?.removeEventListener('abort', onAbort)
        const raw = extractLastAssistantText(stdout)
        cleanup()
        resolve({ raw, exitCode: code ?? -1, signal, stderr, durationMs: performance.now() - started })
      })
    })
  }
}

/** 从 `--mode json` 输出的事件流里抽出最后一条 assistant 文本。 */
export function extractLastAssistantText(stdout: string): string {
  let lastText = ''
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event: { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } } | null
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event?.type === 'message_end' && event?.message?.role === 'assistant') {
      const content = event.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            lastText = block.text
          }
        }
      }
    }
  }
  return lastText
}
