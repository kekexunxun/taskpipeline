import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:os'
import { app, BrowserWindow, net } from 'electron'
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

/** GitHub 仓库地址（用于构造 latest-mac.yml 的 raw URL）。 */
const GITHUB_REPO = 'kekexunxun/taskpipeline'

// ────────────────────────────────────────────────────────────────────────────
// macOS 自定义更新：绕过 Squirrel.Mac 签名校验
// ────────────────────────────────────────────────────────────────────────────

/** macOS 自定义更新时暂存的远端版本信息 */
interface MacPendingUpdate {
  version: string
  zipUrl: string
  sha512: string
  size: number
}

let macPendingUpdate: MacPendingUpdate | null = null

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
 * 简易解析 latest-mac.yml（electron-builder 生成的更新清单）。
 * 避免引入 yaml 依赖——该文件格式固定且简单。
 */
function parseLatestMacYml(text: string): {
  version: string
  zipFile: string
  zipSha512: string
  zipSize: number
} {
  const lines = text.split('\n')
  let version = ''
  let zipFile = ''
  let zipSha512 = ''
  let zipSize = 0
  let inFiles = false

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.startsWith('version:')) {
      version = line
        .split(':')
        .slice(1)
        .join(':')
        .trim()
        .replace(/^['"]|['"]$/g, '')
    }
    if (line.trimStart() === 'files:') {
      inFiles = true
      continue
    }
    if (inFiles) {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('- url:')) {
        const url = trimmed
          .slice(6)
          .trim()
          .replace(/^['"]|['"]$/g, '')
        if (url.endsWith('.zip')) {
          zipFile = url
        }
      }
      // zip 条目是 files 列表的第一个带 sha512 的条目
      if (trimmed.startsWith('sha512:') && !zipSha512 && zipFile) {
        zipSha512 = trimmed
          .slice(8)
          .trim()
          .replace(/^['"]|['"]$/g, '')
      }
      if (trimmed.startsWith('size:') && zipFile) {
        zipSize = parseInt(trimmed.slice(6).trim(), 10)
        if (zipFile && zipSha512 && zipSize) break
      }
    }
  }
  return { version, zipFile, zipSha512, zipSize }
}

/** macOS: 从 GitHub Release 获取最新版本信息 */
async function macGetLatestVersion(): Promise<MacPendingUpdate | null> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (GITHUB_TOKEN) {
    headers['Authorization'] = `token ${GITHUB_TOKEN}`
  }

  // 通过 GitHub API 获取 latest release 信息
  const releaseResp = await net.fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { headers })
  if (!releaseResp.ok) return null

  const release = (await releaseResp.json()) as {
    tag_name: string
    assets: Array<{
      name: string
      browser_download_url: string
      size: number
    }>
  }

  const remoteVersion = release.tag_name.replace(/^v/, '')
  if (remoteVersion === app.getVersion()) return null

  // 查找 mac zip 资源
  const zipAsset = release.assets.find((a) => a.name.endsWith('.zip') && a.name.includes('mac'))
  if (!zipAsset) return null

  // 尝试下载 latest-mac.yml 获取 SHA512（用于完整性校验）
  const ymlAsset = release.assets.find((a) => a.name === 'latest-mac.yml')
  let sha512 = ''
  if (ymlAsset) {
    try {
      const ymlResp = await net.fetch(ymlAsset.browser_download_url)
      if (ymlResp.ok) {
        const parsed = parseLatestMacYml(await ymlResp.text())
        sha512 = parsed.zipSha512
      }
    } catch {
      // yml 获取失败不阻塞更新
    }
  }

  return {
    version: remoteVersion,
    zipUrl: zipAsset.browser_download_url,
    sha512,
    size: zipAsset.size
  }
}

/** macOS: 下载更新 zip 到临时目录，带进度回调和 SHA512 校验 */
async function macDownloadZip(update: MacPendingUpdate, onProgress: (percent: number) => void): Promise<string> {
  const tempDir = join(app.getPath('temp'), `taskpipeline-update-${Date.now()}`)
  mkdirSync(tempDir, { recursive: true })
  const destFile = join(tempDir, 'update.zip')

  const headers: Record<string, string> = {}
  if (GITHUB_TOKEN) {
    headers['Authorization'] = `token ${GITHUB_TOKEN}`
  }

  const resp = await net.fetch(update.zipUrl, { headers })
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`)

  const total = Number(resp.headers.get('content-length')) || update.size || 0
  let downloaded = 0
  let lastPercent = -1
  const hash = createHash('sha512')

  const body = resp.body
  if (!body) throw new Error('Download failed: empty response body')

  // ReadableStream → file
  const reader = body.getReader()
  const fileStream = createWriteStream(destFile)

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    fileStream.write(value)
    hash.update(value)
    downloaded += value.length
    if (total > 0) {
      const pct = Math.round((downloaded / total) * 100)
      if (pct !== lastPercent) {
        lastPercent = pct
        onProgress(pct)
      }
    }
  }
  fileStream.end()
  await new Promise<void>((resolve, reject) => {
    fileStream.on('finish', resolve)
    fileStream.on('error', reject)
  })

  // SHA512 校验
  if (update.sha512) {
    const actual = hash.digest('base64')
    if (actual !== update.sha512) {
      rmSync(tempDir, { recursive: true, force: true })
      throw new Error(`SHA512 mismatch: expected ${update.sha512}, got ${actual}`)
    }
  }

  return destFile
}

/** macOS: 解压 zip 并通过 AppleScript 替换当前 app，然后重启 */
async function macInstallUpdate(zipPath: string): Promise<void> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)

  const tempExtractDir = join(app.getPath('temp'), `taskpipeline-extract-${Date.now()}`)
  mkdirSync(tempExtractDir, { recursive: true })

  try {
    // 1. 解压 zip
    await execFileAsync('unzip', ['-q', '-o', zipPath, '-d', tempExtractDir])

    // 2. 定位解压出的 .app
    const { readdirSync, statSync } = await import('node:fs')
    const entries = readdirSync(tempExtractDir)
    const appEntry = entries.find((e) => e.endsWith('.app'))
    if (!appEntry) throw new Error('No .app found in update zip')

    const newAppPath = join(tempExtractDir, appEntry)
    const stat = statSync(newAppPath)
    if (!stat.isDirectory()) throw new Error('Extracted .app is not a directory')

    // 3. 清除 quarantine 属性，避免 Gatekeeper 拦截
    try {
      await execFileAsync('xattr', ['-cr', newAppPath])
    } catch {
      // xattr 失败不阻塞
    }

    // 4. 通过 osascript 替换 /Applications 中的旧 app 并重启
    const currentAppPath = process.execPath.replace(/\/Contents\/MacOS\/.*$/, '')
    const script = `
tell application "System Events"
  set appRunning to (name of processes) contains "TaskPipeline"
end tell
if appRunning then
  tell application "TaskPipeline" to quit
  delay 2
end if
do shell script "rm -rf " & quoted form of "${currentAppPath}"
do shell script "mv " & quoted form of "${newAppPath}" & " " & quoted form of "${currentAppPath}"
do shell script "open " & quoted form of "${currentAppPath}"
`
    try {
      await execFileAsync('osascript', ['-e', script])
    } catch {
      // osascript 需要管理员权限时可能失败，尝试通过 Finder 替换
      const fallbackScript = `
tell application "Finder"
  delete POSIX file "${currentAppPath}"
  move POSIX file "${newAppPath}" to POSIX file "/Applications/"
end tell
do shell script "open " & quoted form of "${currentAppPath}"
`
      await execFileAsync('osascript', ['-e', fallbackScript])
    }

    // 5. 重启当前进程（如果 osascript 没有杀掉我们）
    app.relaunch()
    app.exit(0)
  } catch (error) {
    // 清理临时文件
    try {
      rmSync(tempExtractDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
    throw error
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 公共 API
// ────────────────────────────────────────────────────────────────────────────

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

const IS_MAC = platform() === 'darwin'

/**
 * 初始化自动更新模块。仅在打包后的生产环境启用。
 * 开发环境下 autoUpdater 无法正常工作（无 publish 元数据），直接跳过。
 *
 * macOS 使用自定义更新流程（绕过 Squirrel.Mac 签名校验），
 * 其他平台使用 electron-updater 原生流程。
 */
export function initAutoUpdater() {
  if (initialized) return
  initialized = true

  // 开发环境不启用自动更新
  if (!app.isPackaged) {
    currentStatus = { state: 'not-available', currentVersion: 'dev' }
    return
  }

  if (IS_MAC) {
    // macOS: 自定义更新流程，不经过 Squirrel.Mac
    // （Squirrel.Mac 的 ShipIt 要求 Developer ID 签名，无证书时无法使用）
  } else {
    // Windows / Linux: 使用 electron-updater 原生流程
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    if (GITHUB_TOKEN) {
      autoUpdater.requestHeaders = { authorization: `token ${GITHUB_TOKEN}` }
    }

    autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }))
    autoUpdater.on('update-available', (info) => broadcast({ state: 'available', version: info.version }))
    autoUpdater.on('update-not-available', () =>
      broadcast({ state: 'not-available', currentVersion: autoUpdater.currentVersion })
    )
    autoUpdater.on('download-progress', (progress) => {
      const status = currentStatus
      const version = status.state === 'available' || status.state === 'downloading' ? status.version : 'unknown'
      broadcast({ state: 'downloading', version, progress: Math.round(progress.percent) })
    })
    autoUpdater.on('update-downloaded', (info) => broadcast({ state: 'downloaded', version: info.version }))
    autoUpdater.on('error', (error) => broadcast({ state: 'error', message: error.message ?? String(error) }))
  }

  // 启动后延迟 3 秒检查是否需要更新
  setTimeout(() => {
    const now = Date.now()
    const lastCheck = getLastCheckTime()
    const timeSinceLastCheck = now - lastCheck

    if (timeSinceLastCheck < UPDATE_CHECK_INTERVAL) {
      currentStatus = { state: 'not-available', currentVersion: app.getVersion() }
      return
    }

    setLastCheckTime(now)
    void checkForUpdates()
  }, 3000)
}

/** 手动触发检查更新。 */
export async function checkForUpdates(): Promise<void> {
  setLastCheckTime(Date.now())

  if (IS_MAC) {
    // macOS: 自定义检查流程
    try {
      broadcast({ state: 'checking' })
      const update = await macGetLatestVersion()
      if (update) {
        macPendingUpdate = update
        broadcast({ state: 'available', version: update.version })
      } else {
        broadcast({ state: 'not-available', currentVersion: app.getVersion() })
      }
    } catch (error) {
      broadcast({ state: 'error', message: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  // 其他平台: 原生 electron-updater
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
  if (IS_MAC) {
    // macOS: 自定义下载流程
    if (!macPendingUpdate) {
      broadcast({ state: 'error', message: 'No update available to download' })
      return
    }
    try {
      const version = macPendingUpdate.version
      broadcast({ state: 'downloading', version, progress: 0 })
      const zipPath = await macDownloadZip(macPendingUpdate, (percent) => {
        broadcast({ state: 'downloading', version, progress: percent })
      })
      // 保存 zip 路径供安装时使用
      ;(macPendingUpdate as MacPendingUpdate & { zipPath: string }).zipPath = zipPath
      broadcast({ state: 'downloaded', version })
    } catch (error) {
      broadcast({ state: 'error', message: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  // 其他平台: 原生 electron-updater
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    broadcast({ state: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

/** 安装已下载的更新并重启应用。 */
export function quitAndInstall(): void {
  if (IS_MAC) {
    // macOS: 自定义安装流程
    const update = macPendingUpdate as (MacPendingUpdate & { zipPath: string }) | null
    if (!update?.zipPath) {
      broadcast({ state: 'error', message: 'No downloaded update to install' })
      return
    }
    // 异步执行安装（会触发 app 退出）
    void macInstallUpdate(update.zipPath).catch((error) => {
      broadcast({ state: 'error', message: error instanceof Error ? error.message : String(error) })
    })
    return
  }

  // 其他平台: 原生 electron-updater
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
