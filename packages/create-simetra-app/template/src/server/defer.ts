import { useRequest } from "nitro/context"

/**
 * Фонова робота поза відповіддю: її беруть і рантайм, і Better Auth
 * (`advanced.backgroundTasks`). Окремий модуль, бо `auth.ts` імпортує й
 * e2e-фікстура поза Nitro, а `runtime.ts` тягнув би за собою пул, каталог і
 * `#instrument`.
 *
 * `waitUntil` береться на кожен виклик з поточного запиту: рантайм на рівні
 * модуля переживає перший запит, а його `waitUntil` після відповіді вже мертвий.
 */
export function defer(work: Promise<unknown>): void {
  const request = useRequest()
  if (typeof request.waitUntil === "function") {
    request.waitUntil(work)
    return
  }
  // Платформа без `waitUntil`: робота не губиться, а її збій — у журнал
  work.catch((error: unknown) => console.error("[simetra] deferred", error))
}
