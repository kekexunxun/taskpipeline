import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, ChevronDownIcon, CpuIcon, SlidersHorizontalIcon, SparklesIcon } from 'lucide-react'
import type { ChatModelGroup, ChatModelInfo, ModelCapability, ModelParams } from '@/api'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { ModelBadges } from '@/components/ModelBadges'
import { cn } from '@/lib/utils'
import { MODEL_VENDORS } from '@/utils/model-vendors'
import { pickSystemDefaultModel } from '@/utils/chat-models'

const CAPABILITY_LABEL: Record<ModelCapability['key'], string> = {
  reasoningEffort: '推理力度',
  thinking: '思考模式',
  maxOutputTokens: '最大输出 Token'
}

/** 厂商 id → 展示名（MODEL_VENDORS 查表；Qoder 模型无 vendor 返回 undefined）。 */
function vendorNameOf(model: { vendor?: string }): string | undefined {
  if (!model.vendor) return undefined
  return MODEL_VENDORS.find((v) => v.id === model.vendor)?.name
}

/** 按厂商分块（顺序 = MODEL_VENDORS 注册表；缺失/未知 vendor 归入「其它兼容端点」）。 */
function groupModelsByVendor(
  models: ChatModelInfo[]
): Array<{ vendor: string; label: string; items: ChatModelInfo[] }> {
  const order = MODEL_VENDORS.map((v) => v.id)
  const buckets = new Map<string, ChatModelInfo[]>()
  for (const model of models) {
    const vendor = model.vendor && (order as string[]).includes(model.vendor) ? model.vendor : 'openai-compatible'
    if (!buckets.has(vendor)) buckets.set(vendor, [])
    buckets.get(vendor)!.push(model)
  }
  return order
    .filter((vendor) => (buckets.get(vendor)?.length ?? 0) > 0)
    .map((vendor) => ({
      vendor,
      label: MODEL_VENDORS.find((v) => v.id === vendor)?.name ?? vendor,
      items: buckets.get(vendor)!
    }))
}

/**
 * 浮层内参数调节区（schema 驱动，按 capabilities 渲染）。
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
    <div className="flex flex-col gap-2.5 px-3 pt-1 pb-3" onPointerDown={(event) => event.stopPropagation()}>
      {capabilities.map((capability) => {
        const label = CAPABILITY_LABEL[capability.key]
        if (capability.kind === 'enum') {
          const current = typeof params[capability.key] === 'string' ? (params[capability.key] as string) : undefined
          return (
            <div key={capability.key} className="flex items-center justify-between gap-3">
              <span className="text-[11px] whitespace-nowrap text-muted-foreground">{label}</span>
              <ButtonGroup>
                {capability.options.map((option) => (
                  <Button
                    key={option}
                    type="button"
                    size="sm"
                    variant={current === option ? 'default' : 'outline'}
                    onClick={() => onChange({ ...params, [capability.key]: option })}
                    className="px-2"
                  >
                    {option}
                  </Button>
                ))}
              </ButtonGroup>
            </div>
          )
        }
        if (capability.kind === 'toggle') {
          return (
            <div key={capability.key} className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">{label}</span>
              <Switch
                checked={params[capability.key] === true}
                onCheckedChange={(next) => onChange({ ...params, [capability.key]: next })}
                className="h-4 w-7 data-[state=checked]:bg-input [&>span]:size-3 data-[state=checked]:[&>span]:translate-x-3"
              />
            </div>
          )
        }
        // kind === 'number'：留空 = 不设置（driver 用自身默认）。
        const numeric = typeof params[capability.key] === 'number' ? (params[capability.key] as number) : undefined
        return (
          <div key={capability.key} className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted-foreground">{label}</span>
            <Input
              type="number"
              min={1}
              max={capability.max}
              value={numeric ?? ''}
              placeholder="默认"
              className="h-6 w-24 px-2 text-[10px]!"
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
 * hover 浮层面板：createPortal 到 document.body + 手动 fixed 定位。
 * CommandDialog 环境下 Radix HoverCard 无法正常工作（focus trap / overlay 冲突），
 * 因此自控实现：锚定 hover 的模型条目，右侧优先、空间不足翻到左侧。
 */
function HoverParamsPanel({
  model,
  anchorValue,
  // selected,
  adjustable,
  params,
  onApply,
  onEnter,
  onLeave
}: {
  model: ChatModelInfo
  anchorValue: string
  selected: boolean
  adjustable: boolean
  params: ModelParams
  onApply(next: ModelParams): void
  onEnter(): void
  onLeave(): void
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const vendorName = vendorNameOf(model)
  useLayoutEffect(() => {
    const findAnchor = () => {
      const nodes = document.querySelectorAll<HTMLElement>('[data-model-value]')
      for (const node of nodes) if (node.dataset.modelValue === anchorValue) return node
      return null
    }
    const update = () => {
      const anchor = findAnchor()
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const gap = 8
      const panelWidth = 256
      let left = rect.right + gap
      if (left + panelWidth > window.innerWidth - gap) left = rect.left - gap - panelWidth
      const top = Math.max(gap, Math.min(rect.top, window.innerHeight - 320))
      setPos({ left, top })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [anchorValue])
  if (!pos) return null
  return createPortal(
    <div
      className="animate-in fade-in-0 fixed z-[9999] w-60 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl"
      style={{ left: pos.left, top: pos.top, pointerEvents: 'auto' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {/* 头部：模型名 + 状态 */}
      <div className="flex items-start gap-2 px-3 pt-3 pb-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex w-auto flex-col gap-1.5">
            {vendorName && (
              <span className="w-auto shrink-0 rounded bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground">
                {vendorName}
              </span>
            )}
            <span className="truncate text-[11px] leading-tight font-semibold" title={model.displayName}>
              {model.displayName}
            </span>
          </div>
          <div className="mt-1">
            <ModelBadges model={model} />
          </div>
        </div>
        {/* {selected && (
          <span className="mt-0.5 shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[9px] font-medium text-primary">
            使用中
          </span>
        )} */}
      </div>
      {/* 参数区 */}
      {model.capabilities?.length && adjustable ? (
        <div className="border-t bg-muted/30 px-3 pt-2 pb-2.5">
          <div className="mb-1.5 text-[9px] font-medium tracking-widest text-muted-foreground/70 uppercase">参数</div>
          <CapabilityControls capabilities={model.capabilities} params={params} onChange={onApply} />
        </div>
      ) : (
        <div className="flex items-center gap-2 border-t bg-muted/30 px-3 py-2.5">
          <SlidersHorizontalIcon size={12} className="shrink-0 text-muted-foreground/40" />
          <span className="text-[10px] leading-tight text-muted-foreground/60">
            {model.capabilities?.length ? '当前场景不支持调整' : '无可调参数'}
          </span>
        </div>
      )}
    </div>,
    document.body
  )
}

/**
 * 模型选择器：CommandDialog + 自控 hover 浮层。
 * CommandDialog 负责搜索过滤与键盘导航，hover 浮层展示参数面板。
 *
 * 纯受控：value 为空时展示「系统自动选择」结果并标记「自动」，不写回 value。
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
  const [hoveredValue, setHoveredValue] = useState<string>()
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const handleEnter = (val: string) => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setHoveredValue(val)
  }
  const handleLeave = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setHoveredValue(undefined), 120)
  }
  const flat = groups.flatMap((group) =>
    group.models.map((model) => ({ ...model, driverId: group.driverId, driverDisplayName: group.displayName }))
  )
  // 严格受控：仅当 value 能匹配到模型时才有 current。
  const current = value ? flat.find((model) => model.value === value) : undefined
  // 未显式选择时，展示系统自动选择的结果（与对话/任务默认解析同一规则）。
  // 只用于展示与下拉标记，不写回 value，保持调用方状态不变。
  const autoModel = value ? undefined : pickSystemDefaultModel(groups)
  const autoInfo = autoModel ? flat.find((model) => model.value === autoModel.model) : undefined
  const displayName = current?.displayName ?? autoInfo?.displayName ?? value ?? 'Auto'
  const hasModels = flat.length > 0
  const hoveredModel = hoveredValue ? flat.find((m) => m.value === hoveredValue) : undefined
  // 浮层上修改参数：先切换选中（切换模型会清空旧 params，语义归属选中模型），再写入新值。
  const applyParams = (model: ChatModelInfo, next: ModelParams) => {
    if (model.value !== value) onChange(model.value)
    onChangeParams?.(next)
  }
  // 单个模型条目，含 hover 事件 wrapper。
  const renderModel = (model: ChatModelInfo) => {
    const isAuto = Boolean(autoInfo && model.value === autoInfo.value)
    const isActive = model.value === value || isAuto
    const vendorName = vendorNameOf(model)
    return (
      <div
        key={model.value}
        data-model-value={model.value}
        onMouseEnter={() => handleEnter(model.value)}
        onMouseLeave={handleLeave}
      >
        <CommandItem
          value={vendorName ? `${vendorName} ${model.displayName}` : model.displayName}
          className="py-1.5 text-[11px]"
          onSelect={() => {
            onChange(model.value)
            setOpen(false)
          }}
        >
          <span className="flex-1 truncate text-left">{model.displayName}</span>
          <ModelBadges model={model} />
          {model.isDefault && (
            <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">默认</span>
          )}
          {isAuto && <span className="rounded bg-primary/10 px-1 text-[10px] font-medium text-primary">自动</span>}
          <CheckIcon size={11} className={cn('ml-auto text-foreground', isActive ? 'opacity-100' : 'opacity-0')} />
        </CommandItem>
      </div>
    )
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || !hasModels}
        className="h-6 gap-1 px-1.5 font-normal text-muted-foreground hover:text-foreground"
        aria-label="选择模型"
        onClick={() => setOpen(true)}
      >
        <CpuIcon size={10} className="opacity-70" />
        <span
          className="max-w-32 truncate"
          title={
            current?.displayName
              ? undefined
              : autoInfo
                ? `未显式选择，系统自动选择：${autoInfo.displayName}`
                : undefined
          }
        >
          {displayName}
        </span>
        <ChevronDownIcon size={9} className="opacity-70" />
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <Command>
          <CommandInput className="text-xs!" placeholder="搜索模型…" />
          <CommandList>
            <CommandEmpty>未找到匹配的模型</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup
                key={group.driverId}
                heading={
                  group.driverId === 'qoder' ? (
                    <span className="inline-flex items-center gap-1">
                      <SparklesIcon size={10} />
                      {group.displayName}
                    </span>
                  ) : undefined
                }
              >
                {group.driverId === 'qoder' && group.quotaExhausted && (
                  <div className="mx-2 mb-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] leading-4 text-amber-500">
                    Qoder 额度不足，当前仅 lite 免费模型可用
                  </div>
                )}
                {group.driverId === 'qoder'
                  ? group.models.map((model) => renderModel(model))
                  : groupModelsByVendor(group.models).map((block) => (
                      <div key={block.vendor}>
                        <div className="flex items-center gap-1 px-2 pt-2 pb-0.5 text-[10px] font-semibold text-muted-foreground">
                          {block.label}
                        </div>
                        {block.items.map((model) => renderModel(model))}
                      </div>
                    ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
      {hoveredModel && (
        <HoverParamsPanel
          model={hoveredModel}
          anchorValue={hoveredModel.value}
          selected={hoveredModel.value === value}
          adjustable={Boolean(onChangeParams)}
          params={hoveredModel.value === value ? (modelParams ?? {}) : {}}
          onApply={(next) => applyParams(hoveredModel, next)}
          onEnter={() => {
            if (closeTimer.current) clearTimeout(closeTimer.current)
          }}
          onLeave={handleLeave}
        />
      )}
    </>
  )
}
