import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ChatAttachmentCache } from './chat-attachment-cache.js'

let root: string
let cache: ChatAttachmentCache

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-attachment-preview-'))
  cache = new ChatAttachmentCache(root)
})

describe('附件缓存图片预览', () => {
  it('读取已保存图片为 data URL，不修改缓存内容', async () => {
    const data = Buffer.from('image-content')
    const file = cache.saveAttachment('chat-1', data, '截图.png', 'image/png')
    expect(await cache.previewImage(file.localPath, file.mediaType)).toBe(
      `data:image/png;base64,${data.toString('base64')}`
    )
    expect(cache.readAttachment(file.localPath)).toEqual(data)
  })

  it('已删除或缺失的附件返回 undefined', async () => {
    expect(
      await cache.previewImage(join(root, 'chat-attachments', 'chat-1', 'missing.png'), 'image/png')
    ).toBeUndefined()
  })

  it('拒绝目录遍历、相对路径和名称前缀相同的其它目录', async () => {
    for (const path of [
      join(root, 'private.png'),
      '../private.png',
      join(root, 'chat-attachments-other', 'private.png')
    ]) {
      await expect(cache.previewImage(path, 'image/png')).rejects.toThrow('附件路径不在缓存目录内')
    }
  })

  it('拒绝缓存内部指向外部文件的符号链接', async () => {
    const outside = join(root, 'private')
    const link = join(root, 'chat-attachments', 'linked-chat')
    mkdirSync(outside)
    writeFileSync(join(outside, 'image.png'), 'private')
    symlinkSync(outside, link, 'junction')
    await expect(cache.previewImage(join(link, 'image.png'), 'image/png')).rejects.toThrow('附件路径不在缓存目录内')
  })

  it('拒绝非图片类型和超大图片', async () => {
    const file = cache.saveAttachment('chat-1', Buffer.alloc(20 * 1024 * 1024 + 1), 'large.png', 'image/png')
    await expect(cache.previewImage(file.localPath, 'text/html')).rejects.toThrow('不支持预览此附件类型')
    await expect(cache.previewImage(file.localPath, file.mediaType)).rejects.toThrow('图片超过 20 MB')
  })
})
