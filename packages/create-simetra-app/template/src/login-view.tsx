import { useRouter } from "@tanstack/react-router"
import { useState, type FormEvent } from "react"
import type { HostScope } from "./host-scope"
import type { LoginMethods } from "./server/login-methods"
import {
  requestEmailCode,
  signIn,
  signInWithEmailCode,
  signInWithProvider,
  type ActionResult,
} from "./session-actions"

/**
 * Форма входу: доступна й із живою сесією (без перенаправлення), бо вхід
 * іншого користувача поверх живої сесії — окремий випадок, який host мусить
 * витримати. Показує лише ввімкнені способи.
 */
export function LoginView({
  scope,
  methods,
}: {
  scope: HostScope
  methods: LoginMethods
}) {
  const router = useRouter()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  // Адреса, на яку надіслано код: `undefined` — перший крок
  const [codeFor, setCodeFor] = useState<string | undefined>()

  async function run(action: () => Promise<ActionResult>): Promise<boolean> {
    setBusy(true)
    const result = await action()
    setBusy(false)
    setError(result.ok ? undefined : result.code)
    return result.ok
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const ok = await run(() =>
      signIn(
        scope,
        String(form.get("email") ?? ""),
        String(form.get("password") ?? "")
      )
    )
    if (ok) await router.navigate({ to: "/clients" })
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (codeFor === undefined) {
      const email = String(form.get("email") ?? "")
      if (await run(() => requestEmailCode(email))) setCodeFor(email)
      return
    }
    const ok = await run(() =>
      signInWithEmailCode(scope, codeFor, String(form.get("code") ?? ""))
    )
    if (ok) await router.navigate({ to: "/clients" })
  }

  return (
    <div data-region="login">
      {!methods.password ? null : (
        <form
          data-method="password"
          onSubmit={(event) => void submitPassword(event)}
        >
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            Sign in
          </button>
        </form>
      )}
      {!methods.emailCode ? null : (
        <form
          data-method="email-code"
          onSubmit={(event) => void submitCode(event)}
        >
          {codeFor === undefined ? (
            <label>
              Email
              <input name="email" type="email" autoComplete="email" required />
            </label>
          ) : (
            <label>
              Code
              <input
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
            </label>
          )}
          <button type="submit" disabled={busy}>
            {codeFor === undefined ? "Send code" : "Sign in with code"}
          </button>
        </form>
      )}
      {methods.providers.map((provider) => (
        <button
          key={provider}
          type="button"
          data-provider={provider}
          disabled={busy}
          onClick={() => void run(() => signInWithProvider(provider))}
        >
          Sign in with {provider}
        </button>
      ))}
      {error === undefined ? null : (
        <p role="alert" data-simetra-error={error}>
          {error}
        </p>
      )}
    </div>
  )
}
