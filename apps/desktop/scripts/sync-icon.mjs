// 以 build/icon.png 为唯一图标源：
// - macOS 上经 normalize-icon.swift 归一化（铺满画布的成品图标自动按 824/1024 网格加留白），
//   输出 build/icon.normalized.png（electron-builder 图标源，见 package.json build.icon）
// - 其他平台无 swift 环境，直接拷贝原图（Windows/Linux 无 Dock 网格约定，铺满即可）
// - public/icon.png（favicon）始终取归一化后的副本
// 生成物均见 .gitignore，替换 build/icon.png 后下次 dev/build/package 自动同步。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(appRoot, 'build/icon.png')
const normalized = join(appRoot, 'build/icon.normalized.png')
const favicon = join(appRoot, 'public/icon.png')

if (!existsSync(source)) {
  throw new Error(`[sync-icon] 缺少图标源文件: ${source}`)
}
mkdirSync(join(appRoot, 'public'), { recursive: true })

if (platform() === 'darwin') {
  execFileSync('swift', [join(appRoot, 'scripts/normalize-icon.swift'), source, normalized], { stdio: 'inherit' })
} else {
  copyFileSync(source, normalized)
}
copyFileSync(normalized, favicon)
console.log('[sync-icon] build/icon.png -> build/icon.normalized.png + public/icon.png')
