# 从 JSON 迁移到 JSONL：一份基于 WorkBuddy 实际实现的落盘设计参考

> 本文分两部分：
> **上半部分**是从 WorkBuddy 桌面端 `app.asar` 反解出的真实追加写入实现（含代码级细节与实测数据）；
> **下半部分**是给「自己的项目要从 JSON 改成 JSONL」的改造清单、参考实现与坑位。
>
> 标注约定：`[实证]` = 在代码或落盘文件里直接确认；`[推断]` = 基于结构合理推断，未逐行验证。

---

## 0. 结论先行

WorkBuddy 的会话存储**不是"简单 appendFile"**，而是四件事叠在一起：

| 层次   | 机制                                                         | 解决的问题                       |
| ------ | ------------------------------------------------------------ | -------------------------------- |
| 内核层 | `O_APPEND`（`open(path,"a")`）                               | 多写者/多次 `write` 的偏移原子性 |
| 进程层 | per-path Promise 写锁（+ AsyncLocalStorage 防自锁）          | 同进程并发写同一文件时的交错     |
| 批次层 | 写前记 `originalSize`，失败 `truncate` / 本批新建则 `unlink` | "整批可见或整批不可见"           |
| 崩溃层 | 读取端 `try/JSON.parse/catch` 静默跳过坏行                   | 无 fsync 场景下的残行容忍        |

再加一层**正交的逻辑一致性**：entry `id` 去重（重放/重试直接丢弃）、`parentId == lane tip` 校验、懒加载已见 id 集合。

一句话概括它的设计取向：

> **把追加写入当成"只能在末尾追加、但必须保持整行 / 整批原子"的问题来处理**——内核管偏移，进程管互斥，批次管回滚，读取端管崩溃残留。

---

## 1. 为什么值得从 JSON 改成 JSONL

单文件 JSON 的痛点，改 JSONL 后基本都能解掉：

| 维度     | 单 JSON 文档                         | JSONL                                     |
| -------- | ------------------------------------ | ----------------------------------------- |
| 写成本   | 改一条要重写整个文件（O(n)）         | 追加一行（O(1)），与历史长度无关          |
| 崩溃窗口 | 重写期间崩溃 → 整个文件可能损坏/截断 | 最坏丢最后一行，前面全好                  |
| 内存     | 读取必须全量 parse                   | 可流式逐行处理，可只读最后 N 行           |
| 并发     | 需要读-改-写，必须加锁且锁粒度大     | 追加天然串行，锁粒度仅覆盖追加            |
| 增量消费 | 必须整体对比                         | 记住 offset 就能 tail -f 式增量读         |
| 工具友好 | 需专门解析                           | `wc -l` / `tail` / `grep` / `rg` 直接可用 |
| 部分损坏 | 可能整体不可读                       | 坏行可跳过，其余可用                      |

反过来，JSONL 不适合的场景见 §7。

---

## 2. 追加写入链路（WorkBuddy 实证）

以下代码取自 `app.asar.unpacked/cli/dist/codebuddy-headless.js` 的 `SessionStore` / `LocalJsonlSessionStore`。`[实证]`

### 2.1 打开方式：先 `"ax"` 独占建，`EEXIST` 才退回 `"a"`

```js
try {
  handle = await fs.open(path, 'ax') // 原子创建，顺手拿到"是不是本批建的"这个事实
  created = true
} catch (e) {
  if (e.code !== 'EEXIST') throw e
  handle = await fs.open(path, 'a') // O_APPEND，正常运行路径
}
```

`"ax"` 这一下同时干了两件事：文件不存在则原子创建；**并记录"createdByCurrentBatch"这个布尔**——回滚时要用（见 2.4）。

`"a"` 即 `O_APPEND`，由内核保证每次 `write()` 的定位原子，多进程同时追加也不会互相覆盖偏移。

### 2.2 写整行：不假设一次 write 能写完

```js
writeJsonlChunk(h, buf, off) {
  return h.write(buf, off, buf.length - off, null);
}

async writeJsonlLine(h, line) {
  const buf = Buffer.from(line, "utf8");
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await this.writeJsonlChunk(h, buf, off);
    if (bytesWritten <= 0) throw Error("Failed to make progress while writing JSONL line");
    off += bytesWritten;
  }
  return off;
}
```

一行一个 `Buffer`，`offset` 循环推进直到写足；`bytesWritten <= 0` 直接抛错。
**关键点：不允许一行被拆成"半行"落地。** 这正是它能做到"不写坏行"的基础。

### 2.3 串行化：per-path Promise 链 + AsyncLocalStorage 防自锁

```js
async withFileWriteLock(path, fn) {
  const held = this.heldFileLocks.getStore();
  if (held?.has(path)) return fn();                  // 同一异步上下文重入 → 直接放行，不死锁

  const prev = this.writeLocks.get(path) ?? Promise.resolve();
  let release;
  const cur = new Promise(r => (release = r));
  this.writeLocks.set(path, prev.then(() => cur));
  await prev;
  try {
    return await this.heldFileLocks.run(new Set([...(held ?? []), path]), fn);
  } finally {
    release();
    /* 清理 map 项 */
  }
}
```

不是朴素的 `mutex.acquire()`：

- **同一异步调用链嵌套进同一把锁不会死锁**（`heldFileLocks` 记录当前上下文已持路径，命中直接执行）。会话 transcript 写入和 entriesStore 写入走的是同一个文件、同一把锁，这个细节是必需的。
- 锁粒度是 **per-path**，不同会话文件互不阻塞。

### 2.4 批次回滚：整批可见 / 整批不可见

写之前先记住 `originalSize`，失败时：

```js
if (err) {
  const rollback = created ? 'unlink' : 'truncate'
  created ? await fs.unlink(path) : await fs.truncate(path, originalSize)
  // 回滚本身也失败 → AggregateError([writeErr, rollbackErr], "Failed to append history and roll back partial batch")
  throw err
}
```

- 本批**新建**的文件 → 直接删掉（整批不该存在）。
- 已存在的文件 → `truncate` 切回写前长度。

回滚有审计埋点 `session_transcript.append_rollback`，记录 `originalSize` / `bytesWritten` / `createdByCurrentBatch`。

> **这一条是 JSONL 相比 JSON 最大的体验提升**：失败时不会留下"写了一半的多行状态"。

---

## 3. 逻辑一致性层（与文件系统层正交）

文件层保证"字节不撕裂"，逻辑层保证"追加进去的东西在会话树里说得通"。`[实证]`

### 3.1 懒加载 + id 去重 + tip 校验

```js
async ensureKeyState(key) {
  const entries = await this.readLines(key) ?? [];
  const seen = new Set();
  for (const e of entries) if (typeof e.id === "string") seen.add(e.id);
  this.uuids.set(key, seen);
  this.tips.set(key, resolveTip(entries));   // tip = 分支末端，用于链校验
}
```

追加时：

- `id` 已在集合里 → **整条直接丢弃**（`absorbRedeliveries`，对应重试 / 重放场景）。
- 新条目校验 `parentId` 必须等于当前 lane tip，否则抛 `invalid_entry`。
- 若一批全是重复项 → `lines.length === 0` → **连 `open` 都不做，直接 return**，零 IO。

### 3.2 `session-meta` 用"追加式更新"

元数据变更时不改旧行，而是**每次追加一条新的 `session-meta`**，读取时只认最后一条。这是"追加写入"哲学贯彻到底的体现，也顺带白送了一份元数据变更历史。

**这一点非常值得抄**：它把"更新"降维成了"追加"，从而整个文件只剩一种写操作。

---

## 4. 落盘粒度与中断语义

这是"突然关闭会不会丢数据"的核心。`[实证]`

### 4.1 粒度是"每个已完成的步骤"，不是"每个 token"

```js
// 流式文本增量 —— 只改内存草稿，不碰磁盘
ingestModelStreamEvent(ev) {
  if (ev.type === "output_text_delta") this.appendAssistantText(ev.delta);
  ...
}

// 每个"真正完成的 item" —— 立刻 await 落盘，然后清掉对应草稿
await this.addHistory(session, [item]);
draftStore.markCommitted(rawItem);
```

`addHistory` 是 **await 到底**的：`await this.sessionStore.appendHistory(...)` 之后才打 `[addHistory] APPEND_SUCCESS`，并且每 session 还有一把 `addHistoryLocks` 串行链。**不存在"先返回、后异步写"的窗口。**

### 4.2 本机实测三条证据

1. **磁盘上从不出现中间态。** 扫本机全部会话文件，`status` 取值只有 `completed`(5722) / `incomplete`(27) / `null`(9375，工具调用类本无 status)；`in_progress` 一次都没落过盘。
2. **相邻记录 60.7% 的时间差 ≤50ms**（4409 条记录的大会话统计），说明是"一个步骤内几条记录成批写"，符合 `await addHistory([...])` 的批量语义；其余 22.5%+14.5% 是等工具、等模型的间隔。
3. **中断半截内容不会被当正文存下。** 代码里有 `flushAbortedItems()` 抢救路径（转 `status:"incomplete"` + `providerData.isPartialAborted:true`），但实测 `isPartialAborted` 出现 **0 次**；实际留下的是 `INTERRUPTED_BY_USER_MESSAGE`（文本 "Interrupted by user"），带 `providerData.skipRun:true`，读取端把它当分隔符而非有效回答重放。

### 4.3 中断结果对照表

| 关闭方式                       | 结果                                               |
| ------------------------------ | -------------------------------------------------- |
| 点停止 / 关窗口（走取消流程）  | **不丢**，中断点留一条占位记录                     |
| 整个 App 崩溃 / 强杀 / 断电    | **丢"正在流式输出的那一段"**，此前已完成的全部保留 |
| 极端情况（硬杀 + 无 fsync）    | 连最后已 `close` 的几条也可能丢                    |
| Kill -9 中途（追加批次未完成） | 走 `truncate`/`unlink` 回滚，**不会留半行脏数据**  |

> 补充：这套是 daemon + sidecar 架构（`daemon-bootstrap.js` / `sidecar-entry.js` / `cli-prewarm-pool.js`），sidecar 里有 `process.ppid` 看门狗，只在父进程真的消失后才自退。所以**单纯关窗口通常不中断生成**。

### 4.4 fsync 的取舍

- **普通追加不做 fsync**：只 `await handle.close()`，数据进 page cache 就返回（性能优先）。全仓唯一的 `handle.sync()` 在 fork 历史初始化路径：**写临时文件 → `sync()` → `rename()` 原子替换**（正确性优先）。
- 对应的兜底在读取端：`deserializeSessionFromPath` 里 `try { JSON.parse(...) } catch {}` 空捕获，坏行静默跳过；`eachLine` 是 64KB 分块流式读，`historyLimit` 默认 1000 条（可用 `CODEBUDDY_SESSION_MAX_ITEMS` 调）。

**分层建议（可直接照抄）**：

- 高频追加路径 → 不 fsync，靠回滚 + 残行容忍兜底。
- 重写 / 压缩 / 迁移路径 → 必须 `tmp → fsync → rename`。

---

## 5. 落盘布局（本机实际）

```
~/.workbuddy/projects/Users-robin-WorkBuddy-2026-09-22-19-30-13/
├── bcb62e7f-....jsonl               # 109 行，569KB，行尾以 LF 结尾
├── bcb62e7f-....file-rollback.ndjson
└── bcb62e7f-.../tool-results/       # 超大 tool 输出外置
```

记录类型：`session-meta` / `message` / `reasoning` / `function_call` / `function_call_result` / `file-history-snapshot` / `ai-title`。

**大字段外置**是一个值得注意的模式：超过阈值的 tool 输出不写进主 JSONL，而是单独落文件、主行只存引用——保证单行不会无限膨胀。

---

## 6. 从 JSON 迁移到 JSONL：改造清单

### 6.1 第一步：定清楚用哪种模式

| 模式             | 写法                          | 读法                           | 适合                           |
| ---------------- | ----------------------------- | ------------------------------ | ------------------------------ |
| **全量快照行**   | 每次 append 完整 JSON         | 只读最后一行                   | 配置、小状态、写不频繁         |
| **增量事件行**   | 每次 append delta / 事件      | 从头回放                       | 对话、日志、审计、事件溯源     |
| **混合（推荐）** | 事件行 + 周期性 checkpoint 行 | 最后一个 checkpoint + 后续事件 | 长历史（否则回放成本线性增长） |

WorkBuddy 用的就是**混合**：`session-meta` 是全量快照行（取最后一条），message/reasoning/function_call 是增量事件行。

### 6.2 行 schema 设计要点

每行至少带这几样，后期会感谢自己：

```jsonc
{
  "v": 1, // schema 版本，未来演进用
  "t": "message", // 行类型（判别联合的 discriminant）
  "id": "01J...", // 全局唯一，用于去重 / 幂等重放
  "parentId": "01H...", // 因果链（可选，但事件溯源场景强烈建议）
  "ts": 1758531861203, // 单调递增时间戳（毫秒）
  "seq": 128, // 可选：显式序号，便于检测缺口
  "d": {} // 业务负载
}
```

**硬性约束：**

- 一行就是一个完整 JSON，**行内不含裸 `\n`**（`JSON.stringify` 会正确转义，别手拼字符串）。
- **每行必须以 `\n` 结尾**，包括最后一行。这样追加无需关心"上一行有没有换行"。
- 不要 `JSON.stringify` 二进制（`Buffer` 会变成 `{"type":"Buffer","data":[...]}` 巨肥）——大字段外置成单独文件。

### 6.3 写路径：替换掉"读-改-写"

参考实现（Node.js，可直接改）：

```js
// jsonl-store.js
import { open, unlink, truncate } from 'node:fs/promises'

export class JsonlStore {
  #locks = new Map() // path -> Promise（链尾）

  async withLock(path, fn) {
    const prev = this.#locks.get(path) ?? Promise.resolve()
    let release
    const cur = new Promise((r) => (release = r))
    this.#locks.set(
      path,
      prev.then(() => cur)
    )
    await prev
    try {
      return await fn()
    } finally {
      release()
      if (this.#locks.get(path) === cur) this.#locks.delete(path) // 防止 Map 无限增长
    }
  }

  /** 整批可见或整批不可见 */
  async appendBatch(path, records) {
    if (records.length === 0) return 0 // 零 IO 短路（重要）
    const lines = records.map((r) => JSON.stringify(r) + '\n')

    return this.withLock(path, async () => {
      let handle
      let created = false
      try {
        handle = await open(path, 'ax') // 原子创建
        created = true
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
        handle = await open(path, 'a') // O_APPEND
      }

      const originalSize = created ? 0 : (await handle.stat()).size
      let written = 0

      try {
        for (const line of lines) {
          const buf = Buffer.from(line, 'utf8')
          let off = 0
          while (off < buf.length) {
            const { bytesWritten } = await handle.write(buf, off, buf.length - off, null)
            if (bytesWritten <= 0) throw new Error('no progress writing jsonl line')
            off += bytesWritten
            written += bytesWritten
          }
        }
        await handle.close()
        return written
      } catch (err) {
        await handle.close().catch(() => {})
        try {
          if (created) await unlink(path)
          else await truncate(path, originalSize)
        } catch (rollbackErr) {
          throw new AggregateError([err, rollbackErr], 'append and rollback both failed')
        }
        throw err
      }
    })
  }

  /** 重写 / 压缩 / 迁移：必须 fsync + rename */
  async rewriteAtomic(path, records) {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    const handle = await open(tmp, 'wx')
    try {
      for (const r of records) {
        await handle.write(JSON.stringify(r) + '\n')
      }
      await handle.sync() // 关键：把 tmp 刷到盘
      await handle.close()
      await rename(tmp, path) // 原子替换
    } catch (e) {
      await handle.close().catch(() => {})
      await unlink(tmp).catch(() => {})
      throw e
    }
  }
}
```

**要点回顾**（每一条都对应一个真实故障）：

1. `records.length === 0` 提前返回 —— 避免无意义的 open/close。
2. `"ax"` → `"a"` 两步 —— 同时拿到 `created` 标志。
3. `while (off < buf.length)` —— 别假设一次写足。
4. `originalSize` 在写之前取 —— 回滚基准。
5. 回滚失败要用 `AggregateError` 上报 —— 否则真正的错误被掩盖。
6. `#locks` 记得清理 —— 否则长跑进程内存泄漏。

### 6.4 读路径：必须容错

**这是最容易漏的一步。** 如果读取端遇到残行就抛，一次断电会让整个文件永久打不开。

```js
import { createReadStream } from 'node:fs'

export async function* readJsonl(path, { onBadLine } = {}) {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 })
  let buf = ''

  for await (const chunk of stream) {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        yield JSON.parse(line)
      } catch {
        onBadLine?.(line) // 静默跳过，或上报埋点
      }
    }
  }
  if (buf.trim()) {
    // 无尾换行的残尾
    try {
      yield JSON.parse(buf)
    } catch {
      onBadLine?.(buf)
    }
  }
}

// 回放（事件溯源）
export async function replay(path) {
  const state = { seen: new Set(), items: [] }
  for await (const r of readJsonl(path)) {
    if (r.id && state.seen.has(r.id)) continue // 幂等：重复 id 直接丢
    if (r.id) state.seen.add(r.id)
    state.items.push(r)
  }
  return state
}

// 只需要"最新快照"时，从后往前读最后一行即可（配合 readline 反向或分块反向扫）
```

### 6.5 迁移执行步骤（兼容旧格式）

1. **落 schema 与版本字段**（`v`）。旧数据没有 `v` 就按 `v:0` 处理。
2. **写路径切换**：把"读全量 → 改 → 整体写回"换成 `appendBatch`。
3. **读路径双通道**：先判断文件形态 —— 首行能 parse 且不含换行分隔的多个 JSON → 旧格式；否则走 JSONL 回放。更稳妥的做法是**看扩展名 / 看首字节是不是 `{` 后紧跟 `\n`**，或干脆用一个显式的 `format` 标记字段。
4. **懒迁移**：首次写入旧文件时，读旧 JSON → 转成 JSONL 若干行 → `rewriteAtomic` 一次性替换（`tmp → fsync → rename`）。之后追加只走 `appendBatch`。
5. **保留一条回退路径**：迁移期同时能读两种格式，跑一段时间再删旧代码。
6. **加埋点**：`append_rollback` / `bad_line_skipped` / `batch_size` 三类事件，出问题时有据可查。

### 6.6 如果你还想要"逻辑一致性"

从 JSON 单文档切成事件流后，常见的新问题是"重复写"和"乱序"。抄 WorkBuddy 两招：

- **幂等**：每行带唯一 `id`，读取回放时用 `Set` 去重 —— 重试、重放、并发重复提交都能自愈。
- **因果链**：每行带 `parentId` 指向上一行 `id`，回放时校验链完整性 —— 能立刻发现缺口或错序（代价是每行多一个字段 + 需要维护 tip）。

如果只想要简单，这两个都可以先不加；但**幂等用的 `id` 字段建议一开始就留上**，事后补字段比事后加去重逻辑容易得多。

---

## 7. 什么时候"不要"用 JSONL

不要无脑迁移，下面这些场景 JSONL 反而更差：

- **需要原地更新单条记录**（如"把第 3 条的 status 改成 done"）。JSONL 只能追加，改要写新行——除非你接受"只认最后一条同 id 的行"这种追加式更新语义。
- **需要跨行事务**。JSONL 的原子性单位是"一批追加"，不是"跨多行业务约束"。真要强约束，上 SQLite。
- **文件会被多进程并发写**。WorkBuddy 能只用进程内锁，是因为它**单写者假设**：每个会话一个文件、写入交给 CLI sidecar，桌面主进程基本只读（全文搜索直接 ripgrep 扫 JSONL 行）。如果你的架构是多进程写同一文件，要么上文件锁（`flock`），要么改用数据库。
- **数据量会小到无所谓**。几 KB 的配置文件，JSON 更好编辑、更好被人手改。
- **需要频繁读取"某一条"**。JSONL 按行是 O(n) 定位。行数上万后，考虑加索引文件或换 SQLite。

### 附带代价：文件只会变大

追加写入意味着**没有回收**。必须提前想好：

- 轮转（按大小或日期切段，参考 audit-log 的 `maxSegmentBytes` + 按日期分段）；
- 压缩（把 N 条事件折叠成一个 checkpoint 行，用 `rewriteAtomic` 替换）；
- 归档（老段 gzip 掉，保留最近 N 段）。

---

## 8. 一页速查

**写**

```
"ax" 建 → EEXIST 落 "a"        // 顺便拿 created 标志
while (off < len) write(...)   // 不许半行
per-path Promise 链            // 同批次串行
记 originalSize → 失败 truncate/unlink
```

**读**

```
64KB 分块流式 → 逐行 JSON.parse → catch 静默跳过
Set 去重（幂等）→ parentId 校验（因果）
```

**分层原则**
| 场景 | 做法 |
|---|---|
| 高频追加 | 不 fsync，靠回滚 + 残行容忍 |
| 重写 / 压缩 / 迁移 | `tmp → fsync → rename` |
| 元数据变更 | 追加新行，读最后一条（别改旧行） |
| 大字段 | 外置成单独文件，主行存引用 |
| 超长历史 | 事件行 + 周期性 checkpoint 行 |

---

_文档生成于 2026-09-22。上半部分的机制与数据来自 WorkBuddy v-app.asar 反解与实际落盘文件实测；下半部分的参考实现为同构改写，非逐行等同原实现。_
