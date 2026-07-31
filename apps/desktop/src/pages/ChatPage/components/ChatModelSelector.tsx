import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import type { ChatModelGroup } from "../../../api";

type Props = {
  groups: ChatModelGroup[];
  value?: string;
  onChange(value: string): void;
  disabled?: boolean;
};

// 菜单用 Portal 挂到 body 并用 fixed 定位，避开任何祖先容器的 overflow: hidden / transform
// 创建的裁剪/层级问题。trigger 仍保留在原位置。
export function ChatModelSelector({ groups, value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const current = groups.flatMap((group) => group.models).find((m) => m.value === value);

  // 打开时立即定位一次；之后跟随 resize / 任意祖先滚动实时更新。
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const measure = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      setPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
    };
    measure();
    const onResize = () => measure();
    const onScroll = () => measure();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("resize", onResize); window.removeEventListener("scroll", onScroll, true); };
  }, [open]);

  // 外部点击 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onPointerDown); window.removeEventListener("keydown", onKey); };
  }, [open]);

  if (groups.length === 0) {
    return <span className="chat-model-empty" title="在设置中配置 Qoder 或 OpenAI-Compatible 后才可选择模型">未配置模型</span>;
  }

  return (
    <div className="chat-model-selector">
      <button
        ref={triggerRef}
        type="button"
        className="chat-model-selector-trigger"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current?.displayName ?? "选择模型"}</span>
        <ChevronDown size={12} className={open ? "rotated" : ""} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="chat-model-menu"
          style={{ position: "fixed", left: pos.left, bottom: pos.bottom }}
          role="menu"
        >
          {groups.map((group) => (
            <div className="chat-model-group" key={group.provider}>
              <div className="chat-model-group-label">{group.displayName}</div>
              {group.models.map((m) => (
                <button
                  type="button"
                  className={`chat-model-option ${m.value === value ? "selected" : ""}`}
                  key={m.value}
                  onClick={() => { onChange(m.value); setOpen(false); }}
                >
                  <span>{m.displayName}</span>
                  <span className="tag">
                    {m.isDefault ? "默认" : null}
                    {m.isReasoning ? " · 推理" : ""}
                    {m.priceFactor !== undefined && m.priceFactor !== 1 ? ` · ${m.priceFactor}x` : ""}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
