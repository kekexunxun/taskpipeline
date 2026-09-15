// 一次性验证脚本：Pi 的 fork / 按叶子截断原语是否真能承担「阶段边界 = 会话边界」。
// 跑法：node scripts/pi-fork-probe.mjs （不需要模型凭据，纯文件层）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'

const cwd = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'pi-fork-probe-'))
const sessionDir = join(dir, 'sessions')

function user(text) {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }
}
function assistant(text) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'x',
    provider: 'p',
    model: 'm',
    usage: undefined,
    stopReason: 'stop',
    timestamp: Date.now()
  }
}

const sm = SessionManager.create(cwd, sessionDir)
const ids = []
ids.push(sm.appendMessage(user('GLYPH-7734 第一轮提问')))
ids.push(sm.appendMessage(assistant('ZEPHYR-2210 第一轮回答')))
ids.push(sm.appendMessage(user('第二轮提问')))
ids.push(sm.appendMessage(assistant('第二轮回答')))
const parentFile = sm.getSessionFile()
const parentEntries = sm.getEntries()
console.log('parent file', parentFile)
console.log('parent entries', parentEntries.length, 'ids', parentEntries.map((e) => e.id).join(','))
console.log('anchor(第一轮回答) =', parentEntries[2]?.id)

// A) forkFrom：整段继承
const forked = SessionManager.forkFrom(parentFile, cwd, sessionDir)
const forkEntries = forked.getEntries()
console.log(
  'A forkFrom entries',
  forkEntries.length,
  'same ids?',
  forkEntries.map((e) => e.id).join(',') === parentEntries.map((e) => e.id).join(',')
)
console.log(
  'A fork file != parent?',
  forked.getSessionFile() !== parentFile,
  'header.parentSession',
  forked.getHeader()?.parentSession
)
forked.appendMessage(user('Exec 阶段指令'))
const ctx = forked.buildSessionContext()
console.log(
  'A fork context messages',
  ctx.messages.length,
  'sees GLYPH?',
  JSON.stringify(ctx.messages).includes('GLYPH-7734')
)

// B) createBranchedSession(leafId)：按叶子截断
const branchPath = sm.createBranchedSession(parentEntries[1].id)
console.log('B branch path', branchPath)
const branched = SessionManager.open(branchPath, sessionDir, cwd)
const bEntries = branched.getEntries()
const bText = JSON.stringify(branched.buildSessionContext().messages)
console.log(
  'B entries',
  bEntries.length,
  'sees GLYPH?',
  bText.includes('GLYPH-7734'),
  'sees 第二轮?',
  bText.includes('第二轮')
)

// C) 同一父会话分多支（fork 不互斥）
const fork2 = SessionManager.forkFrom(parentFile, cwd, sessionDir)
console.log('C second fork ok', fork2.getEntries().length, fork2.getSessionFile() !== forked.getSessionFile())

rmSync(dir, { recursive: true, force: true })
