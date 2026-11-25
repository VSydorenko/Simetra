import { randomBytes } from "node:crypto"
import { vi } from "vitest"
import { generateKey } from "./signal-keys"

// Ключі сервера авторизації агентів генеруються на запуск: приватного ключа в
// git немає навіть як фікстури (як у `signal-keys.ts`)
export async function agentOauthKeyEnv(): Promise<{
  cookieKeys: string
  signingKey: string
}> {
  const { privateJwk } = await generateKey("agent-oauth")
  return {
    cookieKeys: JSON.stringify([randomBytes(32).toString("base64url")]),
    signingKey: JSON.stringify(privateJwk),
  }
}

/** Обидві змінні ключів у оточенні тесту (`vi.unstubAllEnvs` їх прибирає). */
export async function stubAgentOauthKeys(): Promise<void> {
  const env = await agentOauthKeyEnv()
  vi.stubEnv("SIMETRA_AGENT_OAUTH_COOKIE_KEYS", env.cookieKeys)
  vi.stubEnv("SIMETRA_AGENT_OAUTH_SIGNING_KEY", env.signingKey)
}
