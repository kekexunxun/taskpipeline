/**
 * 打开系统设置弹窗并定位到指定 Tab（供对话区选择器「立即新增」入口使用）。
 * AppShell 监听 `app:open-settings` 事件，复用现有 initialTab 定位机制（同凭据失效跳转）。
 */
export function openSettingsTab(tab: string): void {
  window.dispatchEvent(new CustomEvent('app:open-settings', { detail: tab }))
}
