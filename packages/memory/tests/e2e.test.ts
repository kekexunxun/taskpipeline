/**
 * E2E 集成测试：模拟完整工作流，从知识摄入 → 检索 → 反思 → 生命周期。
 *
 * 验证 MemoryEngine 各模块协同工作的正确性。
 */
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MemoryEngine } from '../src/memory-engine.js'
import { splitMarkdown, estimateTokens } from '../src/knowledge/markdown-chunker.js'
import { extractPropositions } from '../src/knowledge/proposition-extractor.js'
import { migrateMemories } from '../src/bridge/legacy-bridge.js'

let db: Database.Database

afterEach(() => {
  db?.close()
})

describe('E2E: 完整工作流', () => {
  it('知识摄入 → 检索 → 反思 → 生命周期', async () => {
    db = new Database(':memory:')
    const engine = new MemoryEngine(db)

    // ── 1. 知识摄入 ──────────────────────────────────────────────────────
    const markdownContent = `# Authentication Module

## Overview
The authentication module handles OAuth2 flows.

## Constraints
- **MUST** validate all tokens before processing
- **NEVER** store raw passwords in database
- Decision: Use PKCE for mobile clients

## Security
// SECURITY: Tokens expire after 24 hours
`

    // 分片
    const chunks = splitMarkdown(markdownContent)
    expect(chunks.length).toBeGreaterThan(1)

    // 写入文档
    const { document } = engine.knowledge.upsertDocument({
      sourcePath: '/docs/auth.md',
      sourceType: 'markdown',
      content: markdownContent,
      title: 'Authentication Module',
      repositoryId: 'repo-1'
    })
    expect(document.id).toBeTruthy()

    // 写入段落
    engine.knowledge.insertParagraphs(
      chunks.map((c) => ({
        documentId: document.id,
        content: c.content,
        headingPath: c.headingPath,
        tokenCount: estimateTokens(c.content)
      }))
    )

    // 提取并写入 propositions
    const propositions = extractPropositions(markdownContent, 'markdown')
    expect(propositions.length).toBeGreaterThan(0)
    engine.knowledge.insertPropositions(
      propositions.map((p) => ({
        documentId: document.id,
        paragraphId: null,
        content: p.content,
        propositionType: p.propositionType,
        sourcePattern: p.sourcePattern
      }))
    )

    // ── 2. 创建记忆节点 ──────────────────────────────────────────────────
    const constraint = engine.memoryNodes.create({
      nodeType: 'constraint',
      title: 'Token validation required',
      summary: 'All API tokens must be validated before processing requests',
      scope: 'repo',
      repositoryId: 'repo-1',
      status: 'active',
      confidence: 0.95,
      importance: 0.9,
      tags: ['auth', 'security']
    })

    engine.evidence.create({
      memoryNodeId: constraint.id,
      evidenceType: 'code_ref',
      sourceId: '/src/auth/middleware.ts',
      sourceRef: 'L42',
      content: 'Token validation in middleware'
    })

    // ── 3. 检索 ──────────────────────────────────────────────────────────
    // 检索记忆
    const memoryPack = engine.retrieve({
      query: 'token validation',
      taskIntent: 'bug_fix',
      repositoryId: 'repo-1'
    })
    expect(memoryPack.memories.length + memoryPack.knowledge.length).toBeGreaterThan(0)
    expect(memoryPack.totalTokens).toBeGreaterThan(0)

    // 检索知识（使用 general intent 确保 paragraph 层被检索）
    const knowledgePack = engine.retrieve({
      query: 'authentication OAuth2',
      taskIntent: 'general',
      repositoryId: 'repo-1'
    })
    // 记忆层或知识层至少有一个有结果
    expect(knowledgePack.memories.length + knowledgePack.knowledge.length).toBeGreaterThan(0)

    // ── 4. 反思 ──────────────────────────────────────────────────────────
    const reflection = engine.createReflection()
    const reflectionResult = await reflection.reflect({
      msSinceLastReflection: 10 * 60 * 1000,
      newEvidenceCount: 5,
      repositoryId: 'repo-1',
      candidates: [
        {
          nodeType: 'security_rule',
          title: 'Token expiration policy',
          summary: 'Tokens expire after 24 hours, refresh tokens after 7 days',
          importance: 0.85,
          confidence: 0.9,
          tags: ['auth', 'security', 'token'],
          evidence: [
            {
              memoryNodeId: '',
              evidenceType: 'conversation',
              content: 'Discussed token expiration in standup'
            }
          ]
        }
      ]
    })
    expect(reflectionResult.gatePassed).toBe(true)
    expect(reflectionResult.results).toHaveLength(1)
    expect(reflectionResult.results[0]!.action).toBe('create')

    // ── 5. 生命周期 ──────────────────────────────────────────────────────
    const retention = engine.createRetention({
      candidateExpiryMs: 1000, // 1 秒（测试用）
      staleThresholdMs: 1000,
      archiveThresholdMs: 1000
    })

    // 创建一个旧 candidate
    const oldCandidate = engine.memoryNodes.create({
      nodeType: 'incident',
      title: 'Old incident',
      scope: 'repo',
      repositoryId: 'repo-1',
      status: 'candidate'
    })
    // 手动设置旧时间
    const oldDate = new Date(Date.now() - 60 * 1000).toISOString()
    db.prepare('UPDATE memory_nodes SET created_at = ? WHERE id = ?').run(oldDate, oldCandidate.id)

    const retentionResult = retention.run(Date.now())
    expect(retentionResult.expired).toContain(oldCandidate.id)

    engine.dispose()
  })

  it('分支感知：不同分支看到不同记忆', () => {
    db = new Database(':memory:')
    const engine = new MemoryEngine(db)

    // feature-a 分支的约束
    engine.memoryNodes.create({
      nodeType: 'constraint',
      title: 'Feature A: use new API format',
      summary: 'Feature A requires the v2 API format',
      scope: 'repo',
      repositoryId: 'repo-1',
      branchName: 'feature-a',
      status: 'active'
    })

    // 全局约束
    engine.memoryNodes.create({
      nodeType: 'constraint',
      title: 'Global: error handling standard',
      summary: 'All errors must use the standardized error format',
      scope: 'repo',
      repositoryId: 'repo-1',
      status: 'active'
    })

    // feature-a 分支检索：应看到分支特定 + 全局
    const packA = engine.retrieve({
      query: 'constraint format',
      taskIntent: 'general',
      repositoryId: 'repo-1',
      branchName: 'feature-a'
    })
    expect(packA.memories.length).toBeGreaterThanOrEqual(1)

    // feature-b 分支检索：应只看到全局
    const packB = engine.retrieve({
      query: 'error handling standard',
      taskIntent: 'general',
      repositoryId: 'repo-1',
      branchName: 'feature-b'
    })
    expect(packB.memories.length).toBeGreaterThanOrEqual(1)

    engine.dispose()
  })

  it('迁移桥接：旧数据 → 新系统', () => {
    db = new Database(':memory:')
    const engine = new MemoryEngine(db)

    // 模拟旧 memories
    const result = migrateMemories(engine.memoryNodes, [
      {
        id: 'old-1',
        scope: 'repo',
        repositoryId: 'repo-1',
        title: 'Use consistent error handling',
        content: 'All errors must follow the standard format',
        tags: ['constraint', 'error'],
        pinned: true,
        importance: 0.8,
        source: 'manual',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z'
      }
    ])
    expect(result.migrated).toBe(1)

    // 验证迁移后的节点可被检索
    const pack = engine.retrieve({
      query: 'error handling',
      taskIntent: 'bug_fix',
      repositoryId: 'repo-1'
    })
    expect(pack.memories.length).toBeGreaterThanOrEqual(1)

    engine.dispose()
  })
})
