import { TooltipProvider } from '@workspace/ui/components/tooltip'
import { Toaster } from '@workspace/ui/components/sonner'
import { AppShell } from './components/layout/app-shell'

export function App() {
  return (
    <TooltipProvider>
      <AppShell />
      <Toaster />
    </TooltipProvider>
  )
}
