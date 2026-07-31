import { HashRouter } from "react-router-dom";
import { AppShell } from "./layout/AppShell";

export function App() {
  return (
    <HashRouter>
      <AppShell />
    </HashRouter>
  );
}
