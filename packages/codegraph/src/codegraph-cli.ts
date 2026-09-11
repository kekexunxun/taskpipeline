/**
 * @optave/codegraph CLI 子进程封装。
 *
 * 默认通过 npx 调用 codegraph CLI，避免依赖冲突（better-sqlite3 与项目自身版本不一致），
 * 子进程完全隔离，崩溃不影响主进程。
 *
 * 打包后的桌面应用会注入 {@link CodegraphCliRuntime}（自带资源 + Electron 作为 Node
 * 运行时），此时不再依赖宿主 PATH / Node / npm registry。
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { BuildResult, CodegraphCliRuntime } from './types.js'

/** codegraph 包名（npx 回落路径使用） */
const CLI_PACKAGE = '@optave/codegraph'

/** 默认超时：10 分钟 */
const DEFAULT_TIMEOUT = 600_000

/** codegraph CLI 选项 */
export interface CodegraphCliOptions {
  /** 解析引擎 */
  engine: 'native' | 'wasm'
  /** 是否增量构建（默认 true） */
  incremental?: boolean
  /** 超时毫秒数 */
  timeout?: number
  /** CLI 运行时，由调用方注入自带资源；缺省回落 npx */
  cli?: CodegraphCliRuntime
}

/** 一次子进程调用的完整描述 */
interface CliInvocation {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * 将 codegraph 子命令参数组装为一次调用。
 *
 * 无 runtime 时走 `npx -y @optave/codegraph …`（开发环境直接用仓库安装）；
 * 有 runtime 时走自带资源，不假定 PATH 里有 node/npx。
 */
function toInvocation(cli: CodegraphCliRuntime | undefined, pkgArgs: string[]): CliInvocation {
  if (cli) {
    return {
      command: cli.command,
      args: [...(cli.argsPrefix ?? []), ...pkgArgs],
      env: { ...process.env, ...cli.env }
    }
  }
  return {
    command: 'npx',
    args: ['-y', CLI_PACKAGE, ...pkgArgs],
    env: process.env
  }
}

/**
 * 执行 codegraph build 命令。
 *
 * build 子命令不支持 -d 选项，固定输出到 <repoPath>/.codegraph/graph.db。
 * CodegraphManager 会在构建完成后将其移动到集中存储目录。
 *
 * @param repoPath 仓库根目录
 * @param options CLI 选项
 */
export async function runBuild(repoPath: string, options: CodegraphCliOptions): Promise<BuildResult> {
  const { engine, incremental = true, timeout = DEFAULT_TIMEOUT, cli } = options

  // --engine 是全局选项，必须放在子命令前面
  const invocation = toInvocation(cli, ['--engine', engine, 'build', repoPath])
  if (!incremental) {
    invocation.args.push('--no-incremental')
  }

  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    execFile(invocation.command, invocation.args, { timeout, env: invocation.env }, (error, stdout, stderr) => {
      const duration = Date.now() - startTime

      if (error) {
        if (error.killed) {
          reject(new Error(`codegraph build 超时 (${timeout}ms): ${repoPath}`))
          return
        }
        reject(new Error(`codegraph build 失败: ${stderr || error.message}`))
        return
      }

      // build 子命令不支持 --json，尝试从 stdout 提取数字，失败则返回估算值
      try {
        const result = parseBuildOutput(stdout)
        resolve({ ...result, duration })
      } catch {
        resolve({ fileCount: 0, nodeCount: 0, edgeCount: 0, duration })
      }
    })
  })
}

/**
 * 执行 codegraph stats 命令获取图谱统计信息。
 */
export async function runStats(
  dbPath: string,
  options: Pick<CodegraphCliOptions, 'engine' | 'timeout' | 'cli'>
): Promise<{ fileCount: number; nodeCount: number; edgeCount: number } | null> {
  if (!existsSync(dbPath)) {
    console.warn('[codegraph] stats: db not found:', dbPath)
    return null
  }

  const { engine, timeout = 30_000, cli } = options
  const invocation = toInvocation(cli, ['--engine', engine, 'stats', '-d', dbPath, '--json'])

  return new Promise((resolve) => {
    execFile(invocation.command, invocation.args, { timeout, env: invocation.env }, (error, stdout, stderr) => {
      if (error) {
        console.warn('[codegraph] stats command failed:', stderr || error.message)
        resolve(null)
        return
      }
      try {
        console.log('[codegraph] stats output:', stdout.trim())
        const stats = JSON.parse(stdout)
        console.log(
          '[codegraph] parsed stats keys:',
          Object.keys(stats),
          'files:',
          stats.files,
          'nodes:',
          stats.nodes,
          'edges:',
          stats.edges
        )
        // 输出格式: { files: { total: N }, nodes: { total: N }, edges: { total: N } }
        const extractNum = (val: unknown): number => {
          if (typeof val === 'number') return val
          if (val && typeof val === 'object') {
            const obj = val as Record<string, unknown>
            if (typeof obj.total === 'number') return obj.total
            if (typeof obj.count === 'number') return obj.count
          }
          return 0
        }
        const result = {
          fileCount: extractNum(stats.files ?? stats.fileCount),
          nodeCount: extractNum(stats.nodes ?? stats.nodeCount),
          edgeCount: extractNum(stats.edges ?? stats.edgeCount)
        }
        console.log('[codegraph] extracted result:', result)
        resolve(result)
      } catch (parseError) {
        console.warn('[codegraph] stats parse failed:', parseError, 'stdout:', stdout)
        resolve(null)
      }
    })
  })
}

/**
 * 不可抛出异常的日志写入。
 *
 * 主进程的 stdout 可能是已被关闭的管道（从终端启动、输出被重定向后接收方退出），
 * 此时 console.* 会同步抛 `write EPIPE`；子进程回调里抛出就是未捕获异常，
 * Electron 会弹错误弹窗。日志不值得搞崩主进程，写入失败直接吞掉。
 */
function safeLog(level: 'info' | 'warn', ...args: unknown[]): void {
  try {
    console[level](...args)
  } catch {
    // stdout / stderr 不可写，忽略
  }
}

/** 输出一行 watch 子进程的日志 */
function logWatchLine(level: 'info' | 'warn', msg: string): void {
  safeLog(level, '[codegraph] watch:', msg)
}

/**
 * 启动 codegraph watch 长驻进程，监听文件变更并增量更新 graph.db。
 *
 * 必须显式传 -d 指向集中存储的 db：watch 缺省按监听目录推导 db 位置
 * （<repo>/.codegraph/graph.db），而 build 后该目录已被 moveToCentral 清掉，
 * 不传 -d 会直接 `DB_ERROR: No graph.db found` 后退出。
 *
 * @param dir 监听目录
 * @param cwd 子进程工作目录（设为 dirIndexDir，副作用文件也跟着落在集中存储）
 * @param dbPath 集中存储的 graph.db 路径
 * @param options CLI 选项
 */
export function runWatch(
  dir: string,
  cwd: string,
  dbPath: string,
  options: Pick<CodegraphCliOptions, 'engine' | 'cli'>
): { process: ChildProcess; stop: () => void } {
  const { engine, cli } = options
  const invocation = toInvocation(cli, ['--engine', engine, 'watch', '-d', dbPath, dir])

  console.info('[codegraph] starting watch:', invocation.args.join(' '), 'cwd:', cwd)

  const child = spawn(invocation.command, invocation.args, {
    cwd,
    env: invocation.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  })

  child.stdout?.on('data', (data: Buffer) => {
    const msg = data.toString().trim()
    if (msg) logWatchLine('info', msg)
  })

  child.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim()
    if (msg) logWatchLine('warn', msg)
  })

  // 启动失败（如可执行文件不存在）是异步 'error' 事件，不会进 'exit'；
  // 未监听时 Node 会抛未捕获异常，直接杀掉主进程。
  child.on('error', (error) => {
    safeLog('warn', '[codegraph] watch 进程启动失败:', dir, error.message)
  })

  child.on('exit', (code, signal) => {
    safeLog('info', '[codegraph] watch exited:', { dir, code, signal })
    // watch 的 change-events.ndjson / changes.journal 是按被监听目录写入的
    // （不受 -d 控制），且常在退出时才落盘；在这里清才能避开
    // stopWatch() 里“SIGTERM 后同步删”的竞态。
    try {
      rmSync(join(dir, '.codegraph'), { recursive: true, force: true })
    } catch {
      // 清理失败不阻断退出流程；startWatch 会再清一次
    }
  })

  const stop = () => {
    if (!child.killed) {
      console.info('[codegraph] stopping watch:', dir)
      child.kill('SIGTERM')
    }
  }

  return { process: child, stop }
}

/**
 * 生成 MCP Server 启动参数。
 *
 * 自带资源模式下返回绝对路径的 command 与必需 env，
 * 使 MCP 子进程不依赖宿主 PATH / npx。
 */
export function buildMcpArgs(
  dbPath: string,
  engine: 'native' | 'wasm',
  cli?: CodegraphCliRuntime
): { command: string; args: string[]; env?: Record<string, string> } {
  const invocation = toInvocation(cli, ['--engine', engine, 'mcp', '-d', dbPath])
  if (!cli) {
    return { command: invocation.command, args: invocation.args }
  }
  return {
    command: invocation.command,
    args: invocation.args,
    // 下游可能整体替换而非合并 env，因此同时带上基础环境变量
    env: {
      ...cli.env,
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? ''
    }
  }
}

/**
 * 解析 codegraph build --json 输出。
 */
function parseBuildOutput(stdout: string): Omit<BuildResult, 'duration'> {
  // codegraph --json 输出格式可能是纯 JSON 或包含 JSON 的多行输出
  const lines = stdout.trim().split('\n')
  const jsonLine = lines.find((line) => line.trim().startsWith('{'))

  if (!jsonLine) {
    return { fileCount: 0, nodeCount: 0, edgeCount: 0 }
  }

  const data = JSON.parse(jsonLine)
  return {
    fileCount: data.files ?? data.fileCount ?? 0,
    nodeCount: data.nodes ?? data.nodeCount ?? 0,
    edgeCount: data.edges ?? data.edgeCount ?? 0
  }
}
