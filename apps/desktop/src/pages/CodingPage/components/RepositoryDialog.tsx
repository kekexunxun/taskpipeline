import { useEffect, useState } from 'react'
import { FolderOpenIcon, Loader2Icon, SaveIcon } from 'lucide-react'
import type { RepositoryProfile } from '@task-pipeline/core'
import { api } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldGroup } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

export type RepoDraft = Omit<RepositoryProfile, 'id'> & { id?: string }
const empty: RepoDraft = { name: '', localPath: '', remoteUrl: '', defaultBranch: 'main' }

export function RepositoryDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
  onError
}: {
  open: boolean
  onOpenChange(open: boolean): void
  initial?: RepoDraft
  onSaved(profile: RepositoryProfile): void
  onError?(reason: unknown): void
}) {
  const [draft, setDraft] = useState<RepoDraft>(initial ?? empty)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) setDraft(initial ?? empty)
  }, [initial, open])
  const update = <K extends keyof RepoDraft>(key: K, value: RepoDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))
  const pickFolder = async () => {
    try {
      const folder = await api.chooseRepositoryFolder()
      if (folder) setDraft((current) => ({ ...current, ...folder }))
    } catch (reason) {
      onOpenChange(false)
      onError?.(reason)
    }
  }
  const save = async () => {
    setSaving(true)
    try {
      const profile: RepositoryProfile = {
        id: draft.id ?? crypto.randomUUID(),
        name: draft.name.trim(),
        localPath: draft.localPath.trim(),
        remoteUrl: draft.remoteUrl?.trim() || undefined,
        defaultBranch: draft.defaultBranch.trim() || 'main',
        setupCommand: draft.setupCommand?.trim() || undefined,
        lintCommand: draft.lintCommand?.trim() || undefined,
        testCommand: draft.testCommand?.trim() || undefined,
        buildCommand: draft.buildCommand?.trim() || undefined
      }
      await api.saveRepository(profile)
      onSaved(profile)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(560px,calc(100vw-48px))]">
        <DialogHeader>
          <DialogTitle>{draft.id ? '编辑仓库' : '新增仓库'}</DialogTitle>
          <DialogDescription>仓库路径、Git remote 和默认分支会从本地 Git 仓库读取。</DialogDescription>
        </DialogHeader>
        <FieldGroup className="grid-cols-2 gap-3 overflow-y-auto px-1 py-1">
          <Field className="col-span-2" label="名称">
            <Input value={draft.name} onChange={(event) => update('name', event.target.value)} />
          </Field>
          <Field className="col-span-2" label="默认分支">
            <Input value={draft.defaultBranch} onChange={(event) => update('defaultBranch', event.target.value)} />
          </Field>
          <Field className="col-span-2" label="本地路径">
            <div className="flex gap-2">
              <Input
                value={draft.localPath}
                onChange={(event) => update('localPath', event.target.value)}
                placeholder="/Users/me/projects/foo"
              />
              <Button variant="secondary" size="sm" onClick={() => void pickFolder()}>
                <FolderOpenIcon size={11} />
                选择文件夹
              </Button>
            </div>
          </Field>
          <Field className="col-span-2" label="Remote URL">
            <Input
              value={draft.remoteUrl ?? ''}
              onChange={(event) => update('remoteUrl', event.target.value)}
              placeholder="可选，留空可后续再配置"
            />
          </Field>
          <Field className="col-span-2" label="准备命令">
            <Textarea
              value={draft.setupCommand ?? ''}
              onChange={(event) => update('setupCommand', event.target.value || undefined)}
              placeholder="例如 npm install"
            />
          </Field>
          <Field label="Lint 命令">
            <Input
              value={draft.lintCommand ?? ''}
              onChange={(event) => update('lintCommand', event.target.value || undefined)}
              placeholder="例如 npm run lint"
            />
          </Field>
          <Field label="Test 命令">
            <Input
              value={draft.testCommand ?? ''}
              onChange={(event) => update('testCommand', event.target.value || undefined)}
              placeholder="例如 npm test"
            />
          </Field>
          <Field className="col-span-2" label="Build 命令">
            <Input
              value={draft.buildCommand ?? ''}
              onChange={(event) => update('buildCommand', event.target.value || undefined)}
              placeholder="例如 npm run build"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" size="sm">
              取消
            </Button>
          </DialogClose>
          <Button
            size="sm"
            disabled={saving || !draft.name.trim() || !draft.localPath.trim()}
            onClick={() => void save()}
          >
            {saving ? <Loader2Icon className="animate-spin-slow" size={11} /> : <SaveIcon size={11} />}
            {saving ? '保存中' : '保存仓库'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function McpProfileDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange(open: boolean): void
  onSaved(): void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>MCP Profile</DialogTitle>
          <DialogDescription>请通过 settings.json 维护 mcpProfiles 字段。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" size="sm">
              关闭
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function TestButton({ kind, label }: { kind: 'jira' | 'confluence' | 'gitlab'; label: string }) {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string }>()
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        disabled={running}
        onClick={async () => {
          setRunning(true)
          try {
            setResult(kind === 'gitlab' ? await api.testGitlabMcp() : await api.testAtlassian(kind))
          } finally {
            setRunning(false)
          }
        }}
      >
        {running && <Loader2Icon className="animate-spin-slow" size={11} />}
        {running ? '测试中' : label}
      </Button>
      {result && <Badge variant={result.ok ? 'success' : 'destructive'}>{result.message}</Badge>}
    </div>
  )
}
