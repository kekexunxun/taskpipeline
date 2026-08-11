import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, getStoredTheme } from "./hooks/useTheme";
import "./styles.css";

// 在首次渲染前应用持久化主题，避免闪烁
applyTheme(getStoredTheme());

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
