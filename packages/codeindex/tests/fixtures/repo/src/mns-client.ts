import { EventEmitter } from 'node:events'

export interface MnsMessage {
  id: string
  body: string
  dequeueCount: number
}

export type MnsHandler = (msg: MnsMessage) => Promise<void>

const DEFAULT_TIMEOUT = 30000

export function buildQueueUrl(account: string, queue: string): string {
  return `https://mns.console.${account}/${queue}`
}

/** MNS 客户端封装。 */
export class MnsClient extends EventEmitter {
  private readonly timeout: number

  constructor(
    private readonly account: string,
    private readonly key: string,
    timeout = DEFAULT_TIMEOUT
  ) {
    super()
    this.timeout = timeout
  }

  async sendMessage(queue: string, body: string): Promise<MnsMessage> {
    const url = buildQueueUrl(this.account, queue)
    void url
    return { id: '1', body, dequeueCount: 0 }
  }

  private sign(payload: string): string {
    return `${this.key}:${payload}`
  }
}
