/**
 * 把 `Task.planContent` 规整为可渲染的字符串。
 *
 * - 非字符串、空字符串、`'[object Object]'` 哨兵值一律视为"无内容"，返回 `undefined`，
 *   让上游用 `planContent ? <PlanBody/> : <Empty/>` 模式优雅降级。
 */
export function readablePlanContent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const content = value.trim()
  if (!content || content === '[object Object]') return undefined
  return content
}
