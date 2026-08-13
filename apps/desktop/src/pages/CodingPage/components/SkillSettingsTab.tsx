/**
 * 系统设置 → Skill Tab
 *
 * 管理 dataDir/skills 下的技能（Agent Skills 标准：<name>/SKILL.md）：
 * - 卡片网格展示名称 / description / 来源徽标（文件夹 | ZIP）/ 删除；
 * - 「从文件夹添加」「导入 ZIP」走系统文件选择（主进程 dialog），失败原因回显；
 * - 对话区 Skill 选择器从这里读取列表。
 */

import { useEffect, useState } from 'react'
import { FileArchiveIcon, FolderOpenIcon, Loader2Icon, Trash2Icon } from 'lucide-react'
import { api, type SkillInfo } from '@/api'
import { useFeedback } from '@/hooks/useGlobalFeedback'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export function SkillSettingsTab() {
  const { showError, showSuccess } = useFeedback()
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState<'zip' | 'folder' | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<SkillInfo | undefined>(undefined)

  const load = async () => {
    try {
      setSkills(await api.listSkills())
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const importZip = async () => {
    setImporting('zip')
    try {
      const skill = await api.importSkillZip()
      if (skill) {
        showSuccess(`已导入技能「${skill.name}」`)
        setSkills(await api.listSkills())
      }
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setImporting(undefined)
    }
  }

  const importFolder = async () => {
    setImporting('folder')
    try {
      const skill = await api.importSkillFolder()
      if (skill) {
        showSuccess(`已导入技能「${skill.name}」`)
        setSkills(await api.listSkills())
      }
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setImporting(undefined)
    }
  }

  const removeSkill = async () => {
    if (!deleteTarget) return
    try {
      setSkills(await api.deleteSkill(deleteTarget.name))
      showSuccess('已删除')
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
    setDeleteTarget(undefined)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-foreground">Skill 技能</h3>
          <p className="text-[11px] leading-5 text-muted-foreground">
            技能 = 含 SKILL.md（frontmatter name/description）的文件夹，支持从本地文件夹或 ZIP 导入； 导入后在对话区
            Skill 选择器中多选启用。
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="secondary" disabled={importing !== undefined} onClick={() => void importFolder()}>
            {importing === 'folder' ? (
              <Loader2Icon className="animate-spin-slow" size={11} />
            ) : (
              <FolderOpenIcon size={11} />
            )}
            {importing === 'folder' ? '导入中' : '从文件夹添加'}
          </Button>
          <Button size="sm" variant="secondary" disabled={importing !== undefined} onClick={() => void importZip()}>
            {importing === 'zip' ? (
              <Loader2Icon className="animate-spin-slow" size={11} />
            ) : (
              <FileArchiveIcon size={11} />
            )}
            {importing === 'zip' ? '导入中' : '导入 ZIP'}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="grid place-items-center py-10 text-xs text-muted-foreground">
          <Loader2Icon className="animate-spin-slow" size={14} />
        </div>
      ) : skills.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          还没有技能，点击上方按钮导入第一个 Skill。
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {skills.map((skill) => (
            <article
              key={skill.name}
              className="group flex items-center justify-between gap-2 rounded-md border bg-card/40 px-3 py-2.5"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                  {skill.source === 'zip' ? <FileArchiveIcon size={14} /> : <FolderOpenIcon size={14} />}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <h4 className="truncate text-xs font-semibold text-foreground">{skill.name}</h4>
                    <Badge variant="secondary" className="shrink-0 text-[9px]">
                      {skill.source === 'zip' ? 'ZIP' : '文件夹'}
                    </Badge>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{skill.description}</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`删除技能 ${skill.name}`}
                className="shrink-0 text-destructive opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
                onClick={() => setDeleteTarget(skill)}
              >
                <Trash2Icon size={11} />
              </Button>
            </article>
          ))}
        </div>
      )}

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除技能？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{deleteTarget?.name}」及其文件（dataDir/skills/{deleteTarget?.name}），删除后无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void removeSkill()}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
