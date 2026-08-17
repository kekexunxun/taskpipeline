import { SparklesIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { ChatComposer } from './ChatComposer'
import { ChatProjectSwitcher } from './ChatProjectSwitcher'
import { Button } from '@/components/ui/button'
import type { ChatGroup, UserFileAttachment } from '@/api'

const EXAMPLE_PROMPTS = [
  '帮我分析当前项目的代码结构和依赖关系',
  '这段代码有什么性能问题？如何优化？',
  '帮我重构这个组件，使用更好的设计模式'
]

export function ChatWelcomeView({
  composerValue,
  onComposerChange,
  onSend,
  onStop,
  disabled,
  streaming,
  groups,
  projectValue,
  onProjectChange,
  onAddProject,
  onSetupWorkspace,
  leftSlot
}: {
  composerValue: string
  onComposerChange(value: string): void
  onSend(value: string, files?: UserFileAttachment[]): void
  onStop?(): void
  disabled?: boolean
  streaming?: boolean
  groups: ChatGroup[]
  projectValue?: string
  onProjectChange(directory: string | undefined): void
  onAddProject(): void
  onSetupWorkspace(): void
  leftSlot?: ReactNode
}) {
  const handlePromptClick = (prompt: string) => {
    onComposerChange(prompt)
    // Focus the composer textarea
    setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>('[data-testid=chat-composer]')?.focus()
    }, 0)
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-2xl flex-col items-center gap-6">
        {/* Logo + Title */}
        <div className="flex flex-col items-center gap-3">
          <div className="grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 text-blue-400">
            <SparklesIcon size={28} />
          </div>
          <h2 className="text-lg font-semibold tracking-tight">有什么可以帮你的？</h2>
        </div>

        {/* Project Switcher + Run Button Row + Composer */}
        <div className="flex w-full flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-xs">运行于</span>
            <ChatProjectSwitcher
              groups={groups}
              value={projectValue}
              onChange={onProjectChange}
              onAdd={onAddProject}
              onSetupWorkspace={onSetupWorkspace}
              disabled={disabled || streaming}
            />
          </div>
          <ChatComposer
            value={composerValue}
            onChange={onComposerChange}
            onSend={onSend}
            onStop={onStop}
            disabled={disabled}
            streaming={streaming}
            placeholder="描述你的问题，Enter 发送"
            leftSlot={leftSlot}
            showHitlMode={false}
          />
        </div>

        {/* Example Prompts */}
        <div className="w-full space-y-2">
          <div className="flex items-center gap-3 px-1">
            <div className="h-px flex-1 bg-border/50" />
            <span className="text-[11px] text-muted-foreground">试试这些</span>
            <div className="h-px flex-1 bg-border/50" />
          </div>
          <div className="space-y-1.5">
            {EXAMPLE_PROMPTS.map((prompt) => (
              <Button
                key={prompt}
                variant="ghost"
                size="sm"
                onClick={() => handlePromptClick(prompt)}
                className="h-auto w-full justify-start gap-2 border-border/40 bg-card/40 px-3 py-2 text-xs font-normal text-muted-foreground shadow-none hover:border-border hover:bg-accent hover:text-foreground"
              >
                <SparklesIcon size={12} className="shrink-0 text-blue-400/70" />
                <span className="truncate">{prompt}</span>
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
