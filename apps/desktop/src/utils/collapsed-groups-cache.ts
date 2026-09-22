/**
 * 侧边栏分组折叠状态缓存。
 *
 * ChatHistoryList 的折叠集合本质是纯 UI 偏好：不依赖后端、只需跨会话保留。
 * 之前用组件内 useState,组件每次重挂载(重进 chat 页)都会重置为「全部展开」,
 * 这里落到 localStorage 实现持久化。key 用 group.id(随机 UUID,存库稳定)与 '__plain__'。
 */

const STORAGE_KEY = 'chat:collapsedGroups'

/** 读取折叠分组 id 集合；解析失败返回空集合(默认全部展开)。 */
export function getCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

/** 持久化折叠分组 id 集合。 */
export function saveCollapsedGroups(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // 隐私模式 / 存储满等异常静默忽略
  }
}
