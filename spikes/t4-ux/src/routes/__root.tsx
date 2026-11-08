import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { useEffect, type ReactNode } from 'react'
import type { RouterContext } from '../router'
import { getSession } from '../server/fns'
import { css } from '../ui/styles'

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context }) => {
    // Суб'єкт визначає сервер (cookie сесії). На клієнті після гідратації
    // ядро вже є; запит сесії йде лише без ядра (вхід/вихід).
    if (!context.holder.core) {
      const { subject } = await getSession()
      context.holder.ensure(subject)
    }
  },
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'T4 UX spike' }],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function HydratedMark() {
  useEffect(() => {
    ;(window as unknown as { __t4Hydrated?: number }).__t4Hydrated = performance.now()
  }, [])
  return null
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="uk">
      <head>
        <HeadContent />
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        <div id="app">{children}</div>
        <HydratedMark />
        <Scripts />
      </body>
    </html>
  )
}
