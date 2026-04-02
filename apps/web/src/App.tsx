import { TooltipProvider } from '@workspace/ui/components/tooltip'
import { AppShell } from './components/layout/app-shell'

export function App() {
  return (
    <TooltipProvider>
      <AppShell />
    </TooltipProvider>
  )
}
