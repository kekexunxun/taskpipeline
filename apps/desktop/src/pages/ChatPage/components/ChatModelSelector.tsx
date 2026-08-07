import { useState } from 'react'
import { CheckIcon, ChevronDownIcon, CpuIcon, SparklesIcon } from 'lucide-react'
import type { ChatModelGroup } from '@/api'
import { Button } from '@/components/ui/button'
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger
} from '@/components/ai-elements/model-selector'
import { ModelBadges } from '@/components/ModelBadges'
import { cn } from '@/lib/utils'

/**
 * 模型选择器：直接基于 ai-elements 的 ModelSelector + Command。
 * 触发按钮采用 11px 紧凑样式（与 ChatComposer 工具栏同高），下拉项紧凑。
 *
 * 纯受控：value 为空（含 undefined / 不在 groups 中的旧值）时按钮统一显示 "Auto"，
 * 下拉项 isActive 同样以 value 为准；调用方需自行决定是否在挂载时把默认模型写回 value，
 * 避免在组件内部偷偷调用 onChange 造成渲染期副作用与父子状态打架。
 */
export function ChatModelSelector({
  groups,
  value,
  onChange,
  disabled
}: {
  groups: ChatModelGroup[]
  value?: string
  onChange(value: string | undefined): void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const flat = groups.flatMap((group) =>
    group.models.map((model) => ({ ...model, driverId: group.driverId, driverDisplayName: group.displayName }))
  )
  // 严格受控：仅当 value 能匹配到模型时才有 current；不再回退到 isDefault，
  // 否则会导致「按钮显示默认名 / 下拉无勾选 / 调用方 value 仍为 undefined」的三方不一致。
  const current = value ? flat.find((model) => model.value === value) : undefined
  const hasModels = flat.length > 0

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || !hasModels}
          className="h-6 gap-1 px-1.5 font-normal text-muted-foreground hover:text-foreground"
          aria-label="选择模型"
        >
          <CpuIcon size={10} className="opacity-70" />
          <span className="max-w-32 truncate">{current?.displayName ?? value ?? 'Auto'}</span>
          <ChevronDownIcon size={9} className="opacity-70" />
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent
        title="选择模型"
        className="w-[min(420px,calc(100vw-40px))] border bg-popover text-sm text-popover-foreground"
      >
        <ModelSelectorInput placeholder="搜索模型…" />
        <ModelSelectorList>
          <ModelSelectorEmpty>未找到匹配的模型</ModelSelectorEmpty>
          {groups.map((group) => (
            <ModelSelectorGroup
              key={group.driverId}
              heading={
                <span className="inline-flex items-center gap-1">
                  {group.driverId === 'qoder' ? <SparklesIcon size={10} /> : <CpuIcon size={10} />}
                  {group.displayName}
                </span>
              }
            >
              {group.models.map((model) => {
                const isActive = model.value === value
                return (
                  <ModelSelectorItem
                    key={model.value}
                    value={model.displayName}
                    onSelect={() => {
                      onChange(model.value)
                      setOpen(false)
                    }}
                  >
                    <ModelSelectorName>{model.displayName}</ModelSelectorName>
                    <ModelBadges model={model} />
                    {model.isDefault && (
                      <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">默认</span>
                    )}
                    <CheckIcon
                      size={11}
                      className={cn('ml-auto text-foreground', isActive ? 'opacity-100' : 'opacity-0')}
                    />
                  </ModelSelectorItem>
                )
              })}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  )
}
