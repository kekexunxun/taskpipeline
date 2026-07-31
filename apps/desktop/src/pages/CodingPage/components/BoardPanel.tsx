import { useState } from "react";
import type { BoardColumn, TaskCard } from "@coding-agent/core";
import { columns } from "../../../utils/status";
import { BoardToolbar } from "./BoardToolbar";
import { BoardColumn as BoardColumnView } from "./BoardColumn";
import { GlobalFeedback } from "../../../components/GlobalFeedback";

export function BoardPanel({ tasks, search, onSearch, selectedId, onOpen, onEdit, onRemove, onCreate, onFromJira, onSyncJira }: {
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
  const [menuOpen, setMenuOpen] = useState(false);
  const filtered = tasks.filter((task) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return `${task.title} ${task.jiraKey ?? ""} ${task.keywords.join(" ")}`.toLowerCase().includes(q);
  });
  return (
    <section className="board-panel">
      <div className="board-toolbar">
        <div>
          <h1>任务看板</h1>
          <span>{tasks.length} 项任务</span>
        </div>
        <BoardToolbar
          search={search}
          onSearch={onSearch}
          onCreateClick={() => { setMenuOpen((v) => !v); onCreate(); }}
          onMenuOpen={() => setMenuOpen((v) => !v)}
          menuOpen={menuOpen}
        />
      </div>
      <GlobalFeedback />
      <div className="board-columns">
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
              onRemove={id === "todo" || id === "done" ? (taskId) => onRemove(taskId, id) : undefined}
            />
          );
        })}
      </div>
    </section>
  );
}
