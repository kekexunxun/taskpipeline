import { describe, expect, it, vi } from 'vitest'
import type { OpenCodeReviewService, OpenAICompatReviewer } from '@task-pipeline/integrations'
import type { AgentService } from '../agents/agent-service.js'
import type { QoderOrchestrator } from '../pi-extension/qoder/qoder-orchestrator.js'
import type { DriverPart } from './chat-types.js'
import {
  collectTouchedFiles,
  buildChatReviewFixPrompt,
  runChatCodeReview,
  type ChatGitService,
  type ChatReviewDeps
} from './chat-review.js'

const WD = '/proj'

function editPart(pathValue: string): DriverPart {
  return { driverId: 'qoder', type: 'qoder.tool-use', toolCallId: 't1', name: 'Edit', input: { file_path: pathValue } }
}

/** 一份 review JSON 文本（含指定 severities 的意见）。 */
function reviewJson(severities: string[]): string {
  return JSON.stringify({
    status: 'completed',
    comments: severities.map((severity, i) => ({ path: 'a.ts', line: i + 1, severity, message: `m-${severity}` })),
    summary: { files: 1, comments: severities.length }
  })
}

function makeDeps(overrides: Partial<ChatReviewDeps> & { settings?: Record<string, string> } = {}): ChatReviewDeps {
  const { settings = {}, ...rest } = overrides
  const gitService: ChatGitService = {
    workingTreeStatus: async () => [{ path: 'a.ts', status: 'M' }],
    diffFile: async () => '+changed line\n'
  }
  const openAIReviewer = {
    call: async () => reviewJson(['high'])
  } as unknown as OpenAICompatReviewer
  const ocrService = { rule: async () => '' } as unknown as OpenCodeReviewService
  const agentService = {
    resolveOperationAgent: () => ({ roleAgent: undefined, roleBody: 'reviewer role', contextBody: '' })
  } as unknown as AgentService
  const qoderOrchestrator = {
    callReviewer: async () => reviewJson(['high']),
    runChatFix: async () => ''
  } as unknown as QoderOrchestrator
  return {
    gitService,
    ocrService,
    openAIReviewer,
    agentService,
    qoderOrchestrator,
    getSetting: (key) => settings[key],
    providerForChat: () => 'qoder',
    ...rest
  }
}

function baseCtx(parts: DriverPart[]) {
  return {
    chatId: 'chat-1',
    workingDirectory: WD,
    workspaceRoots: [WD],
    userText: '实现登录功能',
    parts,
    onStatus: () => undefined
  }
}

describe('collectTouchedFiles', () => {
  it('只采集文件变更类工具命中的文件并解析为绝对路径', () => {
    const parts: DriverPart[] = [
      editPart('/proj/a.ts'),
      { driverId: 'qoder', type: 'qoder.tool-use', toolCallId: 't2', name: 'Read', input: { path: '/proj/b.ts' } },
      { driverId: 'openai', type: 'openai.tool-call', toolCallId: 't3', name: 'Write', input: { path: 'c.ts' } }
    ]
    const touched = collectTouchedFiles(parts, WD)
    expect(touched.has('/proj/a.ts')).toBe(true)
    expect(touched.has('/proj/c.ts')).toBe(true)
    expect(touched.has('/proj/b.ts')).toBe(false) // Read 不算变更
  })
})

describe('runChatCodeReview', () => {
  it('本轮无文件变更时跳过', async () => {
    const outcome = await runChatCodeReview(makeDeps(), baseCtx([]))
    expect(outcome.reviewed).toBe(false)
    expect(outcome.skippedReason).toContain('无文件变更')
  })

  it('命中文件在工作区已无变更时跳过', async () => {
    const deps = makeDeps()
    deps.gitService = { workingTreeStatus: async () => [], diffFile: async () => '' }
    const outcome = await runChatCodeReview(deps, baseCtx([editPart('/proj/a.ts')]))
    expect(outcome.reviewed).toBe(false)
    expect(outcome.blocking).toEqual([])
  })

  it('OpenAI 运行时走 openAIReviewer 判定阻断，autoFix 关闭时仅记录不修订', async () => {
    const deps = makeDeps({ providerForChat: () => 'openai' })
    const runChatFix = vi.fn()
    deps.qoderOrchestrator = {
      callReviewer: async () => reviewJson(['high']),
      runChatFix
    } as unknown as QoderOrchestrator
    const outcome = await runChatCodeReview(deps, baseCtx([editPart('/proj/a.ts')]))
    expect(outcome.reviewed).toBe(true)
    expect(outcome.blocking.map((c) => c.severity)).toEqual(['high'])
    expect(outcome.fixRounds).toBe(0)
    expect(runChatFix).not.toHaveBeenCalled()
  })

  it('阻断级别=critical 时 high 意见不阻断（与 Task 同源判定）', async () => {
    const deps = makeDeps({ settings: { reviewBlockingLevel: 'critical' } })
    deps.qoderOrchestrator = { callReviewer: async () => reviewJson(['high']) } as unknown as QoderOrchestrator
    const outcome = await runChatCodeReview(deps, baseCtx([editPart('/proj/a.ts')]))
    expect(outcome.blocking).toEqual([])
    expect(outcome.reviewed).toBe(true)
  })

  it('Qoder 运行时开启 autoFix：触发修订并在复审通过后停止', async () => {
    const deps = makeDeps({ settings: { reviewAutoFix: 'true', reviewAutoFixMaxRounds: '2' } })
    let firstReview = true
    const runChatFix = vi.fn(async () => '')
    deps.qoderOrchestrator = {
      callReviewer: async () => {
        if (firstReview) {
          firstReview = false
          return reviewJson(['high'])
        }
        return reviewJson([]) // 修订后复审通过
      },
      runChatFix
    } as unknown as QoderOrchestrator
    const outcome = await runChatCodeReview(deps, baseCtx([editPart('/proj/a.ts')]))
    expect(runChatFix).toHaveBeenCalledTimes(1)
    expect(outcome.fixRounds).toBe(1)
    expect(outcome.blocking).toEqual([])
  })

  it('非 Qoder 运行时不进入独立修订', async () => {
    const deps = makeDeps({ settings: { reviewAutoFix: 'true' }, providerForChat: () => 'openai' })
    const runChatFix = vi.fn()
    deps.qoderOrchestrator = {
      callReviewer: async () => reviewJson(['high']),
      runChatFix
    } as unknown as QoderOrchestrator
    const outcome = await runChatCodeReview(deps, baseCtx([editPart('/proj/a.ts')]))
    expect(runChatFix).not.toHaveBeenCalled()
    expect(outcome.fixRounds).toBe(0)
    expect(outcome.blocking.length).toBe(1)
  })
})

describe('buildChatReviewFixPrompt', () => {
  it('渲染阻断意见为编号行', () => {
    const prompt = buildChatReviewFixPrompt([{ path: 'a.ts', line: 3, severity: 'high', message: '空指针' }])
    expect(prompt).toContain('1. [high] a.ts:3 — 空指针')
  })
})
