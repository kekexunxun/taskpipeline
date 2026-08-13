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

import { jsonSchema, stepCountIs, streamText, tool as aiTool, type ModelMessage } from 'ai'
import { z } from 'zod'
import type { AgentSpan, TaskStore } from '@task-pipeline/core'
import { McpClient } from '@task-pipeline/integrations'
import type {
  ChatModelInfo,
  ChatStreamChunk,
  ChatTaskCreationResult,
  ChatUsage,
  DriverPart,
  ModelCapability,
  ModelParams,
  StoredMessage,
  StoredMessageRecord
} from '../chat-types.js'
import type { McpServiceProfileResolver } from '../mcp-services.js'
import type { TracePipeline } from '../../trace/bus/trace-pipeline.js'
import { detectVendor, createVendorModel, type ModelVendor } from './model-providers.js'
import { isOpenAIModelValue, prefixOfVendor, stripModelPrefix } from './model-value.js'
import type { ChatDriver, StreamChatInput } from './chat-driver.js'
import type { ToolSource } from './tool-source.js'

type OpenAITokenProvider = (profile?: OpenAIProfile) => string | undefined

/** 可配置到 profile 上的能力 key（设置页多选项，覆盖按 vendor 的自动推断）。 */
type CapabilityKey = ModelCapability['key']

type OpenAIProfile = {
  id?: string
  vendor?: ModelVendor
  baseUrl?: string
  model?: string
  displayName?: string
  apiKeyEnv?: string
  isDefault?: boolean
  /** 用户显式声明的可调参数能力；缺省时按 vendor 自动推断。 */
  capabilities?: CapabilityKey[]
}

/** 能力 key → 前端渲染用的 schema 描述。 */
function capabilityOf(key: CapabilityKey): ModelCapability {
  if (key === 'reasoningEffort') return { key, kind: 'enum', options: ['low', 'medium', 'high'] }
  if (key === 'thinking') return { key, kind: 'toggle' }
  return { key: 'maxOutputTokens', kind: 'number' }
}

/**
 * profile 的能力集：用户显式配置优先；否则按 vendor 自动推断
 * （deepseek: 推理力度 + 思考开关；openai 官方: 推理力度 + 最大输出 Token；
 * 其它兼容端点不声明任何能力，避免传不支持的参数）。
 */
function capabilitiesForProfile(profile: OpenAIProfile): ModelCapability[] {
  const vendor = profile.vendor ?? detectVendor(profile.baseUrl)
  const keys: CapabilityKey[] =
    profile.capabilities ??
    (vendor === 'deepseek'
      ? ['reasoningEffort', 'thinking']
      : vendor === 'openai'
        ? ['reasoningEffort', 'maxOutputTokens']
        : [])
  return keys.map(capabilityOf)
}

/**
 * 把运行时模型参数翻译成 ai-sdk providerOptions（按 vendor 分桶）。
 * 不认识 / 不支持的 key 一律忽略；无任何有效参数时返回 undefined。
 */
function buildProviderOptions(
  vendor: ModelVendor,
  params: ModelParams | undefined
): Record<string, Record<string, unknown>> | undefined {
  if (!params) return undefined
  const effort = typeof params.reasoningEffort === 'string' ? params.reasoningEffort : undefined
  const thinking = typeof params.thinking === 'boolean' ? params.thinking : undefined
  const maxOutputTokens =
    typeof params.maxOutputTokens === 'number' && params.maxOutputTokens > 0
      ? Math.round(params.maxOutputTokens)
      : undefined
  if (vendor === 'openai') {
    const openai: Record<string, unknown> = {}
    if (effort) openai.reasoningEffort = effort
    if (maxOutputTokens) openai.maxCompletionTokens = maxOutputTokens
    return Object.keys(openai).length ? { openai } : undefined
  }
  if (vendor === 'deepseek') {
    const deepseek: Record<string, unknown> = {}
    if (effort) deepseek.reasoningEffort = effort
    if (thinking !== undefined) deepseek.thinking = { type: thinking ? 'enabled' : 'disabled' }
    return Object.keys(deepseek).length ? { deepseek } : undefined
  }
  return undefined
}

/**
 * 模型 value 的形态：`<厂商前缀>:<model>`（前缀 = profile.vendor，model 为用户配置的
 * 真实模型名；openai 厂商与历史格式一致）。
 * - 同名模型配了多个 profile 时，listModels 产出 `<前缀>:<model>@<profileId>` 消歧；
 * - 兼容历史值 `openai:<model>` / `openai:default`（早期统一 `openai:` 前缀）。
 */

/** 按 value 解析出目标 profile 与真实模型名（无 @id 时优先默认 profile，其次按模型名匹配）。 */
function resolveProfileForValue(
  profiles: OpenAIProfile[],
  value: string
): { profile: OpenAIProfile; model: string } | undefined {
  const defaultProfile = profiles.find((p) => p.isDefault) ?? profiles[0]
  if (!defaultProfile) return undefined
  if (!isOpenAIModelValue(value)) return undefined
  const raw = stripModelPrefix(value).trim()
  if (raw === '') return undefined
  if (raw === 'default') {
    // `openai:default` → 默认 profile 的真实模型名
    return defaultProfile.model ? { profile: defaultProfile, model: defaultProfile.model } : undefined
  }
  // 消歧后缀 `<前缀>:<model>@<profileId>`：仅当 @ 后段确实是已配置的 profile id 才拆分，
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
    private readonly getApiKey: OpenAITokenProvider,
    /** 埋点管线：对话路径 span 采集（可选，缺省不采集）。 */
    private readonly tracePipeline?: TracePipeline,
    /** 用户勾选的 MCP 服务 → stdio 配置（缺省 = 不注入外部 MCP）。 */
    private readonly mcpProfileResolver?: McpServiceProfileResolver,
    /** 用户勾选的 Skill → 正文（缺省 = 不注入技能；ai-sdk 无 skills 概念，正文拼进 system）。 */
    private readonly resolveSkillContent?: (names: string[]) => string | undefined
  ) {
    if (!store) throw new Error('OpenAIChatDriver requires a TaskStore')
    if (!getApiKey) throw new Error('OpenAIChatDriver requires an api key provider')
  }

  async listModels(): Promise<ChatModelInfo[]> {
    const profiles = readProfiles(this.store)
    if (profiles.length === 0) return []
    // value 携带厂商前缀与真实模型名（`<vendor>:<model>`）；同名模型配了多个 profile 时附加 `@<id>` 消歧。
    const models = profiles
      .filter((p) => p.baseUrl && p.model)
      .map((profile) => ({
        profile,
        value: `${prefixOfVendor(profile.vendor ?? detectVendor(profile.baseUrl))}:${profile.model}`
      }))
    const countByValue = new Map<string, number>()
    for (const m of models) countByValue.set(m.value, (countByValue.get(m.value) ?? 0) + 1)
    return models.map(({ profile, value }) => {
      const capabilities = capabilitiesForProfile(profile)
      return {
        value: (countByValue.get(value) ?? 0) > 1 && profile.id ? `${value}@${profile.id}` : value,
        displayName: profile.displayName || profile.model || 'OpenAI-Compatible',
        /** 厂商 id（前端据此查 MODEL_VENDORS 展示厂商名，如「DeepSeek 官方」）。 */
        vendor: profile.vendor ?? detectVendor(profile.baseUrl),
        isDefault: profile.isDefault === true,
        ...(capabilities.length ? { capabilities } : {})
      }
    })
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
    // 失效 value（profile 已删除 / 历史占位值无法匹配）→ 回落默认 profile，不直接报错。
    const resolved =
      resolveProfileForValue(profiles, input.model) ??
      (() => {
        const fallback = profiles.find((p) => p.isDefault) ?? profiles[0]
        return fallback?.baseUrl && fallback.model ? { profile: fallback, model: fallback.model } : undefined
      })()
    if (!resolved) throw new Error(`未知的 OpenAI 模型: ${input.model}`)
    const profile = resolved.profile
    const modelName = resolved.model
    if (!profile.baseUrl) throw new Error(`未知的 OpenAI 模型: ${input.model}`)

    const apiKey = (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined) ?? this.getApiKey(profile)
    // 按厂商选 ai-sdk provider 包：deepseek/openai 官方端点用专用包（reasoning/structured outputs 等
    // 官方能力），未知端点回落 openai-compatible。vendor 未配置时按 baseUrl 主机名自动识别。
    const vendor = profile.vendor ?? detectVendor(profile.baseUrl)
    const model = createVendorModel(vendor, { baseUrl: profile.baseUrl, apiKey }, modelName)

    const taskSource = input.toolSource
    const tools = taskSource ? buildAiTools(taskSource) : undefined
    // 用户勾选的 MCP 服务：McpClient 连上后桥接成 ai-sdk 工具（JSON Schema 直接透传，
    // 不做 zod 转换）。独立于 taskSource 注入——纯对话也可能只挂 MCP 工具。
    // 单个服务连接失败跳过该服务（不阻断对话）；全部客户端在流收尾时统一 close。
    const mcpClients: McpClient[] = []
    let mergedTools: Record<string, ReturnType<typeof aiTool>> | undefined = tools
    if (input.mcpServices?.length && this.mcpProfileResolver) {
      const bridged: Record<string, ReturnType<typeof aiTool>> = {}
      for (const serviceId of input.mcpServices) {
        const mcpProfile = this.mcpProfileResolver(serviceId)
        if (!mcpProfile) continue
        const client = new McpClient(mcpProfile)
        try {
          const listed = (await client.listTools()) as Array<{
            name?: string
            description?: string
            inputSchema?: unknown
          }>
          for (const def of listed) {
            const toolName = def.name
            if (!toolName) continue
            bridged[toolName] = aiTool({
              description: def.description,
              inputSchema: jsonSchema((def.inputSchema ?? { type: 'object', properties: {} }) as never) as never,
              execute: async (args) => client.callTool(toolName, (args ?? {}) as Record<string, unknown>)
            }) as unknown as ReturnType<typeof aiTool>
          }
          mcpClients.push(client)
        } catch {
          client.close()
        }
      }
      if (Object.keys(bridged).length) mergedTools = { ...(mergedTools ?? {}), ...bridged }
    }
    // ai-sdk 7 起 system 内容必须走 `system` 选项,messages 里不允许 system 角色:
    // 合并「工作目录 + 历史 system + 任务工具 systemPrompt」三段,统一从选项传入。
    const { messages, systemText } = historyToModelMessages(input.history)
    const system = [
      input.cwd ? `当前工作目录: ${input.cwd}` : '',
      systemText,
      taskSource ? taskSource.systemPrompt() : '',
      input.skills?.length && this.resolveSkillContent ? this.resolveSkillContent(input.skills) : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    // 当前用户消息已由编排层（ChatService）写入 history（history 末尾即本条提问）：
    // 直接 push 会造成 prompt 里两条一模一样的 user 消息，这里只在确实缺失时才追加。
    const last = messages.at(-1)
    const alreadyHasCurrentInput =
      last?.role === 'user' && typeof last.content === 'string' && last.content === input.userInput.text
    if (!alreadyHasCurrentInput) messages.push({ role: 'user', content: input.userInput.text })

    const parts: DriverPart[] = []
    let taskCreated: ChatTaskCreationResult | undefined
    let streamUsage: ChatUsage | undefined
    // 流正常结束时 fullStream 一定会产出 finish chunk；若底层连接静默断开（无 error chunk、
    // 无异常），for-await 会直接结束。用 sawFinish 兜底检测，避免「半截回复 + 显示成功」。
    let sawFinish = false

    // 对话 trace：对话级 traceId（一个对话 = 一个 Trace）。主对话由 ChatService 传 traceId（join），
    // 辅助 LLM 调用（关键词提取/记忆整理）也 join 同一回合；无 traceId 时自建独立 trace。
    const traceId = input.traceId ?? `chat-${input.conversationId}-${input.userInput.id}`
    const join = Boolean(input.traceId)
    const traceTools = new Map<string, AgentSpan>()
    // llm span 按 ai-sdk step 边界切分：start-step 创建 / finish-step 收尾，
    // 每轮 API 调用一个 span——不再用一个覆盖全程的巨 span（多步工具循环下
    // 时序与层级都失真：一次循环只产出一个 llm 巨 span，同批工具挂栈顶互嵌）。
    let stepLlm: AgentSpan | undefined
    let stepText: string[] = []
    let stepIndex = 0
    if (this.tracePipeline) {
      if (join) {
        this.tracePipeline.ensureActive({
          traceId,
          kind: 'chat',
          title: input.userInput.text.slice(0, 80),
          source: 'openai',
          agentName: 'OpenAI',
          model: modelName
        })
      } else {
        this.tracePipeline.beginTrace({
          traceId,
          kind: 'chat',
          title: input.userInput.text.slice(0, 80),
          source: 'openai',
          agentName: 'OpenAI',
          model: modelName
        })
        this.tracePipeline.startSpan(traceId, { type: 'session.start', name: '对话', meta: { source: 'openai' } })
      }
    }

    // 运行时模型参数（推理力度 / 思考开关 / 最大输出 Token）→ 按 vendor 翻译成 providerOptions。
    const providerOptions = buildProviderOptions(vendor, input.modelParams)

    const result = streamText({
      model,
      messages,
      abortSignal: input.signal,
      ...(system ? { system } : {}),
      ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
      // 任务工具与 MCP 桥接工具合并注入；只有 MCP 工具（无 taskSource）时同样启用多步循环。
      ...(mergedTools ? { tools: mergedTools, stopWhen: stepCountIs(10) } : {})
    })

    try {
      for await (const chunk of result.fullStream) {
        if (input.signal.aborted) return
        // chunk.type 是 TextStreamPart 的 type 字段
        if (chunk.type === 'start-step') {
          // 每个 step = 一轮 API 调用：起一个 llm.generate span。
          // 首步记录完整 input（messages + system）；后续步的 input 是上一轮的
          // tool-result 回填，全量落库冗余且体积大，省略。
          if (this.tracePipeline) {
            stepLlm = this.tracePipeline.startSpan(traceId, {
              type: 'llm.generate',
              // 辅助调用（关键词提取/记忆整理）用语义名，模型仍在 model 字段（tooltip/指标用）。
              // traceLabel 同步落 meta：读时转换（spansToAgentEvents 标题 / Waterfall 标签）
              // 只认 meta.traceLabel，仅写 span.name 会导致执行 Tab 回退成「LLM 调用 · 模型名」。
              name: input.traceLabel ?? modelName,
              model: modelName,
              ...(stepIndex === 0 ? { input: { messages, system } } : {}),
              meta: { source: 'openai', stepIndex, ...(input.traceLabel ? { traceLabel: input.traceLabel } : {}) }
            })
            stepText = []
            stepIndex += 1
          }
        } else if (chunk.type === 'finish-step') {
          const step = chunk as unknown as {
            usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
            finishReason?: string
          }
          if (this.tracePipeline && stepLlm) {
            const u = step.usage
            const hasUsage = Boolean(u && ((u.inputTokens ?? 0) > 0 || (u.outputTokens ?? 0) > 0))
            this.tracePipeline.endSpan(traceId, stepLlm, {
              ...(stepText.length > 0 ? { output: stepText.join('') } : {}),
              ...(hasUsage && u
                ? {
                    usage: {
                      inputTokens: u.inputTokens ?? 0,
                      outputTokens: u.outputTokens ?? 0,
                      totalTokens: u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
                    }
                  }
                : {}),
              status: step.finishReason === 'error' ? 'error' : 'completed'
            })
            stepLlm = undefined
          }
        } else if (chunk.type === 'text-delta' && 'text' in chunk && chunk.text) {
          const part: DriverPart = { driverId: 'openai', type: 'text', text: chunk.text }
          parts.push(part)
          if (stepText.length < 20000) stepText.push(chunk.text)
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
          if (this.tracePipeline) {
            const toolSpan = this.tracePipeline.startSpan(traceId, {
              type: 'tool.execute',
              name: tc.toolName,
              input: tc.input,
              // 显式父级：挂当前 step 的 llm span，不挂栈顶——
              // 挂栈顶会让同批并发工具逐个嵌套（后发的工具挂到前一个未收尾的工具下）。
              parentSpanId: stepLlm?.spanId,
              meta: { source: 'openai', toolCallId: tc.toolCallId }
            })
            traceTools.set(tc.toolCallId, toolSpan)
          }
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
          if (this.tracePipeline) {
            const toolSpan = traceTools.get(tr.toolCallId)
            if (toolSpan) {
              traceTools.delete(tr.toolCallId)
              this.tracePipeline.endSpan(traceId, toolSpan, { output: tr.output })
            }
          }
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
          // 捕获总用量：ai-sdk 7 的 finish chunk 字段是 `totalUsage`（各 step 累计；
          // 单 step 的 usage 已在 finish-step 落到对应 llm span）。这里只用于 done chunk
          // 带回给 ChatService 持久化兜底，不再建覆盖全程的巨 span。
          // finishReason=error 视为流异常结束。
          if ('finishReason' in chunk && chunk.finishReason === 'error') {
            throw new Error('模型流式输出异常结束（finish_reason: error）')
          }
          const u = (chunk as { totalUsage?: unknown }).totalUsage as
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
      if (this.tracePipeline && stepLlm && !input.signal.aborted) {
        this.tracePipeline.endSpan(traceId, stepLlm, {
          status: 'error',
          error: { message: error instanceof Error ? error.message : String(error) }
        })
        stepLlm = undefined
      }
      if (!input.signal.aborted) throw error
    } finally {
      // MCP 客户端统一关闭（stdio 子进程）；无论成功 / 失败 / abort。
      for (const client of mcpClients) client.close()
      // 对话 trace 收尾：无论成功 / 失败 / abort 都 finalize。
      if (this.tracePipeline) {
        for (const toolSpan of traceTools.values()) {
          this.tracePipeline.endSpan(traceId, toolSpan, { status: 'cancelled' })
        }
        traceTools.clear()
        // 当前 step span 未正常收尾（abort / 流静默断开）时的兜底：
        // finish-step 未到达，step usage 不可得，用 finish chunk 的总用量兜底。
        if (stepLlm && stepLlm.status === 'started') {
          this.tracePipeline.endSpan(traceId, stepLlm, {
            ...(stepText.length > 0 ? { output: stepText.join('') } : {}),
            usage: streamUsage
              ? {
                  inputTokens: streamUsage.inputTokens,
                  outputTokens: streamUsage.outputTokens,
                  totalTokens: streamUsage.totalTokens,
                  ...(streamUsage.costUsd ? { costUsd: streamUsage.costUsd } : {})
                }
              : undefined,
            status: input.signal.aborted ? 'cancelled' : 'completed'
          })
          stepLlm = undefined
        }
        // join 模式：trace 生命周期由回合层（ChatService）统一 endTrace。
        if (!join) this.tracePipeline.endTrace(traceId)
      }
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
