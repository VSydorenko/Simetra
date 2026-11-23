import { createRouter } from "@tanstack/react-router"
import { createIsomorphicFn } from "@tanstack/react-start"
import type { DataSnapshot } from "simetra/data"
import { markHydrated } from "#instrument"
import { sanitizeMatchErrors } from "./host-errors"
import {
  createHostScope,
  type AppRouterContext,
  type HostScope,
} from "./host-scope"
import {
  createClientRuntime,
  establishServerSession,
  clientContext,
} from "./host-session"
import { routeTree } from "./routeTree.gen"
import { signalsConfig } from "./server/config"
import { sessionClaims } from "./server/session"
import { clientSignals } from "./signals-client"
import { ssrTransport } from "./server/ssr-transport"

// Розрізнення сервер/клієнт — будовою (компілятор Start прибирає чужу гілку з
// чужої збірки), як і в `sessionClaims`: серверний транспорт у клієнтський
// пакет не потрапляє.
const establishSession = createIsomorphicFn()
  .server(async (scope, context: AppRouterContext) => {
    establishServerSession(scope, context, await sessionClaims(), (claims) =>
      ssrTransport(claims)
    )
  })
  .client((scope, context: AppRouterContext) => {
    clientContext(scope, context)
    return Promise.resolve()
  })

// Сервер сигналів не збирає (І8): клієнтська гілка — єдине місце, що тягне
// `centrifuge`, а компілятор Start прибирає її із серверної збірки
const signalsFactory = createIsomorphicFn()
  .server(
    (
      _scope: Pick<HostScope, "holder" | "toLogin">,
      _url: string
    ): ReturnType<typeof clientSignals> | undefined => undefined
  )
  .client((scope, url) => clientSignals(scope, url))

let signalsUrlCache: string | undefined

/**
 * Адреса Centrifugo лише для SSR (Р10): ключів підпису клієнт не бачить ніколи.
 * Конфіг перевірено на старті, тож розбір і звірка ключів на кожен `dehydrate`
 * зайві: адреса береться один раз на процес.
 */
const serverSignalsUrl = createIsomorphicFn()
  .server(() => (signalsUrlCache ??= signalsConfig()?.url))
  .client(() => undefined)

/** Що сервер віддає клієнту крім розмітки: знімок рантайму суб'єкта сесії. */
type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json }

/** `data` — знімок T4: за його контрактом це чистий JSON; `null` — сесії чи рантайму немає. */
interface Dehydrated {
  data: Json
  /** Лише адреса: не змінна збірки, а те, що сервер читає з оточення (Р10). */
  signalsUrl?: string
}

/** Фабрика на кожен запит (§4.6): рантайм і тримач живуть не довше запиту. */
export function getRouter() {
  const scope = createHostScope({
    toLogin: () => void router.navigate({ to: "/login", replace: true }),
    onResponseEnd: (action) => {
      // Без `serverSsr` закрити рантайм запиту нічим: це збій, а не пропуск
      if (router.serverSsr === undefined) {
        throw new Error("serverSsr is missing: the request runtime would leak")
      }
      router.serverSsr.onCleanup(action)
    },
    markHydrated,
    createSignals: (url) => signalsFactory(scope, url),
    establish: (self, context) => establishSession(self, context),
  })

  const context: AppRouterContext = { data: null, host: scope }
  const router = createRouter({
    routeTree,
    context,
    // Перехід чекає перечитування застарілих даних: екран не показує старе
    defaultStaleReloadMode: "blocking",
    // Індикатор очікування не мерехтить: loader-и даних чекаються SSR
    defaultPendingMs: 60_000,
    defaultPendingMinMs: 0,
    dehydrate: (): Dehydrated => {
      const runtime = scope.holder.current()
      const signalsUrl = serverSignalsUrl()
      return {
        data:
          runtime === undefined
            ? null
            : (runtime.dehydrate() as unknown as Json),
        ...(signalsUrl === undefined ? {} : { signalsUrl }),
      }
    },
    hydrate: (dehydrated) => {
      const { data, signalsUrl } = dehydrated as Dehydrated
      // До рантайму й навіть без знімка: вхід з форми теж створює рантайм із сигналами
      if (typeof signalsUrl === "string") scope.signalsUrl = signalsUrl
      if (data === null) return
      try {
        scope.holder.hydrateFrom(data as unknown as DataSnapshot, (subject) =>
          createClientRuntime(scope, subject)
        )
      } catch (error) {
        // Негідний знімок не валить гідратацію роутера: клієнт лишається без
        // даних, як анонімний
        console.error("[simetra] snapshot rejected", error)
        return
      }
      scope.hydrated = true
      context.data = scope.holder
    },
  })

  // Текст помилки loader-а чи `pg` (хост, роль) не має потрапити в дегідрований
  // стан: до `dehydrate()` помилки збігів стають помилками лише з кодом (§4.2)
  const load = router.load.bind(router)
  router.load = async (options) => {
    try {
      await load(options)
    } finally {
      if (router.serverSsr !== undefined) {
        sanitizeMatchErrors(router.state.matches, (error) =>
          console.error("[simetra] route error", error)
        )
      }
    }
  }
  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
