import { useEffect, useState } from 'react'
import { BotIcon, CheckIcon, ChevronDownIcon, SparklesIcon, UserRoundIcon } from 'lucide-react'
import type { AgentProfile } from '@task-pipeline/core'
import { api } from '@/api'
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
import { cn } from '@/lib/utils'

/** 系统内置角色 Agent 的固定 id（与设置页 Agent Tab 分类一致）。 */
const ROLE_AGENT_IDS = ['builtin-reviewer', 'builtin-test-writer', 'builtin-mr-writer']
const isSystemAgent = (agent: AgentProfile): boolean => Boolean(agent.builtin) || ROLE_AGENT_IDS.includes(agent.id)

/**
 * Agent 选择器：系统 Agent 与自定义 Agent 分块展示，单选。
 * 选中项由父组件自动注入该 Agent 的 systemPrompt（发送时随 StartChatStreamInput 传给主进程）。
 * 提供「无（跟随系统设置）」清除项；Agent 列表仅在组件挂载时拉取一次。
 * 触发按钮采用 11px 紧凑样式（与 ChatComposer 工具栏同高）。
 */
export function ChatAgentSelector({
  selected,
  onChange,
  disabled
}: {
  selected?: string
  onChange(agentId: string | undefined): void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .listAgents()
      .then((list) => {
        if (!cancelled) setAgents(list)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const systemAgents = agents.filter(isSystemAgent)
  const customAgents = agents.filter((agent) => !isSystemAgent(agent) && agent.enabled)
  const current = agents.find((agent) => agent.id === selected)

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-6 gap-1 px-1.5 font-normal text-muted-foreground hover:text-foreground"
          aria-label="选择 Agent"
        >
          <BotIcon size={10} className="opacity-70" />
          <span className="max-w-32 truncate">{current?.name ?? '无 Agent'}</span>
          <ChevronDownIcon size={9} className="opacity-70" />
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent title="选择 Agent" className="w-72 border bg-popover text-sm text-popover-foreground">
        <ModelSelectorList>
          <ModelSelectorItem
            value="__none__"
            onSelect={() => {
              onChange(undefined)
              setOpen(false)
            }}
          >
            <UserRoundIcon size={12} className="opacity-70" />
            <ModelSelectorName className="text-muted-foreground">无（跟随系统设置）</ModelSelectorName>
            <CheckIcon size={11} className={cn('ml-auto text-foreground', !selected ? 'opacity-100' : 'opacity-0')} />
          </ModelSelectorItem>
          {systemAgents.length > 0 && (
            <ModelSelectorGroup heading="系统 Agent">
              {systemAgents.map((agent) => {
                const isActive = agent.id === selected
                return (
                  <ModelSelectorItem
                    key={agent.id}
                    value={agent.name}
                    onSelect={() => {
                      onChange(agent.id)
                      setOpen(false)
                    }}
                  >
                    <SparklesIcon size={12} className="opacity-70" />
                    <ModelSelectorName>{agent.name}</ModelSelectorName>
                    <CheckIcon
                      size={11}
                      className={cn('ml-auto text-foreground', isActive ? 'opacity-100' : 'opacity-0')}
                    />
                  </ModelSelectorItem>
                )
              })}
            </ModelSelectorGroup>
          )}
          {customAgents.length > 0 && (
            <ModelSelectorGroup heading="自定义 Agent">
              {customAgents.map((agent) => {
                const isActive = agent.id === selected
                return (
                  <ModelSelectorItem
                    key={agent.id}
                    value={agent.name}
                    onSelect={() => {
                      onChange(agent.id)
                      setOpen(false)
                    }}
                  >
                    <BotIcon size={12} className="opacity-70" />
                    <ModelSelectorName>{agent.name}</ModelSelectorName>
                    <CheckIcon
                      size={11}
                      className={cn('ml-auto text-foreground', isActive ? 'opacity-100' : 'opacity-0')}
                    />
                  </ModelSelectorItem>
                )
              })}
            </ModelSelectorGroup>
          )}
          {loaded && systemAgents.length === 0 && customAgents.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">暂无可用 Agent</div>
          )}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  )
}
