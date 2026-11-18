import { useRouter } from "@tanstack/react-router"
import { useState, type FormEvent } from "react"
import type { HostScope } from "./host-scope"
import { signIn } from "./session-actions"

/**
 * Форма входу: доступна й із живою сесією (без перенаправлення), бо вхід
 * іншого користувача поверх живої сесії — окремий випадок, який host мусить
 * витримати.
 */
export function LoginView({ scope }: { scope: HostScope }) {
  const router = useRouter()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    const result = await signIn(
      scope,
      String(form.get("email") ?? ""),
      String(form.get("password") ?? "")
    )
    setBusy(false)
    if (!result.ok) {
      setError(result.code)
      return
    }
    setError(undefined)
    await router.navigate({ to: "/clients" })
  }

  return (
    <form data-region="login" onSubmit={(event) => void submit(event)}>
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
      {error === undefined ? null : (
        <p role="alert" data-simetra-error={error}>
          {error}
        </p>
      )}
    </form>
  )
}
