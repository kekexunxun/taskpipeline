/**
 * @optave/codegraph CLI 子进程封装。
 *
 * 通过 npx 调用 codegraph CLI，避免依赖冲突（better-sqlite3 v13 vs 项目 v11）。
 * 子进程完全隔离，崩溃不影响主进程。
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { BuildResult } from './types.js'

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
  const { engine, incremental = true, timeout = DEFAULT_TIMEOUT } = options

  // --engine 是全局选项，必须放在子命令前面
  const args = ['-y', '@optave/codegraph', '--engine', engine, 'build', repoPath]

  if (!incremental) {
    args.push('--no-incremental')
  }

  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    execFile('npx', args, { timeout }, (error, stdout, stderr) => {
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
  options: Pick<CodegraphCliOptions, 'engine' | 'timeout'>
): Promise<{ fileCount: number; nodeCount: number; edgeCount: number } | null> {
  if (!existsSync(dbPath)) {
    console.warn('[codegraph] stats: db not found:', dbPath)
    return null
  }

  const { engine, timeout = 30_000 } = options
  const args = ['-y', '@optave/codegraph', '--engine', engine, 'stats', '-d', dbPath, '--json']

  return new Promise((resolve) => {
    execFile('npx', args, { timeout }, (error, stdout, stderr) => {
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
 * 启动 codegraph watch 长驻进程，监听文件变更并增量更新 graph.db。
 *
 * watch 命令不支持 -d 参数，所有输出（graph.db、change-events.ndjson、changes.journal）
 * 固定写入 <cwd>/.codegraph/。通过设置 cwd 为集中存储的 hash 目录，
 * 使副作用文件写入集中存储而非项目目录。
 *
 * @param dir 监听目录
 * @param cwd 子进程工作目录（应设为 dirIndexDir，即集中存储的 per-repo 目录）
 * @param options CLI 选项
 */
export function runWatch(
  dir: string,
  cwd: string,
  options: Pick<CodegraphCliOptions, 'engine'>
): { process: ChildProcess; stop: () => void } {
  const { engine } = options
  // watch 不支持 -d 参数，输出固定写入 <cwd>/.codegraph/
  const args = ['@optave/codegraph', '--engine', engine, 'watch', dir]

  console.info('[codegraph] starting watch:', args.join(' '), 'cwd:', cwd)

  const child = spawn('npx', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  })

  child.stdout?.on('data', (data: Buffer) => {
    const msg = data.toString().trim()
    if (msg) console.info('[codegraph] watch:', msg)
  })

  child.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim()
    if (msg) console.warn('[codegraph] watch:', msg)
  })

  child.on('exit', (code, signal) => {
    console.info('[codegraph] watch exited:', { dir, code, signal })
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
 */
export function buildMcpArgs(dbPath: string, engine: 'native' | 'wasm'): { command: string; args: string[] } {
  return {
    command: 'npx',
    args: ['-y', '@optave/codegraph', '--engine', engine, 'mcp', '-d', dbPath]
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
