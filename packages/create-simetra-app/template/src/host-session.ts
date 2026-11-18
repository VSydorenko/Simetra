import type { DataRuntime, DataLogEntry } from "simetra/data"
import type { DataTransport } from "simetra/model"
import { app } from "./app"
import { clientTransport } from "./data-transport"
import type { AppRouterContext, HostScope } from "./host-scope"

/** Журнал рантайму даних: у журнал host-а, не клієнту. */
function log(entry: DataLogEntry): void {
  console.warn("[simetra] data runtime", entry)
}

// Рд19: `Country` — повністю, `Client` — вікном
const RESIDENCY = {
  "Catalog.Country": "full",
  "Catalog.Client": "window",
} as const

/** `strict` лише в dev-збірці: у production `full` над межею не валить екран (П4-B §6.1). */
const STRICT = import.meta.env.DEV

/**
 * Лише те, що мусить бути вирішено в місці виклику: хто користувач, куди йде
 * запит і чи видима вкладка. Решта — спільні опції host-а.
 */
export function createHostRuntime(options: {
  subject: string
  transport: DataTransport
  visible: boolean
  onSessionChanged?: () => void
  onStaleClient?: (object: string) => void
}): DataRuntime {
  return app.createRuntime({
    ...options,
    residency: RESIDENCY,
    strict: STRICT,
    log,
  })
}

/** Рантайм клієнта суб'єкта: транспорт `dataFn`, початкова видимість з `document`. */
export function createClientRuntime(
  scope: HostScope,
  subject: string
): DataRuntime {
  const runtime: DataRuntime = createHostRuntime({
    subject,
    transport: clientTransport(scope.holder, scope.toLogin),
    visible: !document.hidden,
    // T4 уже закрив рантайм, що повідомив; заміна лише якщо він іще поточний:
    // пізній виклик старого рантайму не має закрити рантайм нового користувача
    onSessionChanged: () => {
      if (scope.holder.current() !== runtime) return
      scope.holder.replace(undefined, "session-changed")
      scope.toLogin()
    },
    onStaleClient: () => scope.stale.mark(),
  })
  return runtime
}

/**
 * Сервер, `beforeLoad` кореня. Рантайм на запит (на рівні модуля його бути не
 * може: знімок несе дані лише суб'єкта цього запиту). Без сесії чи з анонімною
 * (її тут уже немає, Дх11) рантайму й тримача в контексті немає. `context`
 * змінюється, а не повертається: значення `beforeLoad` роутер дегідрує, а
 * тримач не серіалізується.
 */
export function establishServerSession<C extends { sub: string }>(
  scope: HostScope,
  context: AppRouterContext,
  claims: C | null,
  transportFor: (claims: C) => DataTransport
): void {
  if (claims === null) {
    context.data = null
    return
  }
  scope.holder.replace(
    createHostRuntime({
      subject: claims.sub,
      transport: transportFor(claims),
      // Сервер не показує застосунок: `resume()` він не кличе
      visible: false,
    })
  )
  // Рендер іще йде після `dehydrate()`, тож закриваємо, коли відповідь завершена
  scope.onResponseEnd(() => scope.holder.replace(undefined, "disposed"))
  context.data = scope.holder
}

/**
 * Клієнт, `beforeLoad` кореня під час навігації: сесію клієнт не опитує.
 * Тримач на клієнті змінюють лише форма входу й вихід (вони кличуть
 * `scope.holder.replace(...)` самі: ШОВ для форми входу, задача 14), а розрив
 * сесії в іншій вкладці ловить `session-changed` з `dataFn` (Дх14). Тут лише
 * віддаємо маршрутам те, що тримач тримає зараз.
 */
export function clientContext(
  scope: HostScope,
  context: AppRouterContext
): void {
  context.data = scope.holder.current() === undefined ? null : scope.holder
}
