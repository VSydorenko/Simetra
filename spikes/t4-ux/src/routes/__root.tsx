import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router"
import { useEffect, useState, type ReactNode } from "react"
import type { RouterContext } from "../router"
import { getSession } from "../server/fns"
import { useHolder } from "../t4/hooks"
import { verifyAfterHydration } from "../t4/ssr"
import { css } from "../ui/styles"

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context }) => {
    // Суб'єкт визначає сервер (cookie сесії). На клієнті після гідратації
    // ядро вже є; запит сесії йде лише без ядра (вхід/вихід).
    if (!context.holder.core) {
      const { subject, rightsVersion } = await getSession()
      context.holder.ensure(subject)
      context.holder.rightsVersion = rightsVersion
    }
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "T4 UX spike" },
    ],
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

function Hydration() {
  const holder = useHolder()
  const [reason, setReason] = useState<string | null>(null)
  useEffect(() => {
    ;(window as unknown as { __t4Hydrated?: number }).__t4Hydrated =
      performance.now()
    // Лише полігон: тести імітують сигнали спайку 3 через Writer ядра.
    ;(window as any).__t4Holder = holder
    const core = holder.core
    const meta = holder.snapshotMeta
    if (!core || !meta) return
    // Одноразово: StrictMode повторює ефект, звірка й endHydration — ні.
    holder.snapshotMeta = null
    core.endHydration()
    void verifyAfterHydration(core, meta).then((outcome) => {
      ;(window as any).__t4Verify = outcome
      if (outcome === "rights-changed" || outcome === "subject-changed")
        setReason(outcome)
    })
  }, [holder])
  // Слот причини винятку безпеки: зарезервований, без зсуву розмітки.
  return (
    <div className="security" data-security={reason ?? ""}>
      {reason ? "Доступ змінився — дані приховано. Оновіть сторінку." : ""}
    </div>
  )
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
        <Hydration />
        <Scripts />
      </body>
    </html>
  )
}
