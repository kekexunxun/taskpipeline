// macOS 打包后若 /Applications 存在旧版 TaskPipeline.app，自动同步新产物，
// 让 Finder/Launchpad/Dock 显示的系统图标跟随 build/icon.png 更新；非 mac 平台或 CI（未安装）静默跳过。
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { arch, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (platform() !== 'darwin') process.exit(0)

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const releaseRoot = join(appRoot, '../../release')
const source = [
  join(releaseRoot, `mac-${arch()}`, 'TaskPipeline.app'),
  join(releaseRoot, 'mac', 'TaskPipeline.app')
].find(existsSync)
const target = '/Applications/TaskPipeline.app'

if (!source || !existsSync(target)) process.exit(0)

try {
  execSync('pgrep -x TaskPipeline', { stdio: 'ignore' })
  console.warn('[sync-local-install] TaskPipeline 正在运行，跳过 /Applications 同步，退出应用后重新打包即可同步。')
  process.exit(0)
} catch {
  // 未在运行，继续同步
}

execSync(`ditto "${source}" "${target}"`)
execSync(`touch "${target}"`)
try {
  // 强制 LaunchServices 重新注册 bundle，刷新系统图标缓存
  execSync(
    `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "${target}"`,
    { stdio: 'ignore' }
  )
} catch {
  // lsregister 失败不影响同步结果
}
console.log(`[sync-local-install] ${source} -> ${target}`)
