import { Outlet, type ErrorComponentProps } from "@tanstack/react-router"
import { useEffect, useSyncExternalStore } from "react"
import { errorCode } from "./host-errors"
import type { HostScope } from "./host-scope"
import { startClient } from "./visibility"

/** `errorComponent` кореня: лише код, ніколи `message` (§4.2). */
export function RootError({ error }: ErrorComponentProps) {
  return (
    <main role="alert" data-simetra-error={errorCode(error)}>
      <p>{errorCode(error)}</p>
    </main>
  )
}

function StaleBanner({ scope }: { scope: HostScope }) {
  const stale = useSyncExternalStore(
    scope.stale.subscribe,
    scope.stale.isStale,
    () => false
  )
  if (!stale) return null
  return (
    <div role="alert" data-simetra-stale>
      <span>Потрібне оновлення застосунку</span>{" "}
      <button type="button" onClick={() => window.location.reload()}>
        Оновити
      </button>
    </div>
  )
}

/** Макет кореня: слот банера над маршрутом і ефект гідратації. */
export function RootLayout({ scope }: { scope: HostScope }) {
  // Один раз на гідратацію: звірка, `data-hydrated` (Д-8), видимість
  useEffect(() => startClient(scope, document, window), [scope])
  return (
    <>
      <StaleBanner scope={scope} />
      <Outlet />
    </>
  )
}
