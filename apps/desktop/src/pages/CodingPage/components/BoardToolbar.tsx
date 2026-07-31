import { useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Search } from "lucide-react";

export function NewTaskMenu({ onNew, onFromJira, onSyncJira, onClose }: { onNew(): void; onFromJira(): void; onSyncJira(): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [onClose]);
  return (
    <div className="new-menu" ref={ref}>
      <button onClick={onNew}>全新创建</button>
      <button onClick={onFromJira}>从 Jira Key 创建</button>
      <button onClick={onSyncJira}><RefreshCw size={14} />同步我的 Jira</button>
    </div>
  );
}

export function BoardToolbar({ search, onSearch, onCreateClick, onMenuOpen, menuOpen }: {
  search: string;
  onSearch(value: string): void;
  onCreateClick(): void;
  onMenuOpen(): void;
  menuOpen: boolean;
}) {
  return (
    <div className="board-actions">
      <label className="search-box">
        <Search size={15} />
        <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索任务" />
      </label>
      <div className="new-task-wrap">
        <button className="primary icon-command" title="新建任务" onClick={onCreateClick}><Plus size={16} /></button>
        {menuOpen && <NewTaskMenu onNew={() => { onCreateClick(); onMenuOpen(); }} onFromJira={() => { onCreateClick(); onMenuOpen(); }} onSyncJira={() => { onCreateClick(); onMenuOpen(); }} onClose={onMenuOpen} />}
      </div>
    </div>
  );
}
