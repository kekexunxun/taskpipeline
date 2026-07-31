import type { BoardColumn } from "@coding-agent/core";
import type { TaskCard } from "@coding-agent/core";
import { TaskCardView } from "./TaskCard";

export function BoardColumn({ id, title, cards, selectedId, onOpen, onEdit, onRemove }: {
  id: BoardColumn;
  title: string;
  icon: React.ComponentType<{ size?: number }>;
  cards: TaskCard[];
  selectedId?: string;
  onOpen(taskId: string): void;
  onEdit?(taskId: string): void;
  onRemove?(taskId: string): void;
}) {
  return (
    <section className="board-column" key={id}>
      <header>
        <span>{title}</span>
        <b>{cards.length}</b>
      </header>
      <div className="card-list">
        {cards.map((task) => (
          <TaskCardView
            key={task.id}
            task={task}
            active={task.id === selectedId}
            onOpen={() => onOpen(task.id)}
            onEdit={onEdit ? () => onEdit(task.id) : undefined}
            onRemove={onRemove ? () => onRemove(task.id) : undefined}
          />
        ))}
        {cards.length === 0 && <div className="empty-column">暂无任务</div>}
      </div>
    </section>
  );
}
