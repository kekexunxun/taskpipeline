import { afterEach, describe, expect, it, vi } from 'vitest'
import { ElectronChatTransport } from './chat-transport'
import { api, type ChatStreamEvent } from '@/api'

const original = { start: api.startChatStream, abort: api.abortChat, listen: api.onChatStreamEvent }
afterEach(() => {
  api.startChatStream = original.start
  api.abortChat = original.abort
  api.onChatStreamEvent = original.listen
  vi.restoreAllMocks()
})

describe('ElectronChatTransport', () => {
  it('subscribes before starting, filters foreign events, and closes on done', async () => {
    const order: string[] = []
    let listener: ((event: ChatStreamEvent) => void) | undefined
    api.onChatStreamEvent = (callback) => {
      order.push('subscribe')
      listener = callback
      return () => order.push('unsubscribe')
    }
    api.startChatStream = vi.fn(async (input) => {
      order.push('start')
      listener?.({
        streamId: 'foreign',
        chatId: input.chatId,
        driverId: input.driverId,
        chunk: { type: 'part', part: { driverId: 'qoder', type: 'text', text: 'bad' } }
      })
      listener?.({
        streamId: input.streamId,
        chatId: input.chatId,
        driverId: input.driverId,
        chunk: { type: 'part', part: { driverId: 'qoder', type: 'text', text: 'ok' } }
      })
      listener?.({ streamId: input.streamId, chatId: input.chatId, driverId: input.driverId, done: true })
    })
    const events: ChatStreamEvent[] = []
    const session = new ElectronChatTransport().start({
      streamId: 'stream-1',
      chatId: 'chat-a',
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() },
      onEvent: (event) => events.push(event)
    })
    await session.closed
    expect(order).toEqual(['subscribe', 'start', 'unsubscribe'])
    // 第一个 part (foreign streamId) 被过滤,只剩 "ok" part + done
    expect(events.map((e) => e.chunk?.type)).toEqual(['part', undefined])
    // 确认留下来的是 "ok" 文本
    const okEvent = events[0]
    expect(okEvent?.chunk?.type).toBe('part')
    if (okEvent?.chunk?.type === 'part' && okEvent.chunk.part.type === 'text') {
      expect(okEvent.chunk.part.text).toBe('ok')
    }
  })

  it('aborts the matching stream when session.abort is called', async () => {
    let listener: ((event: ChatStreamEvent) => void) | undefined
    api.onChatStreamEvent = (callback) => {
      listener = callback
      return () => undefined
    }
    api.startChatStream = vi.fn(async () => undefined)
    api.abortChat = vi.fn(async () => undefined)
    const session = new ElectronChatTransport().start({
      streamId: 'stream-2',
      chatId: 'chat-a',
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() },
      onEvent: () => undefined
    })
    session.abort()
    expect(api.abortChat).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat-a' }))
    // 主动 abort 后没有 done 事件,关闭通过我们手动 close
    void listener
  })

  it('forwards task creation mode to the Electron agent', async () => {
    let listener: ((event: ChatStreamEvent) => void) | undefined
    api.onChatStreamEvent = (callback) => {
      listener = callback
      return () => undefined
    }
    api.startChatStream = vi.fn(async (input) => {
      listener?.({ streamId: input.streamId, chatId: input.chatId, driverId: input.driverId, done: true })
    })
    const session = new ElectronChatTransport().start({
      streamId: 'stream-3',
      chatId: 'chat-a',
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'create', createdAt: new Date().toISOString() },
      mode: 'task-create',
      onEvent: () => undefined
    })
    await session.closed
    expect(api.startChatStream).toHaveBeenCalledWith(expect.objectContaining({ mode: 'task-create' }))
  })

  it('surfaces stream errors via onError callback', async () => {
    let listener: ((event: ChatStreamEvent) => void) | undefined
    api.onChatStreamEvent = (callback) => {
      listener = callback
      return () => undefined
    }
    api.startChatStream = vi.fn(async () => undefined)
    const errors: Error[] = []
    const session = new ElectronChatTransport().start({
      streamId: 'stream-err',
      chatId: 'chat-a',
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
      onEvent: () => undefined,
      onError: (e) => errors.push(e)
    })
    listener?.({ streamId: 'stream-err', chatId: 'chat-a', driverId: 'qoder', error: 'boom' })
    await session.closed
    expect(errors.map((e) => e.message)).toEqual(['boom'])
  })

  it("surfaces chunk errors (type: 'error') via onError callback", async () => {
    let listener: ((event: ChatStreamEvent) => void) | undefined
    api.onChatStreamEvent = (callback) => {
      listener = callback
      return () => undefined
    }
    api.startChatStream = vi.fn(async () => undefined)
    const errors: Error[] = []
    const events: ChatStreamEvent[] = []
    const session = new ElectronChatTransport().start({
      streamId: 'stream-chunk-err',
      chatId: 'chat-a',
      driverId: 'openai',
      model: 'gpt-4o',
      message: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
      onEvent: (event) => events.push(event),
      onError: (e) => errors.push(e)
    })
    // 主进程只发 chunk 形态的错误(顶层 error 从不出现)
    listener?.({
      streamId: 'stream-chunk-err',
      chatId: 'chat-a',
      driverId: 'openai',
      chunk: { type: 'error', message: 'connection refused' }
    })
    await session.closed
    expect(errors.map((e) => e.message)).toEqual(['connection refused'])
    // error chunk 不转发给 onEvent
    expect(events).toEqual([])
  })
})
