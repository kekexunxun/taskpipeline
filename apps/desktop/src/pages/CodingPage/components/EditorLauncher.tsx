import { useState } from "react";
import { Code2, Terminal } from "lucide-react";

export function EditorLauncher({ onLaunchVSCode, onLaunchQoder }: { onLaunchVSCode(): void; onLaunchQoder(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="editor-launcher" onMouseLeave={() => setOpen(false)}>
      <button className="secondary" onClick={() => setOpen((v) => !v)}><Code2 size={13} />使用编辑器打开</button>
      {open && (
        <div className="editor-menu">
          <button onClick={onLaunchVSCode}><Code2 size={13} />VS Code</button>
          <button onClick={onLaunchQoder}><Terminal size={13} />Qoder</button>
        </div>
      )}
    </div>
  );
}
