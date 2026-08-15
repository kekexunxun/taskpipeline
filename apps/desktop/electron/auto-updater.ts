import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

/**
 * 自动更新状态类型（与渲染进程保持一致）。
 * - checking: 正在检查更新
 * - available: 发现新版本，尚未下载
 * - not-available: 当前已是最新版本
 * - downloading: 正在下载更新
 * - downloaded: 下载完成，等待用户确认安装
 * - error: 更新过程出错
 */
export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available'; currentVersion: string }
  | { state: 'downloading'; version: string; progress: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

type UpdateListener = (status: UpdateStatus) => void

let listeners: UpdateListener[] = []
let currentStatus: UpdateStatus = { state: 'checking' }
let initialized = false

function broadcast(status: UpdateStatus) {
  currentStatus = status
  for (const listener of listeners) {
    listener(status)
  }
  // 同时通过 IPC 广播给所有渲染进程窗口
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updater:status', status)
  }
}

/**
 * 初始化自动更新模块。仅在打包后的生产环境启用。
 * 开发环境下 autoUpdater 无法正常工作（无 publish 元数据），直接跳过。
 */
export function initAutoUpdater() {
  if (initialized) return
  initialized = true

  // 开发环境不启用自动更新
  if (!app.isPackaged) {
    currentStatus = { state: 'not-available', currentVersion: 'dev' }
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    broadcast({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    broadcast({ state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    broadcast({ state: 'not-available', currentVersion: autoUpdater.currentVersion })
  })

  autoUpdater.on('download-progress', (progress) => {
    // progress 包含 percent, bytesPerSecond, total, transferred 等字段
    const status = currentStatus
    const version = status.state === 'available' || status.state === 'downloading' ? status.version : 'unknown'
    broadcast({ state: 'downloading', version, progress: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    broadcast({ state: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (error) => {
    broadcast({ state: 'error', message: error.message ?? String(error) })
  })

  // 启动后延迟 3 秒检查更新，避免阻塞窗口渲染
  setTimeout(() => {
    void checkForUpdates()
  }, 3000)
}

/** 手动触发检查更新。 */
export async function checkForUpdates(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    broadcast({ state: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

/** 开始下载已发现的更新。 */
export async function downloadUpdate(): Promise<void> {
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    broadcast({ state: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

/** 安装已下载的更新并重启应用。 */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}

/** 获取当前更新状态快照。 */
export function getUpdateStatus(): UpdateStatus {
  return currentStatus
}

/** 注册状态变更监听器（主进程内部使用）。 */
export function onUpdateStatus(listener: UpdateListener): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}
