#!/usr/bin/env node
// Electron-builder 在 asar 打包时只能包含 `apps/desktop/` 下的文件。
// npm workspace 把 `@coding-agent/*` 安装为指向 `packages/*` 的符号链接，
// 解析依赖时会跳到 `apps/desktop/` 之外的位置，触发
// "must be under apps/desktop/" 错误。
// 本脚本把 `packages/*/dist` 与 `package.json` 真实拷贝到
// `apps/desktop/node_modules/@coding-agent/*`，让 electron-builder 解析时
// 停在应用目录内，避免跨出根目录。
//
// 该步骤必须早于 electron-builder 运行：推荐在 `prepackage` 触发，
// 也可手动执行 `node scripts/copy-monorepo-packages.mjs` 排查问题。

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, '..')
const repoRoot = resolve(appDir, '..', '..')
const packagesRoot = join(repoRoot, 'packages')

const packages = ['core', 'integrations', 'pi-package']

for (const name of packages) {
  const targetDir = join(appDir, 'node_modules', '@coding-agent', name)
  const sourceDist = join(packagesRoot, name, 'dist')
  const sourcePkg = join(packagesRoot, name, 'package.json')

  if (!existsSync(sourceDist)) {
    throw new Error(`[copy-monorepo-packages] missing source: ${sourceDist}`)
  }
  if (!existsSync(sourcePkg)) {
    throw new Error(`[copy-monorepo-packages] missing source: ${sourcePkg}`)
  }

  // 必须先清掉符号链接，否则 cpSync 会把内容复制到链接指向的源目录
  if (existsSync(targetDir) || lstatSafe(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true })
  }

  mkdirSync(targetDir, { recursive: true })
  copyDirSync(sourceDist, join(targetDir, 'dist'))
  copyFileSync(sourcePkg, join(targetDir, 'package.json'))
  console.log(`[copy-monorepo-packages] staged @coding-agent/${name}`)
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
