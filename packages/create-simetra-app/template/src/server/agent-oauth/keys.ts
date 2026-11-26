// Portions copied from munin-mcp (https://github.com/VSydorenko/munin-mcp, gateway/src/oauth/keys.ts)
// Copyright 2026 Volodymyr Sydorenko
// Licensed under Apache-2.0. Modified: keys come from the environment (or are ephemeral per process in development) instead of being derived from a master key.
import {
  createHash,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto"
import type { AgentOauthKeys } from "../config"

export interface ProviderKeys {
  cookieKeys: string[]
  /** Приватний JWKS для `oidc-provider` (на `/jwks` бібліотека віддає лише публічні частини). */
  jwks: { keys: Record<string, string>[] }
}

let ephemeral: AgentOauthKeys | undefined

// Розробка без змінних (Р-F4-1): ключі процесу. Після рестарту видані токени
// й cookie недійсні — клієнт підключається знову; попередження одне на процес
function ephemeralKeys(): AgentOauthKeys {
  if (ephemeral !== undefined) return ephemeral
  console.warn(
    "[simetra] SIMETRA_AGENT_OAUTH_COOKIE_KEYS and SIMETRA_AGENT_OAUTH_SIGNING_KEY are not set: the agent authorization server uses ephemeral process keys, so AI clients must reconnect after a restart"
  )
  const jwk = generateKeyPairSync("ed25519").privateKey.export({
    format: "jwk",
  })
  ephemeral = {
    cookieKeys: [randomBytes(32).toString("base64url")],
    signingKey: { kty: "OKP", crv: "Ed25519", x: jwk.x!, d: jwk.d! },
  }
  return ephemeral
}

/** Ключі для конфігу бібліотеки: зі середовища або ефемерні в розробці. */
export function providerKeys(keys: AgentOauthKeys | undefined): ProviderKeys {
  const { cookieKeys, signingKey } = keys ?? ephemeralKeys()
  // RFC 7638: обов'язкові члени OKP у лексикографічному порядку
  const kid = createHash("sha256")
    .update(
      JSON.stringify({
        crv: signingKey.crv,
        kty: signingKey.kty,
        x: signingKey.x,
      })
    )
    .digest("base64url")
  return {
    cookieKeys,
    jwks: { keys: [{ ...signingKey, kid, use: "sig", alg: "EdDSA" }] },
  }
}

// Своя мітка HKDF: ключ хешу входу (Р-F4-9) виводиться з ключа cookie, але
// не збігається з ним, тож журнал подій не дає матеріалу для підробки cookie
const INPUT_HASH_INFO = "simetra/agent-call/input-hash"

/** Ключ HMAC хешу входу в подіях виклику агента: підключ поточного ключа cookie. */
export function agentInputHashKey(
  keys: AgentOauthKeys | undefined
): Uint8Array {
  const [current] = providerKeys(keys).cookieKeys
  return new Uint8Array(
    hkdfSync("sha256", current!, new Uint8Array(0), INPUT_HASH_INFO, 32)
  )
}
