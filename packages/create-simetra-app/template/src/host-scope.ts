import { createRuntimeHolder, type RuntimeHolder } from "simetra/data"
import type { SignalTransport } from "simetra/model"
import type { SimetraRouterContext } from "simetra/shell"
import { createTabBus, type TabBus, type TabChannel } from "./tab-bus"

/** Банер «потрібне оновлення застосунку»: клієнт зі застарілим каталогом. */
export interface StaleBanner {
  mark(): void
  isStale(): boolean
  subscribe(listener: () => void): () => void
}

export function createStaleBanner(): StaleBanner {
  let stale = false
  const listeners = new Set<() => void>()
  return {
    mark() {
      if (stale) return
      stale = true
      for (const listener of [...listeners]) listener()
    },
    isStale: () => stale,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Усе, що host тримає на один роутер (а на сервері — на один запит): тримач
 * рантайму, банер, ознаки гідратації й те, що залежить від самого роутера.
 */
export interface HostScope {
  readonly holder: RuntimeHolder
  readonly stale: StaleBanner
  /** Шина вкладок: вихід в одній вкладці гасить решту (Р11). */
  readonly tabs: TabBus
  /** Адреса Centrifugo із знімка сервера (Р10); без неї клієнт працює без сигналів. */
  signalsUrl: string | undefined
  /** Фабрика сигналів за адресою: лише клієнт (на сервері `centrifuge` не вантажиться, І8). */
  readonly createSignals:
    | ((url: string) => ((subject: string) => SignalTransport) | undefined)
    | undefined
  /** Знімок прийнято через `hydrateFrom`: корінь кличе `endHydration()`. */
  hydrated: boolean
  /** Корінь уже завершив гідратацію (ефект може піти двічі під StrictMode). */
  hydrationEnded: boolean
  /** Перехід на вхід (клієнт). */
  toLogin(): void
  /** Дія після завершення відповіді SSR (сервер): закрити тримач. */
  onResponseEnd(action: () => void): void
  /** Кінець гідратації: `markHydrated()` з `#instrument`. */
  markHydrated(): void
  /** `beforeLoad` кореня: сесія запиту й рантайм у контексті (різна на сервері й клієнті). */
  establish(context: AppRouterContext): Promise<void>
}

/** Контекст роутера шаблону: те, що читають маршрути T6, і власний стан host-а. */
export interface AppRouterContext extends SimetraRouterContext {
  host: HostScope
}

export function createHostScope(
  parts: Pick<HostScope, "toLogin" | "onResponseEnd" | "markHydrated"> & {
    establish(scope: HostScope, context: AppRouterContext): Promise<void>
    createSignals?: HostScope["createSignals"]
    /** Лише для тестів шини. */
    createChannel?: () => TabChannel | undefined
  }
): HostScope {
  const { establish, createChannel, createSignals, ...rest } = parts
  const holder = createRuntimeHolder()
  const scope: HostScope = {
    holder,
    stale: createStaleBanner(),
    tabs: createTabBus({
      holder,
      toLogin: () => rest.toLogin(),
      createChannel,
    }),
    signalsUrl: undefined,
    createSignals,
    hydrated: false,
    hydrationEnded: false,
    ...rest,
    establish: (context) => establish(scope, context),
  }
  return scope
}
