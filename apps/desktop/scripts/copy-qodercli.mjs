#!/usr/bin/env node
// @qoder-ai/qoder-agent-sdk 通过 import.meta.url 解析 dist/_bundled/qodercli 路径:
//
//   function Tt() {
//     if (process.env.QODERCLI_PATH) return process.env.QODERCLI_PATH;
//     let s = vr();   // 用 import.meta.url/../_bundled/qodercli
//     ...
//   }
//
// Electron 打包后,SDK 的 dist/index.js 仍位于 app.asar 内,import.meta.url
// 指向虚拟路径。asar 透明层让 existsSync 误判 qodercli "存在",但 spawn 一个
// asar 内的二进制(无真实 inode)会失败 ENOTDIR。
//
// 本脚本把 qodercli 复制到 apps/desktop/qoder-bin/ 这个稳定位置,配合
// main.ts 设置 process.env.QODERCLI_PATH 显式指定,SDK 会优先使用。
// qoder-bin/ 同时加进 asarUnpack,确保 spawn 时拿到真实磁盘文件。
//
// 该步骤必须早于 electron-builder 运行:在 prepackage 阶段触发。

import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 通过 Node 模块解析找 SDK 实际位置 —— 兼容 npm workspace hoist(根 node_modules)
// 和非 hoist 两种情况。SDK 的 package.json 不在 exports 里,所以走 dist/index.js
// 入口,再 dirname 回推包根目录。
const sdkEntryUrl = import.meta.resolve('@qoder-ai/qoder-agent-sdk')
const sdkRoot = dirname(dirname(fileURLToPath(sdkEntryUrl)))

const binaryName = process.platform === 'win32' ? 'qodercli.exe' : 'qodercli'
const source = join(sdkRoot, 'dist', '_bundled', binaryName)
const destDir = join(import.meta.dirname, '..', 'qoder-bin')
const dest = join(destDir, binaryName)

if (!existsSync(source)) {
  throw new Error(`[copy-qodercli] missing source binary: ${source}`)
}

mkdirSync(destDir, { recursive: true })
copyFileSync(source, dest)

// copyFileSync 不会复制源文件权限(保留 destination 现有 umask),
// qodercli 必须可执行。Windows 忽略,macOS / Linux 显式 chmod 0o755。
if (process.platform !== 'win32') {
  const srcMode = statSync(source).mode & 0o777
  // 至少保证 rwxr-xr-x;若源更严格(例如仅 owner 可执行)则尊重源。
  chmodSync(dest, srcMode | 0o755)
}
console.log(`[copy-qodercli] staged ${dest}`)
