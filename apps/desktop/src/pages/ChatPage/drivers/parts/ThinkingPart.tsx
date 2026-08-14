import { ThinkingBlock } from '@/components/ThinkingBlock'
import type { DriverPart } from '@/api'

/**
 * 折叠式 thinking / reasoning part —— 委托给共享 `ThinkingBlock`。
 *
 * 保留此文件作为 DriverPart 类型的适配层:PartRenderer 传入的是
 * `Extract<DriverPart, { type: 'qoder.thinking' | 'openai.thinking' }>` 形态,
 * 这里只取 `part.text` 传给通用组件。
 */
export function ThinkingPart({
  part,
  isStreaming
}: {
  part: Extract<DriverPart, { type: 'qoder.thinking' | 'openai.thinking' }>
  isStreaming?: boolean
}) {
  return <ThinkingBlock text={part.text} isStreaming={isStreaming} />
}
