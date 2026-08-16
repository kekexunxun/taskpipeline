import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

/**
 * GitHub Personal Access Token（私有仓库访问 Release 用）。
 * 留空字符串 = 公开仓库，无需 Token。
 * Fine-grained token 权限：Repository permissions → Contents → Read-only
 */
const GITHUB_TOKEN = ''

/** 更新检查间隔：2 小时 */
const UPDATE_CHECK_INTERVAL = 2 * 60 * 60 * 1000

/** 存储上次检查更新时间的文件路径 */
function getLastCheckFile(): string {
  return join(app.getPath('userData'), 'last-update-check.json')
}

/** 读取上次检查更新的时间戳 */
function getLastCheckTime(): number {
  try {
    const file = getLastCheckFile()
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf-8'))
      return data.lastCheck ?? 0
    }
  } catch {
    // ignore
  }
  return 0
}

/** 保存上次检查更新的时间戳 */
function setLastCheckTime(time: number): void {
  try {
    writeFileSync(getLastCheckFile(), JSON.stringify({ lastCheck: time }), 'utf-8')
  } catch {
    // ignore
  }
}

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

  // 如果配置了 GitHub Token，设置请求头用于私有仓库访问
  if (GITHUB_TOKEN) {
    autoUpdater.requestHeaders = { authorization: `token ${GITHUB_TOKEN}` }
  }

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

  // 启动后延迟 3 秒检查是否需要更新
  setTimeout(() => {
    const now = Date.now()
    const lastCheck = getLastCheckTime()
    const timeSinceLastCheck = now - lastCheck

    // 如果距离上次检查不足 2 小时，跳过自动检查
    if (timeSinceLastCheck < UPDATE_CHECK_INTERVAL) {
      // 仍然获取当前状态，但不触发网络请求
      currentStatus = { state: 'not-available', currentVersion: autoUpdater.currentVersion }
      return
    }

    // 记录本次检查时间并执行检查
    setLastCheckTime(now)
    void checkForUpdates()
  }, 3000)
}

/** 手动触发检查更新。 */
export async function checkForUpdates(): Promise<void> {
  // 手动检查时也更新时间戳，避免与自动检查重复
  setLastCheckTime(Date.now())
  // 每次检查前刷新 Token（硬编码值不变，保留结构以备将来扩展）
  if (GITHUB_TOKEN) {
    autoUpdater.requestHeaders = { authorization: `token ${GITHUB_TOKEN}` }
  }
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
