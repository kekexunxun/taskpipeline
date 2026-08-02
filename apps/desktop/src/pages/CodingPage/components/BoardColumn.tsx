import type { TaskCard } from "@coding-agent/core";
import { TaskCardView } from "./TaskCard";

export function BoardColumn({
  id,
  title,
  icon: Icon,
  cards,
  selectedId,
  removingTaskIds,
  onOpen,
  onEdit,
  onRemove
}: {
  id: string;
  title: string;
  icon: React.ComponentType<{ size?: number }>;
  cards: TaskCard[];
  selectedId?: string;
  removingTaskIds: ReadonlySet<string>;
  onOpen(taskId: string): void;
  onEdit?(taskId: string): void;
  onRemove?(taskId: string): Promise<boolean>;
}) {
  return (
    <section
      className="grid min-h-0 min-w-[220px] grid-rows-[32px_minmax(0,1fr)] border-l first:border-l-0"
      key={id}
    >
      <header className="flex items-center justify-between gap-2 px-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Icon size={12} />
          {title}
        </span>
        <b className="grid min-w-4 place-items-center rounded bg-muted px-1 py-px text-[10px] tabular-nums text-foreground">
          {cards.length}
        </b>
      </header>
      <div className="thin-scrollbar flex min-h-0 flex-col gap-1.5 overflow-y-auto px-1.5 pb-3 pt-1">
        {cards.map((task) => (
          <TaskCardView
            key={task.id}
            task={task}
            active={task.id === selectedId}
            removing={removingTaskIds.has(task.id)}
            onOpen={() => onOpen(task.id)}
            onEdit={onEdit ? () => onEdit(task.id) : undefined}
            onRemove={onRemove ? () => onRemove(task.id) : undefined}
          />
        ))}
        {cards.length === 0 && (
          <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            暂无任务
          </div>
        )}
      </div>
    </section>
  );
}
