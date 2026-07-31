import { Code2, Settings } from "lucide-react";

export function TopBar({ onOpenSettings }: { onOpenSettings(): void }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark"><Code2 size={18} /></span>
        <strong>Forge Agent</strong>
      </div>
      <div className="top-actions">
        <button className="icon-button" title="设置" onClick={onOpenSettings}><Settings size={17} /></button>
      </div>
    </header>
  );
}
