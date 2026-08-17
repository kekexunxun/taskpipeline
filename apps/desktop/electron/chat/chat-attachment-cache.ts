/**
 * 对话附件本地缓存。
 *
 * 用户在 PromptInput 里添加的图片 / 文件先由渲染进程通过 IPC 发到这里，
 * 写入 `dataDir/chat-attachments/{chatId}/{uuid}-{filename}`，返回
 * `{ localPath, mediaType, filename, size }` 供后续链路（driver → API）按路径读取。
 *
 * 设计要点：
 *  - 渲染进程不再把文件转 base64 data URL，避免 IPC 序列化大体积字符串；
 *  - 对话删除时调 `deleteAttachments(chatId)` 清理整个目录；
 *  - 文件名前加 uuid 防冲突（同名文件多次上传不会覆盖）。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type UserFileAttachment = {
  /** 本地缓存绝对路径。 */
  localPath: string
  /** IANA media type（如 `image/png`）。空字符串表示未知。 */
  mediaType: string
  /** 原始文件名。 */
  filename?: string
  /** 字节数。 */
  size: number
}

export class ChatAttachmentCache {
  private readonly root: string

  constructor(dataDir: string) {
    this.root = join(dataDir, 'chat-attachments')
    mkdirSync(this.root, { recursive: true })
  }

  /**
   * 保存一个附件到本地缓存。
   * @param chatId 对话 id（用于目录隔离）
   * @param buffer 文件原始字节
   * @param filename 原始文件名
   * @param mediaType IANA media type
   */
  saveAttachment(chatId: string, buffer: Buffer, filename: string, mediaType: string): UserFileAttachment {
    const dir = join(this.root, chatId)
    mkdirSync(dir, { recursive: true })
    const safeName = (filename ?? 'attachment').replace(/[<>:"|?*]/g, '_')
    const localPath = join(dir, `${randomUUID()}-${safeName}`)
    writeFileSync(localPath, buffer)
    return {
      localPath,
      mediaType,
      filename,
      size: buffer.byteLength
    }
  }

  /** 读取附件内容为 Buffer（driver 发 API 前调用）。 */
  readAttachment(localPath: string): Buffer {
    return readFileSync(localPath)
  }

  /** 清理某个对话的全部附件。 */
  deleteAttachments(chatId: string): void {
    const dir = join(this.root, chatId)
    if (!existsSync(dir)) return
    rmSync(dir, { recursive: true, force: true })
  }

  /** 检查附件文件是否存在。 */
  exists(localPath: string): boolean {
    return existsSync(localPath)
  }
}
