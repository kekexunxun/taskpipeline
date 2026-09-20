import type { SettingResolver } from '@task-pipeline/core'
import { describe, expect, it } from 'vitest'
import {
  OpenAICompatReviewer,
  reviewPreparedDiff,
  filterBlockingComments,
  type Reviewer
} from './review-orchestrator.js'
import type { OpenCodeReviewService } from './review.js'

/**
 * OpenAICompatReviewer 多 profile 行为测试：
 * - modelProfiles（数组）中选择默认 profile（isDefault 优先，否则第一个）；
 * - API Key 读取约定：优先 `modelApiKey:<id>`，默认/无 id 回退 `modelApiKey`；
 * - 历史单配置 `modelProfile` 兼容。
 */
function makeResolver(settings: Record<string, string>): SettingResolver {
  return {
    get: (key: string) => settings[key],
    getSecret: (key: string) => settings[key]
  }
}

async function callWith(settings: Record<string, string>, model?: string): Promise<{ url: string; body: unknown }> {
  let captured: { url: string; body: unknown } | undefined
  const fetcher = (async (url: string, init: { body?: string }) => {
    captured = { url, body: JSON.parse(init.body ?? '{}') }
    return {
      ok: true,
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: 'ok' } }] })
    } as unknown as Response
  }) as typeof fetch
  const reviewer = new OpenAICompatReviewer(makeResolver(settings), 1000, fetcher)
  await reviewer.call(
    {
      repo: 'repo',
      task: 'task',
      files: ['a.ts'],
      rules: '',
      diff: 'diff'
    },
    'task-1',
    model
  )
  if (!captured) throw new Error('fetch not called')
  return captured
}

describe('OpenAICompatReviewer multi-profile', () => {
  it('uses the default profile from modelProfiles and reads its scoped api key', async () => {
    const settings: Record<string, string> = {
      modelProfiles: JSON.stringify([
        { id: 'p1', provider: 'company-openai', baseUrl: 'https://a.example.com', model: 'gpt-4o', isDefault: false },
        {
          id: 'p2',
          provider: 'company-openai',
          baseUrl: 'https://b.example.com',
          model: 'DeepSeek-V4-Flash',
          isDefault: true
        }
      ]),
      'modelApiKey:p2': 'sk-scoped'
    }
    const { url, body } = await callWith(settings)
    expect(url).toContain('b.example.com')
    expect(body).toMatchObject({ model: 'DeepSeek-V4-Flash' })
    expect((body as { messages: unknown[] }).messages).toBeDefined()
  })

  it('falls back to the first profile when no default is marked', async () => {
    const settings: Record<string, string> = {
      modelProfiles: JSON.stringify([
        { id: 'p1', baseUrl: 'https://a.example.com', model: 'gpt-4o' },
        { id: 'p2', baseUrl: 'https://b.example.com', model: 'claude-opus' }
      ]),
      'modelApiKey:p1': 'sk-a'
    }
    const { url, body } = await callWith(settings)
    expect(url).toContain('a.example.com')
    expect(body).toMatchObject({ model: 'gpt-4o' })
  })

  it('falls back to the legacy modelApiKey for the default profile without a scoped key', async () => {
    const settings: Record<string, string> = {
      modelProfiles: JSON.stringify([{ id: 'p1', baseUrl: 'https://a.example.com', model: 'gpt-4o', isDefault: true }]),
      modelApiKey: 'sk-legacy'
    }
    const { body } = await callWith(settings)
    expect(body).toMatchObject({ model: 'gpt-4o' })
  })

  it('reads the legacy single modelProfile object', async () => {
    const settings: Record<string, string> = {
      modelProfile: JSON.stringify({ baseUrl: 'https://old.example.com', model: 'gpt-4o' }),
      modelApiKey: 'sk-old'
    }
    const { url, body } = await callWith(settings)
    expect(url).toContain('old.example.com')
    expect(body).toMatchObject({ model: 'gpt-4o' })
  })

  it('strips the openai: prefix from the model value', async () => {
    const settings: Record<string, string> = {
      modelProfiles: JSON.stringify([{ id: 'p1', baseUrl: 'https://a.example.com', model: 'gpt-4o', isDefault: true }]),
      'modelApiKey:p1': 'sk-a'
    }
    // 传入 ChatModelSelector 的 value（`openai:<model>`），端点应收到剥离前缀后的真实模型名
    const { body } = await callWith(settings, 'openai:gpt-4o')
    expect(body).toMatchObject({ model: 'gpt-4o' })
  })

  it('throws when no profile is configured', async () => {
    const reviewer = new OpenAICompatReviewer(makeResolver({}), 1000, (() => ({})) as unknown as typeof fetch)
    await expect(
      reviewer.call({ repo: 'r', task: 't', files: [], rules: '', diff: '' }, 't', undefined)
    ).rejects.toThrow(/未配置/)
  })
})

describe('reviewPreparedDiff', () => {
  function fakeOcr(ruleImpl: () => Promise<string>) {
    return { rule: ruleImpl } as unknown as OpenCodeReviewService
  }

  it('parses reviewer JSON into ReviewResult and reports status transitions', async () => {
    const statuses: string[] = []
    const reviewer: Reviewer = {
      call: async () =>
        JSON.stringify({
          status: 'completed',
          comments: [{ path: 'a.ts', line: 3, severity: 'high', message: 'bug' }],
          summary: { files: 1, comments: 1 }
        })
    }
    const result = await reviewPreparedDiff({
      ocr: fakeOcr(async () => 'RULE'),
      reviewer,
      worktree: '/wt',
      repoName: 'repo',
      taskTitle: 't',
      reviewScopeId: 'scope-1',
      files: ['a.ts'],
      diff: '+x',
      onStatus: (title) => statuses.push(title)
    })
    expect(result.comments[0]?.severity).toBe('high')
    expect(statuses.some((s) => s.includes('调用 LLM 审查'))).toBe(true)
    expect(statuses.some((s) => s.includes('LLM 审查返回'))).toBe(true)
  })

  it('degrades to default rules when ocr.rule throws (does not abort review)', async () => {
    let seenRules = '__unset__'
    const reviewer: Reviewer = {
      call: async (input) => {
        seenRules = input.rules
        return JSON.stringify({ status: 'completed', comments: [], summary: { files: 1, comments: 0 } })
      }
    }
    const result = await reviewPreparedDiff({
      ocr: fakeOcr(async () => {
        throw new Error('ocr missing')
      }),
      reviewer,
      worktree: '/wt',
      repoName: 'repo',
      taskTitle: 't',
      reviewScopeId: 'scope-1',
      files: ['a.ts'],
      diff: '+x'
    })
    expect(seenRules).toBe('')
    expect(result.comments).toEqual([])
  })

  it('rethrows when reviewer fails', async () => {
    const reviewer: Reviewer = {
      call: async () => {
        throw new Error('llm down')
      }
    }
    await expect(
      reviewPreparedDiff({
        ocr: fakeOcr(async () => ''),
        reviewer,
        worktree: '/wt',
        repoName: 'repo',
        taskTitle: 't',
        reviewScopeId: 'scope-1',
        files: ['a.ts'],
        diff: '+x'
      })
    ).rejects.toThrow(/llm down/)
  })
})

describe('filterBlockingComments', () => {
  const comments = [{ severity: 'critical' }, { severity: 'high' }, { severity: 'medium' }, { severity: 'low' }]

  it('level=high keeps critical + high only', () => {
    expect(filterBlockingComments(comments, 'high').map((c) => c.severity)).toEqual(['critical', 'high'])
  })

  it('level=critical keeps only critical', () => {
    expect(filterBlockingComments(comments, 'critical').map((c) => c.severity)).toEqual(['critical'])
  })

  it('level=medium keeps critical/high/medium', () => {
    expect(filterBlockingComments(comments, 'medium').map((c) => c.severity)).toEqual(['critical', 'high', 'medium'])
  })
})
