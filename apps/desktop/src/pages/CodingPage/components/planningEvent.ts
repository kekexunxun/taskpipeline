const planningStateEvent = /^状态更新为\s+(?:confirmed|preparing|planning|awaiting_plan_approval)$/

/**
 * 判断一条事件是否属于"计划阶段"。
 *
 * 用法：数据层在拼接 DriverPart 时调用 `!isPlanningEvent(event)` 把计划相关
 * 事件（状态流转、调整意见、阶段提示、结论）过滤掉，让执行流只保留真正动手的步骤。
 */
export function isPlanningEvent(item: { title: string }): boolean {
  const title = item.title.trim()
  return (
    planningStateEvent.test(title) ||
    title === '计划调整意见' ||
    title.includes('计划阶段') ||
    title.startsWith('计划结论')
  )
}
