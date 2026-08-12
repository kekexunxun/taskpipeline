import { BrainIcon, CoinsIcon, EyeIcon } from 'lucide-react'
import type { ChatModelInfo } from '@/api'
import { cn } from '@/lib/utils'

/**
 * 模型属性徽章组：统一展示 Credit 消耗、是否支持视觉、是否推理模型。
 * 供 ChatModelSelector 与系统设置面板复用，确保两端展示一致。
 * 配色深浅主题分档：浅色用 600 档文字（300 档在白底上对比度不足），深色保留 300 档。
 */
export function ModelBadges({
  model,
  className
}: {
  model: Pick<ChatModelInfo, 'isReasoning' | 'isVl' | 'priceFactor'>
  className?: string
}) {
  const hasAny = model.isReasoning || model.isVl || (model.priceFactor !== undefined && model.priceFactor !== null)
  if (!hasAny) return null
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {model.isReasoning && (
        <span
          title="推理模型"
          aria-label="推理模型"
          className="inline-flex items-center gap-0.5 rounded bg-amber-500/10 px-1 text-[10px] font-medium text-amber-600 dark:bg-amber-500/15 dark:text-amber-300"
        >
          <BrainIcon size={9} />
          推理
        </span>
      )}
      {model.isVl && (
        <span
          title="支持视觉/多模态输入"
          aria-label="支持视觉"
          className="inline-flex items-center gap-0.5 rounded bg-sky-500/10 px-1 text-[10px] font-medium text-sky-600 dark:bg-sky-500/15 dark:text-sky-300"
        >
          <EyeIcon size={9} />
          视觉
        </span>
      )}
      {model.priceFactor !== undefined && model.priceFactor !== null && (
        <span
          title="Credit 消耗倍率"
          aria-label="Credit 消耗"
          className="inline-flex items-center gap-0.5 rounded bg-emerald-500/10 px-1 text-[10px] font-medium text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300"
        >
          <CoinsIcon size={9} />
          {model.priceFactor.toFixed(model.priceFactor >= 10 ? 0 : 2)}x
        </span>
      )}
    </span>
  )
}
