/**
 * 重新编译 @optave/codegraph 嵌套的 better-sqlite3 native 模块。
 *
 * codegraph 通过 npx 子进程运行（系统 Node.js），其嵌套的 better-sqlite3
 * 需要匹配当前 Node.js 的 ABI。npm install 时的 prebuild 可能针对更高版本，
 * 此脚本确保每次 dev 启动前重新编译。
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const nestedDir = join(root, 'node_modules/@optave/codegraph/node_modules/better-sqlite3')

if (!existsSync(nestedDir)) {
  console.log('[rebuild-codegraph-sqlite] nested better-sqlite3 not found, skipping')
  process.exit(0)
}

try {
  execSync('npm rebuild better-sqlite3', {
    cwd: nestedDir,
    stdio: 'inherit'
  })
  console.log('[rebuild-codegraph-sqlite] rebuilt better-sqlite3 for @optave/codegraph')
} catch (error) {
  console.warn('[rebuild-codegraph-sqlite] rebuild failed:', error.message)
  console.warn('  codegraph will fall back to WASM engine at runtime')
}
