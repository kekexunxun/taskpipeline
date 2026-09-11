import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import type { CodegraphCliRuntime } from '@task-pipeline/codegraph'

/**
 * 解析 codegraph CLI 的子进程运行时。
 *
 * codegraph CLI 是独立的 Node 程序。历史实现依赖宿主 `npx`，在打包后的 .app 里
 * 等于要求用户机器装有 Node 且 PATH 能被继承，否则 `spawn npx ENOENT`，索引与
 * codegraph MCP 静默失效。这里改为用应用自身的 Electron 二进制以
 * ELECTRON_RUN_AS_NODE 模式充当 Node 运行时，执行随包分发的自带资源
 * （由 scripts/copy-codegraph-cli.mjs 落地、经 extraResources 输出）。
 *
 * 解析顺序：
 * - 打包环境：Contents/Resources/codegraph-cli/
 * - 开发环境：优先 apps/desktop/codegraph-cli/（与产线同构），否则退回仓库
 *   node_modules 里的安装（需先执行 npm run stage:codegraph-cli）
 *
 * 全部不可用时返回 null，由 @task-pipeline/codegraph 回落 npx 并打印告警。
 */

/** 自带资源目录名 */
const RESOURCE_DIR = 'codegraph-cli'
/** 启动垫片文件名 */
const SHIM_FILE = 'codegraph-cli-shim.cjs'
/** CLI 入口相对自带资源目录的位置 */
const ENTRY_REL = join('node_modules', '@optave', 'codegraph', 'dist', 'cli.js')

const here = dirname(fileURLToPath(import.meta.url))

export function resolveCodegraphCliRuntime(): CodegraphCliRuntime | null {
  const candidates = app.isPackaged
    ? [{ dir: join(process.resourcesPath, RESOURCE_DIR) }]
    : [
        // 开发环境优先用已 stage 的自带资源，行为与产线一致
        { dir: join(here, '..', '..', RESOURCE_DIR) },
        { dir: undefined as string | undefined }
      ]

  for (const candidate of candidates) {
    const runtime = candidate.dir ? fromStagedDir(candidate.dir) : fromRepoNodeModules()
    if (runtime) {
      console.info('[codegraph] CLI 运行时:', {
        command: runtime.command,
        entry: runtime.env?.CODEGRAPH_CLI_ENTRY
      })
      return runtime
    }
    if (candidate.dir) {
      console.info('[codegraph] 自带资源缺失，继续回退:', candidate.dir)
    }
  }

  console.warn(
    '[codegraph] 未找到自带的 codegraph CLI，回退宿主 npx（打包环境可能不可用）。' +
      '请执行 npm run stage:codegraph-cli'
  )
  return null
}

/** 从自带资源目录（打包后的 Resources/codegraph-cli 或开发期的 apps/desktop/codegraph-cli）解析 */
function fromStagedDir(dir: string): CodegraphCliRuntime | null {
  const shim = join(dir, SHIM_FILE)
  const entry = join(dir, ENTRY_REL)
  if (!existsSync(shim) || !existsSync(entry)) return null
  return buildRuntime(shim, entry)
}

/** 开发环境退回仓库 node_modules 安装：垫片仍用同一份源文件，入口走模块解析 */
function fromRepoNodeModules(): CodegraphCliRuntime | null {
  const shim = join(here, '..', '..', 'scripts', SHIM_FILE)
  if (!existsSync(shim)) return null
  let entry: string
  try {
    entry = createRequire(import.meta.url).resolve('@optave/codegraph/cli')
  } catch {
    return null
  }
  return existsSync(entry) ? buildRuntime(shim, entry) : null
}

function buildRuntime(shim: string, entry: string): CodegraphCliRuntime {
  return {
    // 打包后 process.execPath 即应用主二进制；以 Node 模式运行不弹窗、不起第二实例
    command: process.execPath,
    argsPrefix: [shim],
    env: { ELECTRON_RUN_AS_NODE: '1', CODEGRAPH_CLI_ENTRY: entry }
  }
}
