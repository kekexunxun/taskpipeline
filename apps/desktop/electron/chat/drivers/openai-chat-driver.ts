/**
 * OpenAI Chat Driver — ChatDriver 的 @ai-sdk/openai-compatible 实现。
 *
 * 职责(全部封在本文件内):
 *  - listModels: 从系统设置中的 modelProfile (`{ baseUrl, model, displayName, apiKeyEnv }`) 读出可用模型;
 *  - streamChat: 调 `streamText`,把 `ModelMessage` 流拆成 DriverPart (text / openai.tool-call / openai.tool-result);
 *  - 工具注入:把 `ToolSource` 翻译成 ai-sdk `tool({...})`,由 ai-sdk 调度执行;
 *  - 任务已创建:每次工具执行后调 `ToolSource.describeResult(output)`,有结果就调
 *    `onTaskCreated` 回调 (并 emit openai.tool-result part);
 *  - 持久化:raw 字段存 ai-sdk 自己的"原样"消息列表(driver 内部累积,流结束一次性 dump)。
 *
 * 上层 (ChatService) 完全不感知 ai-sdk 协议。
 */

import { stepCountIs, streamText, tool as aiTool, type ModelMessage } from 'ai'
import { z } from 'zod'
import type { TaskStore } from '@task-pipeline/core'
import type {
  ChatModelInfo,
  ChatStreamChunk,
  ChatTaskCreationResult,
  ChatUsage,
  DriverPart,
  StoredMessage,
  StoredMessageRecord
} from '../chat-types.js'
import { detectVendor, createVendorModel, type ModelVendor } from './model-providers.js'
import type { ChatDriver, StreamChatInput } from './chat-driver.js'
import type { ToolSource } from './tool-source.js'

type OpenAITokenProvider = (profile?: OpenAIProfile) => string | undefined

type OpenAIProfile = {
  id?: string
  vendor?: ModelVendor
  baseUrl?: string
  model?: string
  displayName?: string
  apiKeyEnv?: string
  isDefault?: boolean
}

/**
 * 模型 value 的形态：`openai:<model>`（model 为用户配置的真实模型名）。
 * - 同名模型配了多个 profile 时，listModels 产出 `openai:<model>@<profileId>` 消歧；
 * - 兼容历史值 `openai:default`（早期版本硬编码的占位 value → 默认 profile）。
 */

/** 按 value 解析出目标 profile 与真实模型名（无 @id 时优先默认 profile，其次按模型名匹配）。 */
function resolveProfileForValue(
  profiles: OpenAIProfile[],
  value: string
): { profile: OpenAIProfile; model: string } | undefined {
  const defaultProfile = profiles.find((p) => p.isDefault) ?? profiles[0]
  if (!defaultProfile) return undefined
  if (!value.startsWith('openai:') || value === 'openai:') return undefined
  const raw = value.slice('openai:'.length).trim()
  if (!raw || raw === 'default') {
    // `openai:default` → 默认 profile 的真实模型名
    return defaultProfile.model ? { profile: defaultProfile, model: defaultProfile.model } : undefined
  }
  // 消歧后缀 `openai:<model>@<profileId>`：仅当 @ 后段确实是已配置的 profile id 才拆分，
  // 避免模型名自身包含 @（如 `gpt-4@mini`）被误拆。
  const at = raw.lastIndexOf('@')
  if (at > 0) {
    const maybeId = raw.slice(at + 1)
    const byId = profiles.find((p) => p.id === maybeId)
    if (byId?.model) return { profile: byId, model: raw.slice(0, at) || byId.model }
  }
  // 无 @id：默认 profile 的模型名一致时优先，否则按模型名匹配其它 profile（兼容历史 value）
  if (defaultProfile.model === raw) return { profile: defaultProfile, model: raw }
  const byModel = profiles.find((p) => p.model === raw)
  if (byModel?.model) return { profile: byModel, model: raw }
  return undefined
}

/**
 * OpenAI driver 自己的 raw 形态(给存储层用):
 *  - 用户消息: `{ kind: "user", text: string }`;
 *  - 助手消息: `{ kind: "assistant", parts: DriverPart[] }` —— parts 与 DriverPart 完全一致,driver 加载时直接透传;
 *  - 系统消息: `{ kind: "system", text: string }`。
 */
type OpenAIRawMessage =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; parts: DriverPart[] }
  | { kind: 'system'; text: string }

function rawToParts(raw: unknown): DriverPart[] {
  if (!raw || typeof raw !== 'object') return []
  const record = raw as OpenAIRawMessage
  if (record.kind === 'user' || record.kind === 'system')
    return [{ driverId: 'openai', type: 'text', text: record.text }]
  if (record.kind === 'assistant' && Array.isArray(record.parts)) return record.parts
  return []
}

/**
 * 相邻同类型 part 合并（text / openai.thinking）：
 * 流式 delta 逐片转发会被上层累积为碎 part，序列化前合并成整段；
 * parentTaskId 不同的 part 不合并（分属不同子任务作用域）。
 */
function mergeAdjacentParts(parts: DriverPart[]): DriverPart[] {
  const out: DriverPart[] = []
  for (const part of parts) {
    const last = out[out.length - 1]
    if (part.type === 'text' && last?.type === 'text' && part.parentTaskId === last.parentTaskId) {
      last.text += part.text
    } else if (
      part.type === 'openai.thinking' &&
      last?.type === 'openai.thinking' &&
      part.parentTaskId === last.parentTaskId
    ) {
      last.text += part.text
    } else {
      out.push({ ...part })
    }
  }
  return out
}

function readProfiles(store: TaskStore): OpenAIProfile[] {
  const raw = store.getSetting('modelProfiles')
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        const profiles = parsed.filter(
          (item): item is OpenAIProfile =>
            Boolean(item) && typeof item === 'object' && typeof (item as OpenAIProfile).baseUrl === 'string'
        )
        if (profiles.length > 0) return profiles
      }
    } catch {
      /* 忽略脏数据，走旧格式兼容 */
    }
  }
  // 兼容旧格式 `modelProfile`（单个对象 → 默认 profile）
  const legacy = store.getSetting('modelProfile')
  if (!legacy) return []
  try {
    const profile = JSON.parse(legacy) as OpenAIProfile
    if (profile.baseUrl && profile.model) return [{ ...profile, isDefault: true }]
  } catch {
    /* 忽略历史脏数据 */
  }
  return []
}

/**
 * 把 ToolSource 的声明翻译成 ai-sdk `tool({...})`。
 *  - `schema` 是单层 record,需要 `z.object(...)` 包装;
 *  - `execute` 直接调 ToolDeclaration.execute(driver 不知道业务含义);
 *  - `description` / `annotations` 直接透传。
 */
function buildAiTools(source: ToolSource): Record<string, ReturnType<typeof aiTool>> {
  const tools: Record<string, ReturnType<typeof aiTool>> = {}
  for (const decl of source.tools()) {
    // ai-sdk 的 `tool` 是强类型函数,需要把 schema 转成具体 zod object。
    // ToolDeclaration.schema 是单层 record (`z.object` 已经拆好字段),
    // 这里组合一次给 ai-sdk。schema 的实际形态在运行时由 driver 决定,
    // 静态类型统一为 unknown,driver 内部不再做 type-level 推断。
    const built = aiTool({
      description: decl.description,
      inputSchema: z.object(decl.schema as unknown as Record<string, z.ZodTypeAny>) as never,
      execute: async (input) => decl.execute(input as Record<string, unknown>)
    })
    tools[decl.name] = built as unknown as ReturnType<typeof aiTool>
  }
  return tools
}

/**
 * 把 driver 的 history (StoredMessage[]) 转成 ai-sdk `ModelMessage[]`。
 *  - driver 切换时,qoder 的 parts 会以纯文本形式降级(只取 text parts);
 *  - openai 自己的 tool-use / tool-result parts 转成 ai-sdk 的 ToolModelMessage;
 *  - ai-sdk 7 起 messages 里不允许 system 角色,history 中的 system 消息单独收集,
 *    由调用方通过 `system` 选项传给 streamText。
 */
function historyToModelMessages(history: StoredMessage[]): { messages: ModelMessage[]; systemText: string } {
  const out: ModelMessage[] = []
  const systemParts: string[] = []
  for (const message of history) {
    if (message.role === 'system') {
      const text = message.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { type: 'text'; text: string }).text)
        .join('\n')
      if (text) systemParts.push(text)
      continue
    }
    if (message.role === 'user') {
      const text = message.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { type: 'text'; text: string }).text)
        .join('\n')
      if (text) out.push({ role: 'user', content: text })
      continue
    }
    // assistant
    const openaiParts = message.parts.filter((p) => p.driverId === 'openai')
    const text = openaiParts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { type: 'text'; text: string }).text)
      .join('')
    const toolCalls = openaiParts.filter(
      (p): p is Extract<DriverPart, { type: 'openai.tool-call' }> => p.type === 'openai.tool-call'
    )
    if (toolCalls.length) {
      out.push({
        role: 'assistant',
        content: [
          ...(text ? [{ type: 'text' as const, text }] : []),
          ...toolCalls.map((tc) => ({
            type: 'tool-call' as const,
            toolCallId: tc.toolCallId,
            toolName: tc.name,
            input: tc.input
          }))
        ]
      })
    } else if (text) {
      out.push({ role: 'assistant', content: text })
    }
    // 跟在这个 assistant 后面的 openai tool-result parts,转成 tool 消息
    const toolResults = openaiParts.filter(
      (p): p is Extract<DriverPart, { type: 'openai.tool-result' }> => p.type === 'openai.tool-result'
    )
    const correspondingCalls = new Map<string, string>()
    for (const tc of openaiParts.filter(
      (p): p is Extract<DriverPart, { type: 'openai.tool-call' }> => p.type === 'openai.tool-call'
    )) {
      correspondingCalls.set(tc.toolCallId, tc.name)
    }
    if (toolResults.length) {
      const toolMessage: ModelMessage = {
        role: 'tool',
        content: toolResults.map((tr) => ({
          type: 'tool-result' as const,
          toolCallId: tr.toolCallId,
          toolName: correspondingCalls.get(tr.toolCallId) ?? 'tool',
          output: { type: 'json' as const, value: tr.output as never }
        }))
      }
      out.push(toolMessage)
    }
  }
  return { messages: out, systemText: systemParts.join('\n\n') }
}

/**
 * OpenAI Chat Driver。
 */
export class OpenAIChatDriver implements ChatDriver {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI-Compatible'

  constructor(
    private readonly store: TaskStore,
    private readonly getApiKey: OpenAITokenProvider
  ) {
    if (!store) throw new Error('OpenAIChatDriver requires a TaskStore')
    if (!getApiKey) throw new Error('OpenAIChatDriver requires an api key provider')
  }

  async listModels(): Promise<ChatModelInfo[]> {
    const profiles = readProfiles(this.store)
    if (profiles.length === 0) return []
    // value 携带真实模型名（`openai:<model>`）；同名模型配了多个 profile 时附加 `@<id>` 消歧。
    const models = profiles
      .filter((p) => p.baseUrl && p.model)
      .map((profile) => ({ profile, value: `openai:${profile.model}` }))
    const countByValue = new Map<string, number>()
    for (const m of models) countByValue.set(m.value, (countByValue.get(m.value) ?? 0) + 1)
    return models.map(({ profile, value }) => ({
      value: (countByValue.get(value) ?? 0) > 1 && profile.id ? `${value}@${profile.id}` : value,
      displayName: profile.displayName || profile.model || 'OpenAI-Compatible',
      isDefault: profile.isDefault === true
    }))
  }

  serializeUserMessage(input: { id: string; text: string; createdAt: string }): StoredMessageRecord {
    return {
      id: input.id,
      role: 'user',
      createdAt: input.createdAt,
      driverId: 'openai',
      raw: { kind: 'user', text: input.text } satisfies OpenAIRawMessage
    }
  }

  serializeAssistantMessage(input: {
    id: string
    parts: DriverPart[]
    createdAt: string
    sessionId?: string
    usage?: ChatUsage
  }): StoredMessageRecord {
    // 流式 delta 逐片转发会被上层累积为碎 part（如 Deep/Se/ek），落盘前合并成整段，
    // 让 Trace 展示 / 历史重建看到完整文本；live 渲染不受影响（各 delta 仍逐条推送）。
    return {
      id: input.id,
      role: 'assistant',
      createdAt: input.createdAt,
      driverId: 'openai',
      raw: { kind: 'assistant', parts: mergeAdjacentParts(input.parts) } satisfies OpenAIRawMessage,
      ...(input.usage ? { usage: input.usage } : {})
    }
  }

  deserializeMessage(record: StoredMessageRecord): StoredMessage {
    return { ...record, parts: rawToParts(record.raw) }
  }

  async *streamChat(input: StreamChatInput): AsyncGenerator<ChatStreamChunk> {
    const profiles = readProfiles(this.store)
    if (profiles.length === 0) throw new Error('OpenAI-Compatible profile 未配置')
    const resolved = resolveProfileForValue(profiles, input.model)
    if (!resolved) throw new Error(`未知的 OpenAI 模型: ${input.model}`)
    const profile = resolved.profile
    const modelName = resolved.model
    if (!profile.baseUrl) throw new Error(`未知的 OpenAI 模型: ${input.model}`)

    const apiKey = (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined) ?? this.getApiKey(profile)
    // 按厂商选 ai-sdk provider 包：deepseek/openai 官方端点用专用包（reasoning/structured outputs 等
    // 官方能力），未知端点回落 openai-compatible。vendor 未配置时按 baseUrl 主机名自动识别。
    const model = createVendorModel(
      profile.vendor ?? detectVendor(profile.baseUrl),
      { baseUrl: profile.baseUrl, apiKey },
      modelName
    )

    const taskSource = input.toolSource
    const tools = taskSource ? buildAiTools(taskSource) : undefined
    // ai-sdk 7 起 system 内容必须走 `system` 选项,messages 里不允许 system 角色:
    // 合并「工作目录 + 历史 system + 任务工具 systemPrompt」三段,统一从选项传入。
    const { messages, systemText } = historyToModelMessages(input.history)
    const system = [
      input.cwd ? `当前工作目录: ${input.cwd}` : '',
      systemText,
      taskSource ? taskSource.systemPrompt() : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    messages.push({ role: 'user', content: input.userInput.text })

    const parts: DriverPart[] = []
    let taskCreated: ChatTaskCreationResult | undefined
    let streamUsage: ChatUsage | undefined
    // 流正常结束时 fullStream 一定会产出 finish chunk；若底层连接静默断开（无 error chunk、
    // 无异常），for-await 会直接结束。用 sawFinish 兜底检测，避免「半截回复 + 显示成功」。
    let sawFinish = false

    const result = streamText({
      model,
      messages,
      abortSignal: input.signal,
      ...(system ? { system } : {}),
      ...(taskSource ? { tools, stopWhen: stepCountIs(10) } : {})
    })

    try {
      for await (const chunk of result.fullStream) {
        if (input.signal.aborted) return
        // chunk.type 是 TextStreamPart 的 type 字段
        if (chunk.type === 'text-delta' && 'text' in chunk && chunk.text) {
          const part: DriverPart = { driverId: 'openai', type: 'text', text: chunk.text }
          parts.push(part)
          yield { type: 'part', part }
        } else if (chunk.type === 'reasoning-delta' && 'text' in chunk && chunk.text) {
          // 推理模型（DeepSeek reasoner 等）的思考流:转发成 openai.thinking part,
          // 前端渲染为可折叠「思考中…」块,与 Qoder 的 qoder.thinking 体验一致。
          const part: DriverPart = { driverId: 'openai', type: 'openai.thinking', text: chunk.text }
          parts.push(part)
          yield { type: 'part', part }
        } else if (chunk.type === 'tool-call') {
          const tc = chunk as unknown as { toolCallId: string; toolName: string; input: unknown }
          const part: DriverPart = {
            driverId: 'openai',
            type: 'openai.tool-call',
            toolCallId: tc.toolCallId,
            name: tc.toolName,
            input: tc.input
          }
          parts.push(part)
          yield { type: 'part', part }
        } else if (chunk.type === 'tool-result') {
          const tr = chunk as unknown as { toolCallId: string; output: unknown }
          const part: DriverPart = {
            driverId: 'openai',
            type: 'openai.tool-result',
            toolCallId: tr.toolCallId,
            output: tr.output
          }
          parts.push(part)
          yield { type: 'part', part }
          if (taskSource) {
            const described = taskSource.describeResult(tr.output)
            if (described && !taskCreated) {
              taskCreated = described
              yield { type: 'task-created', result: described }
            }
          }
        } else if (chunk.type === 'error' && 'error' in chunk) {
          // ai-sdk 流错误 chunk（TextStreamErrorPart）：网络中断 / 服务端异常等
          // 不会让 fullStream 抛异常，而是产出 error chunk；不处理会被静默吞掉
          // 导致界面显示半截回复且无任何提示。显式上抛让 ChatService 标记 error。
          throw chunk.error
        } else if (chunk.type === 'finish') {
          sawFinish = true
          // 捕获用量（ai-sdk 7 的 usage 字段是 inputTokens / outputTokens / totalTokens），
          // 由 done chunk 带回给 ChatService 持久化；finishReason=error 视为流异常结束。
          if ('finishReason' in chunk && chunk.finishReason === 'error') {
            throw new Error('模型流式输出异常结束（finish_reason: error）')
          }
          const u = (chunk as { usage?: unknown }).usage as
            | { inputTokens?: number; outputTokens?: number; totalTokens?: number }
            | undefined
          if (u && (u.inputTokens ?? 0) > 0) {
            streamUsage = {
              inputTokens: u.inputTokens ?? 0,
              outputTokens: u.outputTokens ?? 0,
              totalTokens: u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
            }
          }
        }
      }
    } catch (error) {
      // 除用户主动 abort 外,一律上抛:让 ChatService 标记 error 并推送错误提示,
      // 避免「已有部分输出就吞掉错误」导致界面显示不完整回答且没有任何提示。
      if (!input.signal.aborted) throw error
    }

    // 流静默中断兜底:未收到 finish chunk 且非用户取消,视为异常（可能已有部分输出,
    // 上抛让 ChatService 标记 error,前端显示错误提示而不是假装完成）。
    if (!sawFinish && !input.signal.aborted) {
      throw new Error('模型流异常中断：未收到完成标记（finish chunk）')
    }

    if (!input.signal.aborted) {
      yield {
        type: 'done',
        status: 'done',
        model: modelName,
        ...(streamUsage ? { usage: streamUsage } : {})
      }
    }
  }

  dispose(): void {
    // ai-sdk 不持有长期资源,无需释放。
  }
}
