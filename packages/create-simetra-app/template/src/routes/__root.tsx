import {
  createRootRouteWithContext,
  HeadContent,
  redirect,
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

// Маршрути без даних: решта потребує сесії
const PUBLIC_PATHS = new Set(["/", "/login"])

// Сесію й рантайм кореня встановлює `host.establish`; значення `beforeLoad`
// дегідрується, тому він нічого не повертає (текст його помилок і тримач у
// дегідрований стан не йдуть, §4.2).
export const Route = createRootRouteWithContext<AppRouterContext>()({
  beforeLoad: async ({ context, location }) => {
    await context.host.establish(context)
    // Без сесії чи з анонімною (рантайму немає) сторінка з даними веде на вхід;
    // знімка в HTML тоді теж немає
    if (context.data === null && !PUBLIC_PATHS.has(location.pathname)) {
      throw redirect({ to: "/login", replace: true })
    }
  },
  shellComponent: RootDocument,
  component: Layout,
  errorComponent: RootError,
})
