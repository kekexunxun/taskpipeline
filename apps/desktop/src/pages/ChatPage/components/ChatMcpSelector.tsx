import { useState } from 'react'
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

export type McpServiceId = 'gitlab' | 'jira' | 'confluence'

const MCP_SERVICES: { id: McpServiceId; label: string; icon: typeof GitlabIcon }[] = [
  { id: 'gitlab', label: 'GitLab', icon: GitlabIcon },
  { id: 'jira', label: 'Jira', icon: CircleDotIcon },
  { id: 'confluence', label: 'Confluence', icon: BookOpenIcon }
]

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
 * MCP 服务选择器：GitLab / Jira / Confluence 三个固定服务，可多选。
 * 每个服务项通过全局凭据状态实时显示连接状态徽章（主进程探测后广播刷新）。
 * 未配置（凭据缺失）的服务禁止新选；已选中的未配置服务仍可点击取消，避免死锁。
 * 勾选/取消即时上抛但不关闭弹窗，点击底部「确认」才关闭，避免误触单项即退出。
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
  const credentials = useCredentialStatusContext()
  const current = MCP_SERVICES.find((service) => service.id === selected[0])

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
      <ModelSelectorContent title="选择 MCP 服务" className="w-64 border bg-popover text-sm text-popover-foreground">
        <ModelSelectorList>
          <ModelSelectorGroup heading="MCP 服务">
            {MCP_SERVICES.map((service) => {
              const state = credentials.items.find((item) => item.key === service.id)
              const isActive = selected.includes(service.id)
              // 与 StatusBadge「未配置」判定一致：无状态或 unknown/skipped。
              const unconfigured = !state || state.status === 'unknown' || state.status === 'skipped'
              const Icon = service.icon
              return (
                <ModelSelectorItem
                  key={service.id}
                  value={service.label}
                  // 未配置的禁止新选；已选中的未配置项保留可点击（用于取消移除）。
                  disabled={unconfigured && !isActive}
                  onSelect={() => {
                    // 勾选/取消即时上抛，但保持弹窗打开，由底部「确认」按钮统一关闭。
                    onChange(isActive ? selected.filter((id) => id !== service.id) : [...selected, service.id])
                  }}
                >
                  <Icon size={12} className="opacity-70" />
                  <ModelSelectorName>{service.label}</ModelSelectorName>
                  <StatusBadge state={state} />
                  <CheckIcon
                    size={11}
                    className={cn('ml-auto text-foreground', isActive ? 'opacity-100' : 'opacity-0')}
                  />
                </ModelSelectorItem>
              )
            })}
          </ModelSelectorGroup>
        </ModelSelectorList>
        <div className="flex shrink-0 items-center justify-between border-t px-3 py-2">
          <span className="text-[10px] text-muted-foreground">已选 {selected.length} 个</span>
          <Button size="sm" className="h-6 px-2.5 text-xs" onClick={() => setOpen(false)}>
            确认
          </Button>
        </div>
      </ModelSelectorContent>
    </ModelSelector>
  )
}
