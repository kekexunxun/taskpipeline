import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * 探测 qodercli 二进制路径并写入 QODERCLI_PATH 环境变量。
 * 仅在未手动设置时生效，打包后从 resources 目录读取，开发模式从项目目录读取。
 *
 * ⚠️ 这个变量不只选二进制路径：SDK 的隐式 runtime 选择把它当作
 * 「调用方要 process transport」的信号（见 qoder-session.resolveQoderTransport）——
 * 设了它就从包默认的 WorkerTransport 切到 ProcessTransport，以避开 asar 内 spawn ENOTDIR。
 * 因此不能为了「复用 worker runtime」而随手删掉它；transport 已随 Trace span meta 落档。
 */
export function resolveQodercliPath(): void {
  if (process.env.QODERCLI_PATH) return
  const binaryName = process.platform === 'win32' ? 'qodercli.exe' : 'qodercli'
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'qoder-bin', binaryName)
    : join(app.getAppPath(), 'qoder-bin', binaryName)
  if (existsSync(candidate)) {
    process.env.QODERCLI_PATH = candidate
  }
}
