#!/usr/bin/env node
/**
 * codegraph CLI 启动垫片（被 Electron 以 ELECTRON_RUN_AS_NODE 模式执行）。
 *
 * 打包后的应用用自身 Electron 二进制充当 Node 运行时来跑 @optave/codegraph，
 * 直接 `Electron dist/cli.js <子命令>` 是不行的，有两个必须在此处理的差异：
 *
 * 1. argv 布局：codegraph 依赖的 commander 一旦检测到 `process.versions.electron`
 *    存在就按 'electron' 风格解析参数（`argv.slice(1)`），而 ELECTRON_RUN_AS_NODE
 *    下 argv 仍是 `[execPath, script, ...用户参数]`，于是脚本路径会被当成子命令，
 *    报 `error: unknown command '<...>/dist/cli.js'`。置 `process.defaultApp = true`
 *    可让 commander 回到 `slice(2)`，与 node 行为一致。
 * 2. 入口位置：真正要执行的 CLI 路径由宿主通过 CODEGRAPH_CLI_ENTRY 传入，
 *    避免把资源路径混进子命令参数序列里。
 */

/* eslint-disable @typescript-eslint/no-require-imports */
'use strict'

const { pathToFileURL } = require('node:url')

process.defaultApp = true

const entry = process.env.CODEGRAPH_CLI_ENTRY
if (!entry) {
  console.error('[codegraph-shim] 缺少 CODEGRAPH_CLI_ENTRY 环境变量，无法定位 codegraph CLI 入口')
  process.exit(1)
}

import(pathToFileURL(entry).href).catch((error) => {
  console.error('[codegraph-shim] 加载 codegraph CLI 失败:', error && error.message ? error.message : error)
  process.exit(1)
})
