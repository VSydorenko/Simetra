import {
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router"
import type { ReactNode } from "react"
import type { AppRouterContext } from "../host-scope"
import { RootError, RootLayout } from "../root-view"

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function Layout() {
  const { host } = Route.useRouteContext()
  return <RootLayout scope={host} />
}

// Сесію й рантайм кореня встановлює `host.establish`; значення `beforeLoad`
// дегідрується, тому він нічого не повертає (текст його помилок і тримач у
// дегідрований стан не йдуть, §4.2).
export const Route = createRootRouteWithContext<AppRouterContext>()({
  beforeLoad: async ({ context }) => {
    await context.host.establish(context)
  },
  shellComponent: RootDocument,
  component: Layout,
  errorComponent: RootError,
})
