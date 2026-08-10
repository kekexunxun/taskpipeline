// dev 环境 Dock 悬停名取自 node_modules/electron/dist/Electron.app 的 bundle 名（默认 "Electron"），
// 这里改写为产品名保持与打包版一致。仅 macOS 生效；重装依赖会还原，predev 每次自动重打补丁。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (platform() !== 'darwin') process.exit(0)

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(appRoot, 'package.json'))
let electronPkg
try {
  electronPkg = require.resolve('electron/package.json')
} catch {
  process.exit(0)
}
const appPath = join(dirname(electronPkg), 'dist/Electron.app')
const plist = join(appPath, 'Contents/Info.plist')
if (!existsSync(plist)) process.exit(0)

const name = 'TaskPipeline'
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${name}`, plist], { stdio: 'ignore' })
  } catch {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${name}`, plist], { stdio: 'ignore' })
    } catch {
      // 键写入失败不影响 dev 启动
    }
  }
}
try {
  execFileSync(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', appPath],
    { stdio: 'ignore' }
  )
} catch {
  // lsregister 失败不影响补丁结果
}
console.log('[patch-dev-app-name] Electron.app bundle name ->', name)
