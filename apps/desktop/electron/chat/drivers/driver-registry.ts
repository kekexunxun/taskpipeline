/**
 * Chat Driver 注册表。
 *
 * 上层 (ChatService / IPC handler) 通过 `driverId` 拿到具体 driver,
 * 不直接 import 任何 driver 实现 — 这样 main.ts 可以决定注册哪些 driver,
 * 单测可以塞 fake driver 进去。
 */

import type { ChatDriverId } from '../chat-types.js'
import type { ChatDriver } from './chat-driver.js'

export class ChatDriverRegistry {
  private readonly drivers = new Map<ChatDriverId, ChatDriver>()

  register(driver: ChatDriver): void {
    this.drivers.set(driver.id, driver)
  }

  get(id: ChatDriverId): ChatDriver {
    const driver = this.drivers.get(id)
    if (!driver) throw new Error(`未注册的 chat driver: ${id}`)
    return driver
  }

  tryGet(id: ChatDriverId): ChatDriver | undefined {
    return this.drivers.get(id)
  }

  list(): ChatDriver[] {
    return Array.from(this.drivers.values())
  }
}
