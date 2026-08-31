/**
 * Legacy Bridge：将旧 MemoryStore 的数据迁移到新 MemoryEngine。
 *
 * 映射关系：
 * - Memory → MemoryNode（nodeType 按 tags 推断）
 * - scope / userId / repositoryId / conversationId 直接映射
 * - importance → importance
 * - content → summary
 * - tags → tags
 * - pinned=true → status='active'，否则 → status='candidate'
 * - source 映射：manual→manual, auto→auto, seed→seed
 *
 * 迁移是幂等的：按旧 ID 写入 metadata.legacyId，重复迁移会跳过已存在的节点。
 */
import type { MemoryNodeStore } from '../memory-node-store.js'
import type { KnowledgeStore } from '../knowledge-store.js'
import type { MemoryNodeType, MemoryScope } from '../types.js'

/** 旧 Memory 类型（从 @task-pipeline/core 的 Memory 复制） */
export interface LegacyMemory {
  id: string
  scope: MemoryScope
  userId?: string
  repositoryId?: string
  conversationId?: string
  title: string
  content: string
  tags: string[]
  pinned: boolean
  importance: number
  source: 'manual' | 'auto' | 'seed'
  createdAt: string
  updatedAt: string
}

/** 旧 RepoWikiDoc 类型 */
export interface LegacyWikiDoc {
  id: string
  repositoryId: string
  path: string
  title: string
  content: string
  hash: string
  updatedAt: string
}

/** 从旧 Memory 的 tags 推断 nodeType */
function inferNodeType(tags: string[]): MemoryNodeType {
  const lowerTags = tags.map((t) => t.toLowerCase())
  if (lowerTags.some((t) => t.includes('constraint') || t.includes('rule') || t.includes('must'))) return 'constraint'
  if (lowerTags.some((t) => t.includes('arch') || t.includes('design') || t.includes('pattern'))) return 'architecture'
  if (lowerTags.some((t) => t.includes('decision') || t.includes('decided') || t.includes('chosen'))) return 'decision'
  if (lowerTags.some((t) => t.includes('incident') || t.includes('bug') || t.includes('error'))) return 'incident'
  if (lowerTags.some((t) => t.includes('procedure') || t.includes('step') || t.includes('how'))) return 'procedure'
  if (lowerTags.some((t) => t.includes('module') || t.includes('component'))) return 'module'
  if (lowerTags.some((t) => t.includes('security') || t.includes('auth'))) return 'security_rule'
  return 'procedure' // 默认
}

export interface MigrationResult {
  migrated: number
  skipped: number
  errors: Array<{ id: string; error: string }>
}

/**
 * 将旧 MemoryStore 的 memories 迁移到新 MemoryNodeStore。
 *
 * 幂等设计：通过 metadata.legacyId 去重。
 */
export function migrateMemories(memoryStore: MemoryNodeStore, memories: LegacyMemory[]): MigrationResult {
  const result: MigrationResult = { migrated: 0, skipped: 0, errors: [] }

  // 获取已迁移的 legacyId 集合
  const existing = memoryStore.list({})
  const migratedIds = new Set(existing.filter((n) => n.metadata?.legacyId).map((n) => String(n.metadata!.legacyId)))

  for (const memory of memories) {
    if (migratedIds.has(memory.id)) {
      result.skipped++
      continue
    }

    try {
      memoryStore.create({
        nodeType: inferNodeType(memory.tags),
        title: memory.title,
        summary: memory.content,
        scope: memory.scope,
        userId: memory.userId ?? null,
        repositoryId: memory.repositoryId ?? null,
        conversationId: memory.conversationId ?? null,
        status: memory.pinned ? 'active' : 'candidate',
        importance: memory.importance,
        confidence: memory.pinned ? 0.9 : 0.5,
        tags: memory.tags,
        source: memory.source,
        metadata: { legacyId: memory.id, migratedAt: new Date().toISOString() }
      })
      result.migrated++
    } catch (err) {
      result.errors.push({ id: memory.id, error: String(err) })
    }
  }

  return result
}

/**
 * 将旧 RepoWikiDoc 迁移到 KnowledgeStore。
 *
 * 每个 wiki doc 作为一个 knowledge document 写入。
 */
export function migrateWikiDocs(knowledgeStore: KnowledgeStore, docs: LegacyWikiDoc[]): MigrationResult {
  const result: MigrationResult = { migrated: 0, skipped: 0, errors: [] }

  for (const doc of docs) {
    try {
      const { changed } = knowledgeStore.upsertDocument({
        sourcePath: doc.path,
        sourceType: 'markdown',
        content: doc.content,
        title: doc.title,
        repositoryId: doc.repositoryId
      })
      if (changed) {
        result.migrated++
      } else {
        result.skipped++
      }
    } catch (err) {
      result.errors.push({ id: doc.id, error: String(err) })
    }
  }

  return result
}
