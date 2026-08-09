/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * FTS5 trigram 检索效果探查脚本（一次性），用于确认 search-by-keyword 改造方案。
 * 用 ELECTRON_RUN_AS_NODE=1 跑 Electron 自身作为 Node runtime，避免 better-sqlite3 ABI 错位。
 * 不进 prepackage / package 流程。
 */
const Database = require('better-sqlite3')
const db = new Database(':memory:')
db.exec(`
  CREATE TABLE memories (id TEXT PRIMARY KEY, title TEXT, content TEXT, pinned INTEGER NOT NULL DEFAULT 0);
  CREATE VIRTUAL TABLE memories_fts USING fts5(title, content, content='memories', content_rowid='rowid', tokenize='trigram');
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
  END;
`)
const ins = db.prepare('INSERT INTO memories (id, title, content, pinned) VALUES (?, ?, ?, ?)')
ins.run('1', '优惠券并发幂等保护', '结算页多线程同时核销时，需要保证业务幂等键唯一性。', 0)
ins.run('2', '事件重试策略', 'iOS 升级事件失败时，使用指数退避重试。', 0)
ins.run('3', 'MySQL 死锁排查', '高并发下 InnoDB 行锁等待导致事务回滚。', 0)
const SQL = `SELECT m.title, CAST(-bm25(memories_fts) * 100 AS INTEGER) AS score
             FROM memories_fts JOIN memories AS m ON m.rowid = memories_fts.rowid
             WHERE memories_fts MATCH ? ORDER BY m.pinned DESC, score DESC`
const probe = (q) => {
  try {
    const r = db.prepare(SQL).all(q)
    return r.map((x) => `${x.title}(${x.score})`).join(', ') || '(空)'
  } catch (e) {
    return `错误 - ${e.message}`
  }
}
for (const q of ['结算', '结算*', '结算页*', '事件*', '优惠券*', 'iOS*', 'MySQL', '业务幂等*', '事务回滚*'])
  console.log(`"${q}":`, probe(q))
for (const q of ['结算页* OR 事件*', '结算页* OR 重试*', '业务幂等* OR 死锁*']) console.log(`"${q}":`, probe(q))
