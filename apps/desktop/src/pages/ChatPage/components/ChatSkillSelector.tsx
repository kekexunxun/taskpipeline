import { useEffect, useState } from 'react'
import { CheckIcon, ChevronDownIcon, Loader2Icon, SparklesIcon } from 'lucide-react'
import { api, type SkillInfo } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger
} from '@/components/ai-elements/model-selector'
import { cn } from '@/lib/utils'

/**
 * Skill 选择器：dataDir/skills 下的技能（设置页 Skill Tab 导入），可多选。
 * - 选中技能注入模型：Qoder 走 SDK `skills`（Skill(<name>) 工具 + <available_skills>），
 *   OpenAI 走 system 拼接正文（见 chat/drivers/openai-chat-driver.ts）；
 * - 底部「全选 / 全不选」；勾选/取消即时上抛但不关闭弹窗，点击「确认」才关闭。
 */
export function ChatSkillSelector({
  selected,
  onChange,
  disabled
}: {
  selected: string[]
  onChange(skills: string[]): void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void api
      .listSkills()
      .then((list) => {
        if (cancelled) return
        setSkills(list)
        // 清除已删除技能的幽灵选中。
        const valid = new Set(list.map((skill) => skill.name))
        const stale = selected.filter((name) => !valid.has(name))
        if (stale.length > 0) onChange(selected.filter((name) => valid.has(name)))
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const allSelected = skills.length > 0 && skills.every((skill) => selected.includes(skill.name))
  const toggleAll = () => {
    if (allSelected) onChange([])
    else onChange([...new Set([...selected, ...skills.map((skill) => skill.name)])])
  }

  const current = skills.find((skill) => skill.name === selected[0])

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-6 gap-1 px-1.5 font-normal text-muted-foreground hover:text-foreground"
          aria-label="选择 Skill"
        >
          <SparklesIcon size={10} className="opacity-70" />
          <span className="max-w-32 truncate">
            {selected.length === 0
              ? '无 Skill'
              : selected.length === 1
                ? (current?.name ?? 'Skill')
                : `${current?.name ?? 'Skill'} +${selected.length - 1}`}
          </span>
          <ChevronDownIcon size={9} className="opacity-70" />
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent title="选择 Skill" className="w-72 border bg-popover text-sm text-popover-foreground">
        <ModelSelectorList>
          <ModelSelectorGroup heading="Skill">
            {loading ? (
              <div className="grid place-items-center gap-1 py-3 text-[11px] text-muted-foreground">
                <Loader2Icon size={12} className="animate-spin" />
                加载中
              </div>
            ) : (
              skills.map((skill) => {
                const isActive = selected.includes(skill.name)
                return (
                  <ModelSelectorItem
                    key={skill.name}
                    value={skill.name}
                    onSelect={() => {
                      onChange(isActive ? selected.filter((name) => name !== skill.name) : [...selected, skill.name])
                    }}
                  >
                    <SparklesIcon size={12} className="opacity-70" />
                    <div className="flex min-w-0 flex-col">
                      <ModelSelectorName>{skill.name}</ModelSelectorName>
                      <span className="truncate text-[10px] text-muted-foreground">{skill.description}</span>
                    </div>
                    <Badge variant="secondary" className="ml-auto shrink-0 text-[9px]">
                      {skill.source === 'zip' ? 'ZIP' : '文件夹'}
                    </Badge>
                    <CheckIcon size={11} className={cn('text-foreground', isActive ? 'opacity-100' : 'opacity-0')} />
                  </ModelSelectorItem>
                )
              })
            )}
            {!loading && skills.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-muted-foreground">暂无技能，请到设置 → Skill 导入。</div>
            )}
          </ModelSelectorGroup>
        </ModelSelectorList>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2">
          <span className="text-[10px] text-muted-foreground">已选 {selected.length} 个</span>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={toggleAll}
              disabled={skills.length === 0}
            >
              {allSelected ? '全不选' : '全选'}
            </Button>
            <Button size="sm" className="h-6 px-2.5 text-xs" onClick={() => setOpen(false)}>
              确认
            </Button>
          </div>
        </div>
      </ModelSelectorContent>
    </ModelSelector>
  )
}
