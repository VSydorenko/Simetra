// Ключі сигналів для тестів генеруються на запуск: приватного ключа в git немає
// навіть як фікстури (Р3).
export interface TestKey {
  kid: string
  privateJwk: { kty: string; crv: string; x: string; d: string }
  addedAt: string
  retiredAt?: string
}

export async function generateKey(
  kid: string,
  addedAt = "2020-01-01T00:00:00.000Z"
): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
  return {
    kid,
    privateJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x!, d: jwk.d! },
    addedAt,
  }
}

/** Ключ, чий `x` належить іншій парі: форма правильна, пара ні. */
export async function mismatchedKey(kid: string): Promise<TestKey> {
  const key = await generateKey(kid)
  const other = await generateKey(`${kid}-other`)
  key.privateJwk.x = other.privateJwk.x
  return key
}
