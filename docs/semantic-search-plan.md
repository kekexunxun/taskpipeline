# 语义检索接入方案（sqlite-vec + embedding）

> 状态：待接入 · 本文档记录设计思路与改动清单，后续按此方案逐步实施。

## 1. 动机

当前检索全链路基于 FTS5 trigram 字面匹配（`tokenize='trigram'`），本质是"关键词在不在文本里"。以下场景会 miss：

| 用户查询          | 记忆内容                          | FTS5 结果 | 原因         |
| ----------------- | --------------------------------- | --------- | ------------ |
| 怎么让系统更快    | 性能优化：使用 Redis 缓存热点数据 | miss      | 零关键词重叠 |
| database security | 数据库安全防护策略                | miss      | 跨语言       |
| 部署流程          | CI/CD 流水线配置规范              | miss      | 同义不同词   |
| 如何处理并发错误  | 乐观锁冲突重试机制                | miss      | 抽象 vs 具体 |

语义检索（embedding + 向量近邻）可将检索从"词匹配"升级为"概念匹配"，覆盖同义词、跨语言、抽象-具体映射。

---

## 2. 架构概览

```
query
  │
  ├─→ fallbackKeywords() ──→ FTS5 trigram ──→ lexical hits ──┐
  │                                                             │
  ├─→ embedding(query) ────→ vec0 KNN ───────→ semantic hits ──┤
  │                                                             │
  │                                                RRF 融合 ←───┘
  │                                                     │
  │                                              ContextPack
  └─→ token 裁剪 → 注入 prompt
```

核心变化：在现有 RetrievalPipeline 中增加 **semantic 信号路**，与 lexical 信号做 RRF 融合。RRF 基础设施已就绪——`rrf.ts` 的 `RrfInput.signal` 类型已包含 `'semantic'`。

---

## 3. 关键决策点

### 3.1 Embedding Provider

| 方案                                | 维度 | 成本            | 延迟       | 离线            | 备注                                          |
| ----------------------------------- | ---- | --------------- | ---------- | --------------- | --------------------------------------------- |
| OpenAI `text-embedding-3-small`     | 1536 | $0.02/1M tokens | ~200ms/req | 否              | 质量最好，需联网                              |
| 本地 `all-MiniLM-L6-v2`             | 384  | 免费            | ~50ms/req  | 是              | 需 `@xenova/transformers`，首次下载模型 ~80MB |
| 用户自有 OpenAI-compatible endpoint | 可变 | 取决于 provider | 可变       | 取决于 provider | 不是所有 endpoint 都支持 embedding            |

**推荐（务实方案）：** OpenAI `text-embedding-3-small`。理由：

- 项目已有 OpenAI profile 管理（API key、base URL），可复用
- 1536 维质量好，中文支持佳
- 个人使用场景下成本极低（< 10K 条记忆，全量 embedding < $0.01）
- 后续可平滑切换到本地模型（接口不变）

### 3.2 向量检索：sqlite-vec vs 暴力 KNN

| 方案              | 性能     | 构建复杂度                           | 适用规模                      |
| ----------------- | -------- | ------------------------------------ | ----------------------------- |
| sqlite-vec（ANN） | O(log n) | 高（原生 C 扩展 + electron-rebuild） | > 100K 条                     |
| 纯 JS 暴力 KNN    | O(n)     | 低（零依赖）                         | < 10K 条（10K 条余弦 < 50ms） |

**推荐（务实方案）：** 纯 JS 暴力 KNN。理由：

- 个人记忆系统数据量 < 10K，暴力 KNN 性能够用
- 省去 sqlite-vec 原生编译（Electron + node-gyp + ABI 对齐是深坑）
- 实现简单，测试容易
- 后续数据量增长后可平滑切换到 sqlite-vec（Store 接口不变）

---

## 4. 改动清单

### 4.1 新增：Embedding 服务

**新建目录：** `packages/memory/src/embedding/`

```
embedding/
├── embedding-service.ts    # EmbeddingService 类：批量 embedding + 缓存
├── cosine-similarity.ts    # 余弦相似度计算（纯 JS）
└── types.ts                # EmbeddingProvider 接口定义
```

**`EmbeddingProvider` 接口：**

```typescript
export interface EmbeddingProvider {
  /** 单条文本 → 向量 */
  embed(text: string): Promise<number[]>
  /** 批量文本 → 向量矩阵 */
  embedBatch(texts: string[]): Promise<number[][]>
  /** 向量维度 */
  readonly dimensions: number
}
```

**`EmbeddingService` 职责：**

- 持有 `EmbeddingProvider` 实例
- 维护 embedding 缓存（LRU，key = SHA256(text).slice(0, 16)）
- 批量合并（写入时攒批，检索时同步调用）
- 失败降级（API 不可用时返回 null，检索路跳过 semantic 信号）

### 4.2 新增：向量存储

**新建文件：** `packages/memory/src/vector-store.ts`

```typescript
export class VectorStore {
  constructor(private readonly db: Database.Database) {}

  /** 写入/更新向量 */
  upsert(table: string, id: string, embedding: number[]): void

  /** 批量写入 */
  upsertBatch(table: string, entries: Array<{ id: string; embedding: number[] }>): void

  /** KNN 检索（暴力余弦距离） */
  searchKnn(table: string, queryEmbedding: number[], limit: number): Array<{ id: string; score: number }>

  /** 删除 */
  delete(table: string, id: string): void
}
```

**存储方案：** 不用 sqlite-vec，用普通表存向量（BLOB 或 JSON）：

```sql
CREATE TABLE IF NOT EXISTS vector_index (
  table_name TEXT NOT NULL,   -- 'memory_nodes' | 'knowledge_paragraphs'
  row_id TEXT NOT NULL,
  embedding BLOB NOT NULL,    -- Float32Array 序列化
  PRIMARY KEY (table_name, row_id)
);
```

暴力 KNN：全表扫描，计算余弦距离，取 top-K。10K 条 × 1536 维 ≈ 60MB 内存，余弦计算 < 50ms。

### 4.3 改动：Schema

**文件：** `packages/memory/src/schema.ts`

在 `ALL_DDL` 数组末尾追加：

```typescript
export const VECTOR_INDEX_DDL = `
  CREATE TABLE IF NOT EXISTS vector_index (
    table_name TEXT NOT NULL,
    row_id TEXT NOT NULL,
    embedding BLOB NOT NULL,
    PRIMARY KEY (table_name, row_id)
  );
`
```

### 4.4 改动：MemoryEngine 初始化

**文件：** `packages/memory/src/memory-engine.ts`

- 构造函数增加可选 `embeddingProvider?: EmbeddingProvider`
- 初始化 `VectorStore`
- 暴露 `vectorStore` 属性

```typescript
constructor(
  private readonly db: Database.Database,
  private readonly embeddingProvider?: EmbeddingProvider
) {
  // ...existing...
  this.vectorStore = new VectorStore(db)
}
```

### 4.5 改动：写入时生成 embedding

**文件：** `packages/memory/src/memory-node-store.ts`

在 `create()` 和 `update()` 方法末尾，异步生成 embedding：

```typescript
// create() 末尾
if (this.embeddingProvider) {
  const text = `${node.title}\n${node.summary ?? ''}`
  this.embeddingProvider
    .embed(text)
    .then((embedding) => {
      this.vectorStore.upsert('memory_nodes', node.id, embedding)
    })
    .catch(() => {
      /* 降级：跳过 */
    })
}
```

**文件：** `packages/memory/src/knowledge-store.ts`

在 `insertParagraphs()` 末尾，批量生成 embedding：

```typescript
if (this.embeddingProvider && paragraphs.length) {
  const texts = paragraphs.map((p) => p.content)
  this.embeddingProvider
    .embedBatch(texts)
    .then((embeddings) => {
      const entries = paragraphs.map((p, i) => ({ id: p.id, embedding: embeddings[i]! }))
      this.vectorStore.upsertBatch('knowledge_paragraphs', entries)
    })
    .catch(() => {
      /* 降级 */
    })
}
```

### 4.6 改动：RetrievalPipeline 增加 semantic 路

**文件：** `packages/memory/src/retrieval-pipeline.ts`

在 `execute()` 方法的 RRF 融合前，增加 semantic 检索：

```typescript
// ── 1.5 语义检索（可选，需要 embeddingProvider） ─────────────────
let semanticMemoryHits: RetrievalHit[] = []
let semanticKnowledgeHits: RetrievalHit[] = []
if (this.embeddingProvider) {
  const queryEmbedding = await this.embeddingProvider.embed(input.query)

  // 记忆层语义检索
  const vecMemResults = this.vectorStore.searchKnn('memory_nodes', queryEmbedding, limit)
  semanticMemoryHits = vecMemResults.map((r) => ({
    layer: 'paragraph' as const,
    content: '', // 需回查 MemoryNode
    score: r.score,
    sourcePath: null,
    documentId: null,
    nodeId: r.id,
    nodeType: null,
    nodeTitle: null,
    metadata: null
  }))

  // 知识层语义检索
  const vecKnowResults = this.vectorStore.searchKnn('knowledge_paragraphs', queryEmbedding, limit)
  semanticKnowledgeHits = vecKnowResults.map((r) => ({
    layer: 'paragraph' as const,
    content: '',
    score: r.score,
    sourcePath: null,
    documentId: r.id,
    nodeId: null,
    nodeType: null,
    nodeTitle: null,
    metadata: null
  }))
}

// ── 3. RRF 融合（lexical + semantic） ──────────────────────────
const memorySignals: RrfInput[] = [{ signal: 'lexical', hits: memoryHits }]
if (semanticMemoryHits.length) memorySignals.push({ signal: 'semantic', hits: semanticMemoryHits })
const fusedMemories = reciprocalRankFusion(memorySignals, 60, limit)
```

**注意：** `execute()` 需改为 `async`，因为 embedding 调用是异步的。上层 `MemoryEngine.retrieve()` 也需改为 async。

### 4.7 改动：反思晋升用 cosine 替代 Jaccard

**文件：** `packages/memory/src/reflection/promotion-strategies.ts`

```typescript
// 替换 computeTitleSimilarity
export async function computeTitleSimilarity(
  titleA: string,
  titleB: string,
  embeddingProvider?: EmbeddingProvider
): Promise<number> {
  if (!embeddingProvider) {
    // 降级：保持现有 Jaccard
    return jaccardSimilarity(titleA, titleB)
  }
  const [embA, embB] = await embeddingProvider.embedBatch([titleA, titleB])
  return cosineSimilarity(embA, embB)
}
```

### 4.8 改动：Electron 侧适配

**文件：** `apps/desktop/electron/memory/memory-service.ts`

- 构造函数接收 `EmbeddingProvider`（从配置中读取 provider 类型 + API key）
- 传递给 `new MemoryEngine(db, embeddingProvider)`

**文件：** `apps/desktop/src/.../SettingsDialog.tsx`

- 增加 embedding provider 配置区：
  - 开关：启用/禁用语义检索
  - Provider 选择：OpenAI / 本地模型 / 自定义
  - API Key 输入（OpenAI 时显示）

### 4.9 新增：OpenAI Embedding Provider

**新建文件：** `apps/desktop/electron/memory/openai-embedding.ts`

```typescript
import type { EmbeddingProvider } from '@task-pipeline/memory'

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 1536

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.openai.com/v1',
    private readonly model = 'text-embedding-3-small'
  ) {}

  async embed(text: string): Promise<number[]> {
    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: text })
    })
    const data = (await resp.json()) as { data: Array<{ embedding: number[] }> }
    return data.data[0]!.embedding
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts })
    })
    const data = (await resp.json()) as { data: Array<{ embedding: number[] }> }
    return data.data.map((d) => d.embedding)
  }
}
```

---

## 5. 接入顺序建议

按依赖关系和风险从低到高：

1. **EmbeddingProvider 接口 + OpenAI 实现**（纯新增，零风险）
2. **cosine-similarity.ts**（纯函数，单测覆盖）
3. **VectorStore + schema**（新增表，不影响现有表）
4. **写入时生成 embedding**（异步旁路，失败不影响主流程）
5. **RetrievalPipeline semantic 路**（RRF 已有 semantic 信号预留，接入即生效）
6. **反思晋升 cosine 替换**（可选，最后做）
7. **前端配置 UI**（最后做，等后端全通再暴露）

每一步都可独立验证、独立合入。任何一步失败都不影响现有 FTS5 检索（降级为纯 lexical）。

---

## 6. 降级策略

语义检索是**增强信号**，不是替代。全链路降级设计：

- `embeddingProvider` 未配置 → RetrievalPipeline 跳过 semantic 路，退化为纯 lexical
- embedding API 调用失败 → 写入时 catch 跳过，检索时返回空 semantic hits
- VectorStore 表为空 → KNN 返回空，RRF 退化为纯 lexical
- 前端配置未开启 → 不传 `embeddingProvider` 给 MemoryEngine

**核心原则：语义检索是锦上添花，永远不能成为检索链路的阻塞点。**

---

## 7. 成本估算

以个人使用场景为例（1000 条记忆 + 5000 个知识段落）：

| 操作                   | 次数    | Token 消耗  | 费用       |
| ---------------------- | ------- | ----------- | ---------- |
| 全量 embedding（首次） | 6000 条 | ~3M tokens  | ~$0.06     |
| 增量 embedding（日均） | ~10 条  | ~5K tokens  | ~$0.0001   |
| 检索 embedding（每次） | 1 条    | ~200 tokens | ~$0.000004 |

**年费用估算：** < $0.10（不含首次全量）

---

## 8. 后续演进

- **sqlite-vec 切换：** 当数据量 > 10K 时，VectorStore 内部切换为 sqlite-vec vec0 表，外部接口不变
- **本地模型：** EmbeddingProvider 接口不变，实现换为 `@xenova/transformers`
- **多模态 embedding：** 如果记忆包含图片/代码截图，可接入 CLIP 等多模态 embedding
- **HyDE（Hypothetical Document Embeddings）：** 先用 LLM 生成"假设性答案"，再用答案做 embedding 检索，提升抽象查询的召回率
