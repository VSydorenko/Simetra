import type { HostScope } from "./host-scope"
import { createClientRuntime } from "./host-session"

/** Відмова входу чи виходу без тексту сервера: інтерфейс показує лише код. */
export type ActionResult = { ok: true } | { ok: false; code: string }

/** Відмова сервера за статусом: збій сервера — не відмова входу, `forbidden` на 5xx вводив би в оману. */
function refusalCode(status: number): string {
  return status >= 500
    ? "command.internal"
    : status === 429
      ? "command.rate-limited"
      : "command.forbidden"
}

/** POST JSON до Better Auth; мережева помилка — `command.internal`. */
async function post(
  path: string,
  body: unknown
): Promise<Response | undefined> {
  try {
    return await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch {
    return undefined
  }
}

/**
 * Спільний хвіст усіх способів входу, що дають сесію (пароль, код): тримач
 * заміняє рантайм сам (шов `clientContext`): рантайм попереднього користувача
 * закривається до першого кадру нового, тож вхід B поверх живої сесії A не
 * лишає значень A в DOM.
 */
async function completeSignIn(
  scope: HostScope,
  response: Response | undefined
): Promise<ActionResult> {
  if (response === undefined) return { ok: false, code: "command.internal" }
  if (!response.ok) return { ok: false, code: refusalCode(response.status) }
  let body: { user?: { id?: unknown } } | null
  try {
    body = (await response.json()) as { user?: { id?: unknown } } | null
  } catch {
    // 2xx не з Better Auth (проксі, сторінка помилки): виняток із `submit` лишив би форму зайнятою
    return { ok: false, code: "command.internal" }
  }
  const id = body?.user?.id
  if (typeof id !== "string") return { ok: false, code: "command.internal" }
  // `sub` сервера — UUID нижнім регістром (`createVerifySession`)
  scope.holder.replace(createClientRuntime(scope, id.toLowerCase()))
  return { ok: true }
}

/** Вхід email і пароль. */
export async function signIn(
  scope: HostScope,
  email: string,
  password: string
): Promise<ActionResult> {
  return completeSignIn(
    scope,
    await post("/api/auth/sign-in/email", { email, password })
  )
}

/** Перший крок коду: сервер надсилає код на адресу; 429 — слот чи ліміт відмовили. */
export async function requestEmailCode(email: string): Promise<ActionResult> {
  const response = await post("/api/auth/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  })
  if (response === undefined) return { ok: false, code: "command.internal" }
  if (!response.ok) return { ok: false, code: refusalCode(response.status) }
  return { ok: true }
}

/** Другий крок коду: успіх іде тим самим шляхом заміни рантайму, що й пароль. */
export async function signInWithEmailCode(
  scope: HostScope,
  email: string,
  otp: string
): Promise<ActionResult> {
  return completeSignIn(
    scope,
    await post("/api/auth/sign-in/email-otp", { email, otp })
  )
}

/**
 * Вхід провайдером: сервер віддає адресу провайдера, далі повна навігація;
 * рантайм заміняє наступне завантаження сторінки після колбека.
 */
export async function signInWithProvider(
  provider: string,
  navigate: (url: string) => void = (url) => window.location.assign(url)
): Promise<ActionResult> {
  const response = await post("/api/auth/sign-in/social", {
    provider,
    callbackURL: "/clients",
  })
  if (response === undefined) return { ok: false, code: "command.internal" }
  if (!response.ok) return { ok: false, code: refusalCode(response.status) }
  let url: unknown
  try {
    url = ((await response.json()) as { url?: unknown } | null)?.url
  } catch {
    return { ok: false, code: "command.internal" }
  }
  if (typeof url !== "string") return { ok: false, code: "command.internal" }
  navigate(url)
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
  const subject = scope.holder.current()?.subject
  scope.holder.replace(undefined, "signed-out")
  // Решта вкладок цього браузера ділить cookie: їхня сесія теж мертва (Р11)
  if (subject !== undefined) scope.tabs.publishSignedOut(subject)
  return { ok: true }
}
