import type { BoardColumn, TaskCard } from "@coding-agent/core";
import { columns } from "../../../utils/status";
import { BoardToolbar } from "./BoardToolbar";
import { BoardColumn as BoardColumnView } from "./BoardColumn";

export function BoardPanel({
  tasks,
  search,
  onSearch,
  selectedId,
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
  onOpen(taskId: string): void;
  onEdit(taskId: string): void;
  onRemove(taskId: string, columnId: BoardColumn): void;
  onCreate(): void;
  onFromJira(): void;
  onSyncJira(): void;
}) {
  const filtered = tasks.filter((task) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return `${task.title} ${task.jiraKey ?? ""} ${task.keywords.join(" ")}`
      .toLowerCase()
      .includes(q);
  });
  return (
    <section className="grid min-h-0 min-w-0 grid-rows-[56px_minmax(0,1fr)] bg-background">
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
      <div className="thin-scrollbar grid min-h-0 grid-cols-[repeat(4,minmax(240px,1fr))] gap-3 overflow-auto p-3 pb-4">
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
              onOpen={onOpen}
              onEdit={id === "todo" ? onEdit : undefined}
              onRemove={
                id === "todo" || id === "done"
                  ? (taskId) => onRemove(taskId, id)
                  : undefined
              }
            />
          );
        })}
      </div>
    </section>
  );
}
