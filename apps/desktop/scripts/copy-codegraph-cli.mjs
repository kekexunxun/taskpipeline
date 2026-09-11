#!/usr/bin/env node
/**
 * 把 codegraph CLI 落成 Electron 应用的自带资源。
 *
 * 背景：`@task-pipeline/codegraph` 通过子进程调用 `@optave/codegraph` CLI。历史实现
 * 硬编码 `npx`，等于把功能建立在"用户机器有 node/npm 且能联网装包"之上——打包后的
 * .app 一旦被 launchd 以最小 PATH 启动（或用户根本没装 Node），就报
 * `spawn npx ENOENT`，索引与 codegraph MCP 全部静默失效。
 *
 * 本脚本按 package-lock.json 求出 `@optave/codegraph` 的运行时依赖闭包，原样拷贝到
 * `apps/desktop/codegraph-cli/`（保留 node_modules 层级，避免版本打叠），再由
 * electron-builder 以 extraResources 输出到 `Contents/Resources/codegraph-cli/`。
 * 主进程用自身 Electron 二进制 + codegraph-cli-shim.cjs 以 Node 模式执行它。
 *
 * 注意：
 * - 平台原生包 `@optave/codegraph-<os>-<cpu>`（native 引擎，单包 ~110M）不拷贝，
 *   应用固定使用 `--engine wasm`。
 * - 该目录不在 asar 内，模块解析走真实文件系统，不依赖 Electron 的 asar 补丁。
 * - 需在 electron-builder 之前执行：由各 `prepackage*` 钩子触发，也可手动运行。
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, '..')
const repoRoot = resolve(appDir, '..', '..')

/** 依赖闭包根 */
const ENTRY_KEY = 'node_modules/@optave/codegraph'
/** 运行时目录名（同时是 extraResources 的 from/to） */
const STAGE_DIR = join(appDir, 'codegraph-cli')
/** CLI 启动垫片（dev 也直接引用源文件位置） */
const SHIM_SRC = join(here, 'codegraph-cli-shim.cjs')
/** native 引擎的平台包：wasm 引擎下不需要，且体积巨大 */
const SKIP_DEP_PREFIX = '@optave/codegraph-'
/** 逐包剔除的非运行时代码（体积考量） */
const PACKAGE_SKIP_DIRS = {
  '@optave/codegraph': ['src'],
  'better-sqlite3': ['deps', 'src']
}

const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
const packages = lock.packages ?? {}

if (!packages[ENTRY_KEY]) {
  throw new Error(`[copy-codegraph-cli] package-lock.json 里没有 ${ENTRY_KEY}，请先在仓库根执行 npm install`)
}

// ── 1. 求依赖闭包（lockfile 路径即安装路径，可精确还原嵌套 / 提升） ────────────
const collected = new Map()

/** 按 npm 解析规则，从 owner 向上找 dep 的实际安装路径 */
function resolveDepKey(ownerKey, depName) {
  let owner = ownerKey
  for (;;) {
    const candidate = `${owner}/node_modules/${depName}`
    if (packages[candidate]) return candidate
    const idx = owner.lastIndexOf('/node_modules/')
    if (idx === -1) break
    owner = owner.slice(0, idx)
  }
  const hoisted = `node_modules/${depName}`
  return packages[hoisted] ? hoisted : undefined
}

function walk(ownerKey) {
  const entry = packages[ownerKey]
  const deps = { ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) }
  for (const name of Object.keys(deps)) {
    if (name.startsWith(SKIP_DEP_PREFIX)) {
      console.info(`[copy-codegraph-cli] skip native engine package: ${name}`)
      continue
    }
    const key = resolveDepKey(ownerKey, name)
    if (!key) {
      // 可选依赖在当前平台可能未安装，缺失只告警；必需依赖缺失由运行期暴露
      console.warn(`[copy-codegraph-cli] unresolved dependency: ${name} (from ${ownerKey})`)
      continue
    }
    if (collected.has(key)) continue
    collected.set(key, name)
    walk(key)
  }
}

collected.set(ENTRY_KEY, '@optave/codegraph')
walk(ENTRY_KEY)

// ── 2. 清空并拷贝（保留 lockfile 相对层级） ───────────────────────────────────
rmSync(STAGE_DIR, { recursive: true, force: true })

let fileCount = 0
let byteCount = 0
/**
 * 已落地的目标路径。入口包递归拷贝时已经带上它的嵌套 node_modules，
 * 而闭包里这些嵌套包又是独立的 key，会二次拷到同一路径——按幂等处理，
 * 避免重复 IO 与重复计数。
 */
const copied = new Set()

function copyTree(src, dest, skipTopDirs) {
  const stat = lstatSync(src)
  if (stat.isSymbolicLink()) {
    console.warn(`[copy-codegraph-cli] skip symlink: ${src}`)
    return
  }
  if (stat.isFile()) {
    if (src.endsWith('.map') || copied.has(dest)) return
    cpSync(src, dest)
    copied.add(dest)
    fileCount++
    byteCount += stat.size
    return
  }
  if (!stat.isDirectory()) return

  mkdirSync(dest, { recursive: true })
  for (const name of readdirSync(src)) {
    if (skipTopDirs?.has(name)) continue
    copyTree(join(src, name), join(dest, name), undefined)
  }
}

for (const key of collected.keys()) {
  const src = join(repoRoot, key)
  const dest = join(STAGE_DIR, key)
  if (!existsSync(src)) {
    throw new Error(`[copy-codegraph-cli] missing installed package: ${src}`)
  }
  const nested = key.lastIndexOf('/node_modules/')
  const pkgName = nested === -1 ? key.slice('node_modules/'.length) : key.slice(nested + '/node_modules/'.length)
  const skipTopDirs = PACKAGE_SKIP_DIRS[pkgName] ? new Set(PACKAGE_SKIP_DIRS[pkgName]) : undefined
  copyTree(src, dest, skipTopDirs)
}

// ── 3. 垫片入口 ──────────────────────────────────────────────────────────────
cpSync(SHIM_SRC, join(STAGE_DIR, 'codegraph-cli-shim.cjs'))

const mb = (byteCount / 1024 / 1024).toFixed(1)
console.info(`[copy-codegraph-cli] staged ${collected.size} 个包 / ${fileCount} 个文件 / ${mb} MB → ${STAGE_DIR}`)
