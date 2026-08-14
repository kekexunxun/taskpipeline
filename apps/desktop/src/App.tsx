import { HashRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { AppShell } from './layout/AppShell'

export function App() {
  return (
    <HashRouter>
      <AppShell />
      <Toaster position="bottom-right" toastOptions={{ style: { fontSize: 12 } }} />
    </HashRouter>
  )
}
