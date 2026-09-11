#!/usr/bin/env node
// Electron-builder 在 asar 打包时只能包含 `apps/desktop/` 下的文件。
// npm workspace 把 `@task-pipeline/*` 安装为指向 `packages/*` 的符号链接，
// 解析依赖时会跳到 `apps/desktop/` 之外的位置，触发
// "must be under apps/desktop/" 错误。
// 本脚本把 `packages/*/dist` 与 `package.json` 真实拷贝到
// `apps/desktop/node_modules/@task-pipeline/*`，让 electron-builder 解析时
// 停在应用目录内，避免跨出根目录。
//
// 该步骤必须早于 electron-builder 运行：推荐在 `prepackage` 触发，
// 也可手动执行 `node scripts/copy-monorepo-packages.mjs` 排查问题。

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, '..')
const repoRoot = resolve(appDir, '..', '..')
const packagesRoot = join(repoRoot, 'packages')

const SCOPE = '@task-pipeline/'

// 包清单从 apps/desktop/package.json 的 dependencies 推导：
// 任何新增的 workspace 内部包都会自动纳入 staging，避免硬编码列表漏项
// 导致 electron-builder 跟随符号链接越出 apps/desktop/ 而复发
// "must be under apps/desktop/" 报错。
const appPkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
const declared = Object.keys(appPkg.dependencies ?? {})
  .filter((name) => name.startsWith(SCOPE))
  .map((name) => name.slice(SCOPE.length))

const packages = []
for (const name of declared) {
  if (existsSync(join(packagesRoot, name))) {
    packages.push(name)
  } else {
    console.warn(`[copy-monorepo-packages] skip ${SCOPE}${name}: not a workspace package under packages/`)
  }
}

for (const name of packages) {
  const targetDir = join(appDir, 'node_modules', '@task-pipeline', name)
  const sourceDist = join(packagesRoot, name, 'dist')
  const sourcePkg = join(packagesRoot, name, 'package.json')

  if (!existsSync(sourceDist)) {
    throw new Error(`[copy-monorepo-packages] missing source: ${sourceDist} (先执行 npm run build -w ${SCOPE}${name})`)
  }
  if (!existsSync(sourcePkg)) {
    throw new Error(`[copy-monorepo-packages] missing source: ${sourcePkg} (先执行 npm run build -w ${SCOPE}${name})`)
  }

  // 必须先清掉符号链接，否则 cpSync 会把内容复制到链接指向的源目录
  if (existsSync(targetDir) || lstatSafe(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true })
  }

  mkdirSync(targetDir, { recursive: true })
  copyDirSync(sourceDist, join(targetDir, 'dist'))
  copyFileSync(sourcePkg, join(targetDir, 'package.json'))
  console.info(`[copy-monorepo-packages] staged @task-pipeline/${name}`)
}

function lstatSafe(path) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function copyDirSync(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath)
    } else if (entry.isSymbolicLink()) {
      // 跳过符号链接以免再次出现跨目录问题
      continue
    }
  }
}
