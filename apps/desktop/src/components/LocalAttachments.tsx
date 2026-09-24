import { useEffect, useState } from 'react'
import { FileIcon, ImageIcon } from 'lucide-react'
import { api, type UserFileAttachment } from '@/api'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

export type LocalFileAttachment = Omit<UserFileAttachment, 'size'> & { size?: number }

/** 消息与 Trace 共用本地附件预览，不依赖开发/生产页面的 file:// 访问权限。 */
export function LocalAttachments({ files }: { files: LocalFileAttachment[] }) {
  if (!files.length) return null
  return (
    <div className="flex max-w-full flex-wrap gap-2 whitespace-normal" aria-label="消息附件">
      {files.map((file, index) => (
        <LocalAttachment key={`${file.localPath}:${file.mediaType}:${index}`} file={file} />
      ))}
    </div>
  )
}

function LocalAttachment({ file }: { file: LocalFileAttachment }) {
  const [url, setUrl] = useState<string>()
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState(false)
  const isImage = file.mediaType.startsWith('image/')
  const label = file.filename || (isImage ? '图片附件' : '文件附件')

  useEffect(() => {
    if (!isImage) return
    let cancelled = false
    void (async () => {
      try {
        const preview = await api.previewChatImage(file.localPath, file.mediaType)
        if (cancelled) return
        if (preview) setUrl(preview)
        else setError('图片文件已不存在')
      } catch {
        if (!cancelled) setError('图片无法预览')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [file.localPath, file.mediaType, isImage])

  if (!isImage || !url || error) {
    const Icon = isImage ? ImageIcon : FileIcon
    return (
      <div className="flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-xs">
        <Icon size={16} className="shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate" title={label}>
            {label}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {isImage
              ? error || '图片加载中…'
              : file.size !== undefined
                ? `${Math.max(1, Math.ceil(file.size / 1024))} KB`
                : '文件附件'}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <button
        type="button"
        aria-label={`预览图片：${label}`}
        className="overflow-hidden rounded-lg border border-border/60 bg-background/50 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen(true)}
      >
        <img
          src={url}
          alt={label}
          className="h-28 max-w-full object-contain"
          onError={() => setError('图片无法预览')}
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] w-auto max-w-[90vw] p-3 pt-9" aria-describedby={undefined}>
          <DialogTitle className="sr-only">{label}</DialogTitle>
          <img src={url} alt={label} className="max-h-[80vh] max-w-full object-contain" />
        </DialogContent>
      </Dialog>
    </>
  )
}
