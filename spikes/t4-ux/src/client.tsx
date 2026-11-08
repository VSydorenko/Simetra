// Власний клієнтський entry: той самий, що типовий у Start, плюс вимірювання
// для оракула — лічильник commit-ів React Profiler і onRecoverableError.
import { Profiler, StrictMode, startTransition } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { StartClient } from '@tanstack/react-start/client'
import { readBreaks } from './t4/breaks'
import { control } from './server/fns'
import { settings } from './t4/facade'

interface OracleWindow {
  __t4Commits?: Array<{ id: string; phase: string; t: number }>
  __t4Recoverable?: Array<{ message: string; t: number }>
}
const w = window as unknown as OracleWindow
w.__t4Commits = []
w.__t4Recoverable = []
const params = new URLSearchParams(location.search)
readBreaks(params.get('break'))
if (params.get('policy') === 'await') settings.policy = 'await'
// Лише полігон: керування фейковим сервером із тестів.
;(window as unknown as { __t4Control: unknown }).__t4Control = (c: Parameters<typeof control>[0]['data']) => control({ data: c })

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <Profiler id="app" onRender={(id, phase) => w.__t4Commits!.push({ id, phase, t: performance.now() })}>
        <StartClient />
      </Profiler>
    </StrictMode>,
    {
      onRecoverableError: (error) => {
        w.__t4Recoverable!.push({ message: String((error as Error)?.message ?? error), t: performance.now() })
      },
    },
  )
})
