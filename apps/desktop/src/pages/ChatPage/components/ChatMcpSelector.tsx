import { useEffect, useState } from 'react'
import {
  BookOpenIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleDotIcon,
  GitlabIcon,
  Loader2Icon,
  ServerIcon
} from 'lucide-react'
import type { CredentialState } from '@/api'
import { api } from '@/api'
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
import { useCredentialStatusContext } from '@/hooks/useCredentialStatusContext'
import { cn } from '@/lib/utils'

export type McpServiceId = string

type McpOption = { id: string; label: string; icon: typeof GitlabIcon; builtin: boolean }

/** 内置服务图标（与历史固定列表一致）；自定义服务统一 ServerIcon。 */
const BUILTIN_ICONS: Record<string, typeof GitlabIcon> = {
  gitlab: GitlabIcon,
  jira: CircleDotIcon,
  confluence: BookOpenIcon
}

/** 凭据状态徽章：ok 绿「已连接」/ failed 红「连接失败」/ skipped 灰「未配置」/ checking 转圈「检测中」。 */
function StatusBadge({ state }: { state?: CredentialState }) {
  if (!state || state.status === 'unknown' || state.status === 'skipped') {
    return (
      <Badge variant="muted" className="px-1 text-[10px]">
        未配置
      </Badge>
    )
  }
  if (state.status === 'checking') {
    return (
      <Badge variant="muted" className="gap-0.5 px-1 text-[10px]">
        <Loader2Icon size={9} className="animate-spin" />
        检测中
      </Badge>
    )
  }
  if (state.status === 'ok') {
    return (
      <Badge variant="success" className="px-1 text-[10px]">
        已连接
      </Badge>
    )
  }
  return (
    <Badge variant="destructive" className="px-1 text-[10px]">
      连接失败
    </Badge>
  )
}

/**
 * MCP 服务选择器：内置 GitLab/Jira/Confluence + 自定义服务（统一 dataDir/mcp.json），可多选。
 * - 列表动态读取 mcp.json 中 enabled 的服务（设置页 MCP Tab 维护）；
 * - 内置服务通过全局凭据状态显示连接徽章，未配置（凭据缺失）禁止新选；
 *   已选中的未配置服务仍可点击取消，避免死锁；
 * - 底部「全选 / 全不选」；勾选/取消即时上抛但不关闭弹窗，点击「确认」才关闭。
 */
export function ChatMcpSelector({
  selected,
  onChange,
  disabled
}: {
  selected: McpServiceId[]
  onChange(services: McpServiceId[]): void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<McpOption[]>([])
  const credentials = useCredentialStatusContext()

  // 列表动态加载：enabled 服务才可选；清除已停用/删除服务的幽灵选中。
  useEffect(() => {
    let cancelled = false
    void api
      .listMcpServers()
      .then(({ servers }) => {
        if (cancelled) return
        const enabled = servers.filter((server) => server.enabled)
        setOptions(
          enabled.map((server) => ({
            id: server.id,
            label: server.name,
            icon: BUILTIN_ICONS[server.id] ?? ServerIcon,
            builtin: server.builtin
          }))
        )
        const valid = new Set(enabled.map((server) => server.id))
        const stale = selected.filter((id) => !valid.has(id))
        if (stale.length > 0) onChange(selected.filter((id) => valid.has(id)))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isUnconfigured = (option: McpOption): boolean => {
    if (!option.builtin) return false // 自定义服务配置随 mcp.json，始终可选
    const state = credentials.items.find((item) => item.key === option.id)
    return !state || state.status === 'unknown' || state.status === 'skipped'
  }
  /** 全选可勾选集合（已选未配置的内置项不参与全选）。 */
  const allSelectable = options.filter((option) => !isUnconfigured(option))
  const allSelected = allSelectable.length > 0 && allSelectable.every((option) => selected.includes(option.id))
  const toggleAll = () => {
    if (allSelected) onChange([])
    else onChange([...new Set([...selected, ...allSelectable.map((option) => option.id)])])
  }

  const current = options.find((option) => option.id === selected[0])

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-6 gap-1 px-1.5 font-normal text-muted-foreground hover:text-foreground"
          aria-label="选择 MCP 服务"
        >
          <ServerIcon size={10} className="opacity-70" />
          <span className="max-w-32 truncate">
            {selected.length === 0
              ? '无 MCP'
              : selected.length === 1
                ? (current?.label ?? 'MCP')
                : `${current?.label ?? 'MCP'} +${selected.length - 1}`}
          </span>
          <ChevronDownIcon size={9} className="opacity-70" />
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent title="选择 MCP 服务" className="w-72 border bg-popover text-sm text-popover-foreground">
        <ModelSelectorList>
          <ModelSelectorGroup heading="MCP 服务">
            {options.map((option) => {
              const state = credentials.items.find((item) => item.key === option.id)
              const isActive = selected.includes(option.id)
              const unconfigured = isUnconfigured(option)
              const Icon = option.icon
              return (
                <ModelSelectorItem
                  key={option.id}
                  value={option.label}
                  // 未配置的禁止新选；已选中的未配置项保留可点击（用于取消移除）。
                  disabled={unconfigured && !isActive}
                  onSelect={() => {
                    onChange(isActive ? selected.filter((id) => id !== option.id) : [...selected, option.id])
                  }}
                >
                  <Icon size={12} className="opacity-70" />
                  <ModelSelectorName>{option.label}</ModelSelectorName>
                  {option.builtin ? <StatusBadge state={state} /> : <Badge variant="secondary">自定义</Badge>}
                  <CheckIcon
                    size={11}
                    className={cn('ml-auto text-foreground', isActive ? 'opacity-100' : 'opacity-0')}
                  />
                </ModelSelectorItem>
              )
            })}
            {options.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-muted-foreground">
                暂无启用的 MCP 服务，请到设置 → MCP 配置。
              </div>
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
              disabled={allSelectable.length === 0}
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
