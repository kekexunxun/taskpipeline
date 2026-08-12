import { useState } from 'react'
import { CheckIcon, ChevronDownIcon, CpuIcon, SparklesIcon } from 'lucide-react'
import type { ChatModelGroup, ModelCapability, ModelParams } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
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

const CAPABILITY_LABEL: Record<ModelCapability['key'], string> = {
  reasoningEffort: '推理力度',
  thinking: '思考模式',
  maxOutputTokens: '最大输出 Token'
}

/**
 * 当前选中模型下方的运行时参数调节区（schema 驱动，按 capabilities 渲染）。
 * 交互事件就地拦截，避免触发 CommandItem 的 onSelect（选中后关闭下拉）。
 */
function CapabilityControls({
  capabilities,
  params,
  onChange
}: {
  capabilities: ModelCapability[]
  params: ModelParams
  onChange(next: ModelParams): void
}) {
  return (
    <div className="flex flex-col gap-1.5 px-2 pt-0.5 pb-2" onPointerDown={(event) => event.stopPropagation()}>
      {capabilities.map((capability) => {
        const label = CAPABILITY_LABEL[capability.key]
        if (capability.kind === 'enum') {
          const current = typeof params[capability.key] === 'string' ? (params[capability.key] as string) : undefined
          return (
            <div key={capability.key} className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">{label}</span>
              <div className="flex items-center gap-0.5">
                {capability.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onChange({ ...params, [capability.key]: option })}
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[10px] transition-colors',
                      current === option
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          )
        }
        if (capability.kind === 'toggle') {
          return (
            <div key={capability.key} className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">{label}</span>
              <Switch
                checked={params[capability.key] === true}
                onCheckedChange={(next) => onChange({ ...params, [capability.key]: next })}
                className="h-4 w-7 data-[state=checked]:bg-primary [&>span]:size-3 data-[state=checked]:[&>span]:translate-x-3"
              />
            </div>
          )
        }
        // kind === 'number'：留空 = 不设置（driver 用自身默认）。
        const numeric = typeof params[capability.key] === 'number' ? (params[capability.key] as number) : undefined
        return (
          <div key={capability.key} className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">{label}</span>
            <Input
              type="number"
              min={1}
              max={capability.max}
              value={numeric ?? ''}
              placeholder="默认"
              className="h-6 w-24 px-1.5 text-[10px]"
              onChange={(event) => {
                const raw = event.target.value
                if (raw === '') {
                  const next = { ...params }
                  delete next[capability.key]
                  onChange(next)
                  return
                }
                const parsed = Number(raw)
                if (!Number.isNaN(parsed) && parsed > 0) onChange({ ...params, [capability.key]: parsed })
              }}
            />
          </div>
        )
      })}
    </div>
  )
}

/**
 * 模型选择器：直接基于 ai-elements 的 ModelSelector + Command。
 * 触发按钮采用 11px 紧凑样式（与 ChatComposer 工具栏同高），下拉项紧凑。
 *
 * 纯受控：value 为空（含 undefined / 不在 groups 中的旧值）时按钮统一显示 "Auto"，
 * 下拉项 isActive 同样以 value 为准；调用方需自行决定是否在挂载时把默认模型写回 value，
 * 避免在组件内部偷偷调用 onChange 造成渲染期副作用与父子状态打架。
 *
 * 参数调节：选中模型声明了 capabilities 且传入 onChangeParams 时，在该条目下方渲染内联控件，
 * 值经 onChangeParams 上抛（与 model value 一起按对话持久化）。
 */
export function ChatModelSelector({
  groups,
  value,
  onChange,
  modelParams,
  onChangeParams,
  disabled
}: {
  groups: ChatModelGroup[]
  value?: string
  onChange(value: string | undefined): void
  modelParams?: ModelParams
  onChangeParams?(params: ModelParams): void
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
                  <div key={model.value}>
                    <ModelSelectorItem
                      value={model.displayName}
                      onSelect={() => {
                        onChange(model.value)
                        setOpen(false)
                      }}
                    >
                      <ModelSelectorName>{model.displayName}</ModelSelectorName>
                      <ModelBadges model={model} />
                      {model.isDefault && (
                        <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">
                          默认
                        </span>
                      )}
                      <CheckIcon
                        size={11}
                        className={cn('ml-auto text-foreground', isActive ? 'opacity-100' : 'opacity-0')}
                      />
                    </ModelSelectorItem>
                    {isActive && model.capabilities?.length && onChangeParams ? (
                      <CapabilityControls
                        capabilities={model.capabilities}
                        params={modelParams ?? {}}
                        onChange={onChangeParams}
                      />
                    ) : null}
                  </div>
                )
              })}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  )
}
