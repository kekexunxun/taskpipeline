import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskStore } from '@task-pipeline/core'
import type { ExtractedMemoryDraft } from './memory-extractor.js'

/**
 * 真实 better-sqlite3 原生模块是按 Electron ABI 编译的，vitest 跑在纯 Node 下
 * 无法 `new Database`。这里用 vi.mock 把 MemoryStore 换成内存假实现，
 * 只验证 consolidateMemories 的判重逻辑（问题 5：内容级验重），不碰真实 DB。
 */
type FakeMemory = { scope: string; title: string; content: string }

class FakeMemoryStore {
  readonly memories: FakeMemory[] = []
  constructor(_db: unknown) {}
  listMemories(_filter: unknown): FakeMemory[] {
    return this.memories
  }
  createMemory(input: { scope: string; title: string; content: string }): unknown {
    this.memories.push({ scope: input.scope, title: input.title, content: input.content })
    return input
  }
}

vi.mock('@task-pipeline/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, MemoryStore: FakeMemoryStore }
})

const { MemoryService } = await import('./memory-service.js')

function fakeStore(): TaskStore {
  const settings = new Map<string, string>()
  return {
    getSetting: (key: string) => settings.get(key),
    setSetting: (key: string, value: string) => {
      settings.set(key, value)
    }
  } as unknown as TaskStore
}

let service: InstanceType<typeof MemoryService>
let fakeMemory: FakeMemoryStore

beforeEach(() => {
  const store = fakeStore()
  service = new MemoryService(store)
  // MemoryService 内部 new MemoryStore(...) 拿到的是同一个 FakeMemoryStore 实例引用。
  fakeMemory = (service as unknown as { memory: FakeMemoryStore }).memory
})

function draft(scope: ExtractedMemoryDraft['scope'], title: string, content: string): ExtractedMemoryDraft {
  return { scope, title, content, tags: [] }
}

/** 预置一条 user scope 记忆（判重比对基准）。 */
function seed(title: string, content: string): void {
  fakeMemory.memories.push({ scope: 'user', title, content })
}

describe('consolidateMemories 验重', () => {
  it('标题相同（空白差异）不重复入库', () => {
    seed('构建命令', 'npm run build')
    const saved = service.consolidateMemories([draft('user', ' 构建命令 ', '完全不同的内容也没关系')], [], 'conv-1')
    expect(saved).toBe(0)
    expect(fakeMemory.memories).toHaveLength(1)
  })

  it('标题不同但内容相同 → 内容级判重拦截', () => {
    seed('部署流程', '先跑 typecheck 再跑 test 最后打 tag')
    const saved = service.consolidateMemories(
      [draft('user', '上线步骤', '先跑 typecheck 再跑 test 最后打 tag')],
      [],
      'conv-1'
    )
    expect(saved).toBe(0)
    expect(fakeMemory.memories).toHaveLength(1)
  })

  it('内容包含关系 → 判重（一方是另一方子集）', () => {
    seed('提交规范', 'commit message 使用 conventional commits，feat/fix/chore 前缀，描述用中文')
    const saved = service.consolidateMemories(
      [draft('user', '提交规范摘要', 'conventional commits，feat/fix/chore 前缀')],
      [],
      'conv-1'
    )
    expect(saved).toBe(0)
  })

  it('内容高度相似（trigram Jaccard ≥ 0.6）→ 判重', () => {
    seed('测试命令', '运行单元测试使用 npm run test，回归使用 npm run typecheck 加全量单测套件')
    const saved = service.consolidateMemories(
      [draft('user', '单测怎么跑', '运行单元测试使用 npm run test，回归使用 npm run typecheck 加全量单测')],
      [],
      'conv-1'
    )
    expect(saved).toBe(0)
  })

  it('批内去重：同批两条标题不同但内容相同，只入库一条', () => {
    const saved = service.consolidateMemories(
      [
        draft('user', '构建方式 A', 'monorepo 用 npm workspaces，根目录统一构建'),
        draft('user', '构建方式 B', 'monorepo 用 npm workspaces，根目录统一构建')
      ],
      [],
      'conv-1'
    )
    expect(saved).toBe(1)
    expect(fakeMemory.memories).toHaveLength(1)
  })

  it('内容确实不同 → 正常入库', () => {
    seed('已有记忆', '前端组件库使用 shadcn/ui')
    const saved = service.consolidateMemories(
      [draft('user', '数据库', '持久层使用 better-sqlite3，WAL 模式')],
      [],
      'conv-1'
    )
    expect(saved).toBe(1)
    expect(fakeMemory.memories).toHaveLength(2)
  })
})
