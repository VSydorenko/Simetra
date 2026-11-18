import type { HostScope } from "./host-scope"
import { createClientRuntime } from "./host-session"

/** Відмова входу чи виходу без тексту сервера: інтерфейс показує лише код. */
export type ActionResult = { ok: true } | { ok: false; code: string }

/**
 * Вхід email і пароль. Тримач заміняє рантайм сам (шов `clientContext`):
 * рантайм попереднього користувача закривається до першого кадру нового, тож
 * вхід B поверх живої сесії A не лишає значень A в DOM.
 */
export async function signIn(
  scope: HostScope,
  email: string,
  password: string
): Promise<ActionResult> {
  let response: Response
  try {
    response = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
  } catch {
    return { ok: false, code: "command.internal" }
  }
  if (!response.ok) {
    return {
      ok: false,
      // Збій сервера — не відмова входу: код `forbidden` на 5xx вводив би в оману
      code:
        response.status >= 500
          ? "command.internal"
          : response.status === 429
            ? "command.rate-limited"
            : "command.forbidden",
    }
  }
  const body = (await response.json()) as { user?: { id?: unknown } }
  const id = body.user?.id
  if (typeof id !== "string") return { ok: false, code: "command.internal" }
  // `sub` сервера — UUID нижнім регістром (`createVerifySession`)
  scope.holder.replace(createClientRuntime(scope, id.toLowerCase()))
  return { ok: true }
}

/**
 * Вихід у поточній вкладці. Тримач міняється лише після успіху сервера:
 * невдалий вихід не повинен лишити вкладку без даних при живій сесії.
 */
export async function signOut(scope: HostScope): Promise<ActionResult> {
  let response: Response
  try {
    response = await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  } catch {
    return { ok: false, code: "command.internal" }
  }
  if (!response.ok) return { ok: false, code: "command.internal" }
  scope.holder.replace(undefined, "signed-out")
  return { ok: true }
}
