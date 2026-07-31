import { NavLink } from "react-router-dom";
import { MessageSquareText, Code2 } from "lucide-react";

export function ActionBar() {
  return (
    <nav className="action-bar">
      <NavLink to="/chat" className={({ isActive }) => `action-item ${isActive ? "active" : ""}`} title="对话">
        <MessageSquareText size={20} />
      </NavLink>
      <NavLink to="/coding" className={({ isActive }) => `action-item ${isActive ? "active" : ""}`} title="编码">
        <Code2 size={20} />
      </NavLink>
    </nav>
  );
}
