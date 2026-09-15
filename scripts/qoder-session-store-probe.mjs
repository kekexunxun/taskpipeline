/**
 * 会话 sweep 依赖的 SDK 语义探针（方案 §4.4 / V6）——只读真实数据，写入只发生在临时目录。
 *
 * 用法：
 *   node scripts/qoder-session-store-probe.mjs list       # 真实 ~/.qoder：listSessions() 是否跨项目聚合、cwd 是否填
 *   QODER_CONFIG_DIR=$TMP node scripts/qoder-session-store-probe.mjs synthetic   # dir→项目目录编码 + deleteSession
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const mode = process.argv[2] ?? 'list'
const { listSessions, deleteSession, getSessionInfo } = await import('@qoder-ai/qoder-agent-sdk')

if (mode === 'list') {
  const all = await listSessions({ limit: 500 })
  console.log('[list] 条数 =', all.length)
  console.log('[list] distinct cwd =', new Set(all.map((s) => s.cwd)).size)
  console.log('[list] cwd 缺失 =', all.filter((s) => !s.cwd).length)
  console.log(
    '[list] 样例 =',
    all.slice(0, 3).map((s) => ({
      id: s.sessionId.slice(0, 8),
      cwd: s.cwd,
      days: Math.round((Date.now() - s.lastModified) / 86_400_000)
    }))
  )
  // 注意：`Application Support` 与 `data` 之间还有一层应用名目录，正则漏掉就会永远报 0。
  console.log(
    '[list] 属于本应用 workspaces 的条数 =',
    all.filter((s) => /Application Support[/\\][^/\\]*[/\\]data[/\\]workspaces/.test(s.cwd ?? '')).length
  )
  // 反查「cwd → 项目目录名」的真实编码（sweep 要用 deleteSession(id,{dir}) 就必须知道这条映射）。
  const projects = join(process.env.HOME ?? '', '.qoder', 'projects')
  const buckets = readdirSync(projects)
  for (const s of all.slice(0, 3)) {
    const hit = s.sessionId && buckets.find((d) => existsSync(join(projects, d, `${s.sessionId}.jsonl`)))
    console.log('[list] 编码样本 cwd =', s.cwd, '→ 目录 =', hit)
  }
  process.exit(0)
}

// synthetic：必须在 import SDK 前就设好 QODER_CONFIG_DIR
const cfg = process.env.QODER_CONFIG_DIR
if (!cfg) {
  console.error('[synthetic] 需要 QODER_CONFIG_DIR 环境变量（指向临时目录）')
  process.exit(1)
}
const [, , , bucketName, fakeCwd] = process.argv
if (!bucketName || !fakeCwd) {
  console.error('[synthetic] 用法：probe.mjs synthetic <list 模式采到的目录名> <对应 cwd>')
  process.exit(1)
}
const ts = new Date().toISOString()
const line = (type, uuid, text) =>
  JSON.stringify({
    type,
    uuid,
    session_id: '0f0f0f0f-1e1e-4a2b-8c3d-0e0f0f0f0f0f',
    timestamp: ts,
    cwd: fakeCwd,
    message: { role: type === 'user' ? 'user' : 'assistant', content: [{ type: 'text', text }] }
  })
const projDir = join(cfg, 'projects')
const bucket = join(projDir, bucketName)
mkdirSync(bucket, { recursive: true })
const file = join(bucket, '0f0f0f0f-1e1e-4a2b-8c3d-0e0f0f0f0f0f.jsonl')
writeFileSync(file, [line('user', 'u1', '埋词 ALPHA'), line('assistant', 'a1', 'OK'), ''].join('\n'), 'utf8')

console.log('[synthetic] 写入', file)
console.log('[synthetic] listSessions({dir}) =', await listSessions({ dir: fakeCwd }))
console.log(
  '[synthetic] listSessions() 无 dir =',
  (await listSessions()).map((s) => ({ id: s.sessionId, cwd: s.cwd }))
)
try {
  await deleteSession('0f0f0f0f-1e1e-4a2b-8c3d-0e0f0f0f0f0f', { dir: fakeCwd })
  console.log(
    '[synthetic] deleteSession({dir}) 后文件仍存在 =',
    existsSync(file),
    '| bucket 内容 =',
    readdirSync(bucket)
  )
} catch (error) {
  console.log('[synthetic] deleteSession({dir}) 抛错 =', error.message)
}
console.log(
  '[synthetic] getSessionInfo =',
  await getSessionInfo('0f0f0f0f-1e1e-4a2b-8c3d-0e0f0f0f0f0f', { dir: fakeCwd }).catch((e) => `ERR ${e.message}`)
)
try {
  await deleteSession('0f0f0f0f-1e1e-4a2b-8c3d-0e0f0f0f0f0f')
  console.log('[synthetic] 无 dir 的 deleteSession 未抛错；文件存在 =', existsSync(file))
} catch (error) {
  console.log('[synthetic] 无 dir 的 deleteSession 抛错 =', error.message)
}
console.log(
  '[synthetic] 最终 =',
  existsSync(file) ? `文件仍在（mtime ${statSync(file).mtime.toISOString()}）` : '文件已删'
)
