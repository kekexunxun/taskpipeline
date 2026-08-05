import type { TaskCard } from "@coding-agent/core";
import type { TaskRemovalMode } from "@/api";
import { columns } from "../../../utils/status";
import { BoardToolbar } from "./BoardToolbar";
import { BoardColumn as BoardColumnView } from "./BoardColumn";

export function BoardPanel({
  tasks,
  search,
  onSearch,
  selectedId,
  removingTaskIds,
  onOpen,
  onEdit,
  onRemove,
  onCreate,
  onFromJira,
  onSyncJira
}: {
  tasks: TaskCard[];
  search: string;
  onSearch(value: string): void;
  selectedId?: string;
  removingTaskIds: ReadonlySet<string>;
  onOpen(taskId: string): void;
  onEdit(taskId: string): void;
  onRemove(taskId: string, mode: TaskRemovalMode): Promise<boolean>;
  onCreate(): void;
  onFromJira(): void;
  onSyncJira(): void;
}) {
  const filtered = tasks.filter((task) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return `${task.title} ${task.taskKey ?? ""} ${task.keywords.join(" ")}`
      .toLowerCase()
      .includes(q);
  });
  return (
    <section className="grid h-full min-h-0 min-w-0 grid-rows-[56px_minmax(0,1fr)] bg-background">
      <div className="flex items-center justify-between gap-4 border-b px-5">
        <div className="leading-tight">
          <h1 className="text-base font-semibold tracking-tight">任务看板</h1>
          <p className="text-xs text-muted-foreground">{tasks.length} 项任务</p>
        </div>
        <BoardToolbar
          search={search}
          onSearch={onSearch}
          onNew={onCreate}
          onFromJira={onFromJira}
          onSyncJira={onSyncJira}
        />
      </div>
      <div className="thin-scrollbar grid h-full min-h-0 min-w-0 auto-cols-[minmax(320px,1fr)] grid-flow-col gap-3 overflow-auto p-3 pb-4">
        {columns.map(({ id, title, icon }) => {
          const cards = filtered.filter((task) => task.boardColumn === id);
          return (
            <BoardColumnView
              key={id}
              id={id}
              title={title}
              icon={icon}
              cards={cards}
              selectedId={selectedId}
              removingTaskIds={removingTaskIds}
              onOpen={onOpen}
              onEdit={id === "todo" ? onEdit : undefined}
              onRemove={onRemove}
            />
          );
        })}
      </div>
    </section>
  );
}
