import {
  Link,
  Outlet,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { useEffect, useMemo, useSyncExternalStore } from "react"
import { DataRuntimeProvider } from "simetra/data/react"
import { routerNavigation } from "simetra/shell"
import { NavigationProvider } from "simetra/ui"
import { app } from "./app"
import { errorCode } from "./host-errors"
import type { HostScope } from "./host-scope"
import { signOut } from "./session-actions"
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

/** Вихід видно лише там, де є що закривати: поки тримач держить рантайм. */
function SignOut({ scope }: { scope: HostScope }) {
  const router = useRouter()
  const signedIn = useSyncExternalStore(
    scope.holder.subscribe,
    () => scope.holder.current() !== undefined,
    () => scope.holder.current() !== undefined
  )
  if (!signedIn) return null
  return (
    <button
      type="button"
      data-action="sign-out"
      onClick={() => {
        void signOut(scope).then((result) => {
          if (result.ok) void router.navigate({ to: "/login", replace: true })
        })
      }}
    >
      Sign out
    </button>
  )
}

/** Макет кореня: провайдери T5, слот банера над маршрутом і ефект гідратації. */
export function RootLayout({ scope }: { scope: HostScope }) {
  const router = useRouter()
  // Адаптер на роутер: новий на кожен кадр перезапускав би блокувальник
  const navigation = useMemo(() => routerNavigation(router), [router])
  // Один раз на гідратацію: звірка, `data-hydrated`, видимість
  useEffect(() => startClient(scope, document, window), [scope])
  return (
    <app.Provider>
      <NavigationProvider adapter={navigation}>
        <DataRuntimeProvider holder={scope.holder}>
          <StaleBanner scope={scope} />
          <nav>
            <Link to="/clients">Clients</Link>{" "}
            <Link to="/countries">Countries</Link> <SignOut scope={scope} />
          </nav>
          <Outlet />
        </DataRuntimeProvider>
      </NavigationProvider>
    </app.Provider>
  )
}
