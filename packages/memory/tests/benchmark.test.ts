/**
 * 性能基准测试：验证检索延迟 < 100ms（目标指标）。
 *
 * 在 CI 环境中仅作参考，不作为硬门禁（CI 机器性能差异大）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MemoryEngine } from '../src/memory-engine.js'

let db: Database.Database

afterEach(() => {
  db?.close()
})

describe('Performance Benchmark', () => {
  it('1000 节点 + 500 知识文档：检索延迟 < 100ms', () => {
    db = new Database(':memory:')
    const engine = new MemoryEngine(db)

    // 写入 1000 个 MemoryNode
    for (let i = 0; i < 1000; i++) {
      engine.memoryNodes.create({
        nodeType: i % 7 === 0 ? 'constraint' : i % 7 === 1 ? 'architecture' : 'procedure',
        title: `Memory node ${i}: ${['authentication', 'database', 'API', 'security', 'testing', 'deployment', 'monitoring'][i % 7]} module`,
        summary: `This is the summary for memory node ${i}. It contains information about ${['auth flows', 'data models', 'endpoints', 'policies', 'test cases', 'CI/CD', 'metrics'][i % 7]}.`,
        scope: 'repo',
        repositoryId: 'repo-1',
        status: i % 10 === 0 ? 'candidate' : 'active',
        confidence: 0.5 + (i % 50) / 100,
        importance: 0.3 + (i % 70) / 100,
        tags: [`tag-${i % 20}`, 'benchmark']
      })
    }

    // 写入 500 个知识文档 + propositions
    for (let i = 0; i < 500; i++) {
      const { document } = engine.knowledge.upsertDocument({
        sourcePath: `/docs/doc-${i}.md`,
        sourceType: 'markdown',
        content: `# Document ${i}\nContent about ${['authentication', 'database', 'API', 'security', 'testing'][i % 5]} with detailed explanation.`,
        repositoryId: 'repo-1'
      })
      engine.knowledge.insertPropositions([
        {
          documentId: document.id,
          paragraphId: null,
          content: `Proposition ${i}: constraint about ${['input validation', 'error handling', 'token management', 'access control', 'test coverage'][i % 5]}`,
          propositionType: 'constraint',
          sourcePattern: 'markdown_bullet'
        }
      ])
    }

    // 基准测试：100 次检索取平均
    const iterations = 100
    const latencies: number[] = []

    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      engine.retrieve({
        query: 'authentication token validation',
        taskIntent: 'bug_fix',
        repositoryId: 'repo-1'
      })
      latencies.push(performance.now() - start)
    }

    const avg = latencies.reduce((a, b) => a + b) / latencies.length
    const p95 = latencies.sort((a, b) => a - b)[Math.floor(iterations * 0.95)]!
    const max = Math.max(...latencies)

    // 输出性能数据（CI 中仅作参考）
    console.log(`\n── Performance Results (1000 nodes + 500 docs) ──`)
    console.log(`  Average: ${avg.toFixed(2)}ms`)
    console.log(`  P95:     ${p95.toFixed(2)}ms`)
    console.log(`  Max:     ${max.toFixed(2)}ms`)
    console.log(`  Target:  < 100ms`)

    // 软断言：平均延迟应 < 200ms（留余量给 CI 环境）
    expect(avg).toBeLessThan(200)

    engine.dispose()
  })

  it('FTS5 检索：单节点搜索 < 10ms', () => {
    db = new Database(':memory:')
    const engine = new MemoryEngine(db)

    for (let i = 0; i < 100; i++) {
      engine.memoryNodes.create({
        nodeType: 'procedure',
        title: `Procedure ${i}`,
        summary: `Summary about authentication and validation for procedure ${i}`,
        scope: 'repo',
        repositoryId: 'repo-1',
        status: 'active'
      })
    }

    const start = performance.now()
    for (let i = 0; i < 50; i++) {
      engine.memoryNodes.searchFts({ keywords: ['authentication'], repositoryId: 'repo-1', limit: 10 })
    }
    const elapsed = performance.now() - start
    const avgMs = elapsed / 50

    console.log(`\n── FTS5 Search (100 nodes) ──`)
    console.log(`  Average: ${avgMs.toFixed(2)}ms`)

    expect(avgMs).toBeLessThan(10)

    engine.dispose()
  })
})
