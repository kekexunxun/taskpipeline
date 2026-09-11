import { describe, expect, it, vi } from 'vitest'
import type { RepositoryProfile, Task } from '@task-pipeline/core'
import type { TaskIntakeTurnInput } from './task-intake.js'
import { adoptDraftFields, describeDraftFields, intakeTools, pickDraftFields } from './task-intake.js'

const profiles = (...ids: string[]): Pick<RepositoryProfile, 'id'>[] => ids.map((id) => ({ id }))

const draftTask: Task = {
  id: 'task-1',
  source: 'local',
  title: '支持批量导出',
  description: '',
  keywords: [],
  acceptanceCriteria: [],
  state: 'draft',
  reviewStatus: 'pending',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z'
}

describe('pickDraftFields', () => {
  it('只留白名单字段，并丢掉空值', () => {
    const fields = pickDraftFields(
      { title: '  导出要带表头  ', description: '   ', keywords: [' 导出 ', ''], state: 'planning', cwd: '/tmp' },
      profiles('repo-1')
    )
    expect(fields).toEqual({ title: '导出要带表头', keywords: ['导出'] })
  })

  it('repositoryIds 只认系统里真实存在的 id', () => {
    // 模型会编 id，而编出来的 id 到采纳那一刻才爆，所以清洗阶段就得剔掉。
    expect(pickDraftFields({ repositoryIds: ['repo-1', 'repo-ghost', 42] }, profiles('repo-1')).repositoryIds).toEqual([
      'repo-1'
    ])
  })
})

describe('adoptDraftFields', () => {
  it('不传 keys 时整条建议都算采纳', () => {
    const result = adoptDraftFields({ title: '新标题', description: '新描述' }, undefined, profiles())
    expect(result).toEqual({ fields: { title: '新标题', description: '新描述' } })
  })

  it('只写勾选项，未勾选的字段留给用户自己填', () => {
    const stored = { title: '新标题', description: '新描述', keywords: ['导出'] }
    expect(adoptDraftFields(stored, ['title', 'keywords'], profiles()).fields).toEqual({
      title: '新标题',
      keywords: ['导出']
    })
  })

  it('一个都没勾（或勾的都是建议里没有的键）时报错而不是写空', () => {
    expect(adoptDraftFields({ title: '新标题' }, [], profiles()).error).toContain('至少勾选一项')
    expect(adoptDraftFields({ title: '新标题' }, ['description'], profiles()).error).toContain('至少勾选一项')
  })

  it('建议里的仓库已被删掉时报错，而不是默默少写仓库', () => {
    const stored = { repositoryIds: ['repo-1', 'repo-gone'] }
    expect(adoptDraftFields(stored, ['repositoryIds'], profiles('repo-1')).error).toContain('不在系统里')
  })

  it('没勾仓库这一项时，仓库脏数据不拦住其他字段的采纳', () => {
    const stored = { title: '新标题', repositoryIds: ['repo-gone'] }
    expect(adoptDraftFields(stored, ['title'], profiles('repo-1'))).toEqual({ fields: { title: '新标题' } })
  })
})

describe('describeDraftFields', () => {
  it('按改动的字段给出摘要', () => {
    expect(
      describeDraftFields({ title: '新标题', acceptanceCriteria: ['一条', '两条'], repositoryIds: ['repo-1'] })
    ).toBe('标题、验收标准 2 条、仓库 1 个')
  })
})

describe('intakeTools', () => {
  const build = (overrides: Partial<TaskIntakeTurnInput> = {}): TaskIntakeTurnInput => ({
    task: draftTask,
    repositories: [],
    availableRepositories: [{ id: 'repo-1', name: 'desktop' }],
    token: 'token',
    addEvent: vi.fn(),
    ...overrides
  })

  /** 只挑出 `updateTaskDraft`：工具顺序不是下面两条测试要验的东西。 */
  const draftTool = (input: TaskIntakeTurnInput) => intakeTools(input).find((tool) => tool.name === 'updateTaskDraft')!

  it('没关联仓库时只剩 updateTaskDraft', () => {
    expect(intakeTools(build()).map((tool) => tool.name)).toEqual(['updateTaskDraft'])
  })

  it('有关联仓库时补上四个只读查询工具', () => {
    const names = intakeTools(build({ repositories: [{ name: 'desktop', localPath: process.cwd() }] })).map(
      (tool) => tool.name
    )
    expect(names).toEqual(['read_file', 'grep', 'glob', 'list_dir', 'updateTaskDraft'])
  })

  it('updateTaskDraft 只落一条建议事件，不碰任务字段', async () => {
    const input = build()
    const result = await draftTool(input).execute({ title: '导出要带表头', repositoryIds: ['repo-1'] })
    expect(input.addEvent).toHaveBeenCalledTimes(1)
    const event = vi.mocked(input.addEvent).mock.calls[0]![0]
    expect(event).toMatchObject({
      taskId: 'task-1',
      kind: 'status',
      title: 'Agent 建议补全任务定义',
      detail: '标题、仓库 1 个',
      payload: {
        type: 'draft-suggestion',
        fields: { title: '导出要带表头', repositoryIds: ['repo-1'] },
        repositoryNames: { 'repo-1': 'desktop' }
      }
    })
    // 回执得让模型知道还没生效：它下一句怎么说全靠这个返回值。
    expect(result).toMatchObject({ ok: true, pending: true, fields: ['title', 'repositoryIds'] })
  })

  it('空建议直接回错，不落一条没内容的 event', async () => {
    const input = build()
    expect(await draftTool(input).execute({ title: '  ', keywords: [] })).toMatchObject({ ok: false })
    expect(input.addEvent).not.toHaveBeenCalled()
  })
})
