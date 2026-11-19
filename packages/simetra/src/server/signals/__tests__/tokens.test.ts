import { beforeAll, describe, expect, it } from "vitest"
import { createChannelGrant, type ChannelGrant } from "../grant"
import {
  createCentrifugoTokens,
  type PrivateJwk,
  type SignalTokens,
  type SigningKey,
} from "../index"

const NOW = new Date("2026-11-18T12:00:00.000Z")
const NOW_S = NOW.getTime() / 1000
const MIN = 60_000
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN)
const AUD = "centrifugo:demo"
const ISS = "http://127.0.0.1:3000"
const USER = "0b8f6a4e-2c1d-4e5f-8a9b-0c1d2e3f4a5b"
const CH_A =
  "simetra:00000000-0000-0000-0000-000000000000:00000000-0000-0000-0000-000000000000:11111111-1111-4111-8111-111111111111"
const CH_B =
  "simetra:00000000-0000-0000-0000-000000000000:00000000-0000-0000-0000-000000000000:22222222-2222-4222-8222-222222222222"

const ED = { name: "Ed25519" } as const
type KeyPair = { privateKey: Parameters<typeof crypto.subtle.exportKey>[1] }
let jwkA: PrivateJwk
let jwkB: PrivateJwk

async function ed25519(): Promise<PrivateJwk> {
  const pair = (await crypto.subtle.generateKey(ED, true, [
    "sign",
    "verify",
  ])) as KeyPair
  return (await crypto.subtle.exportKey("jwk", pair.privateKey)) as PrivateJwk
}

beforeAll(async () => {
  jwkA = await ed25519()
  jwkB = await ed25519()
})

const create = (keys: SigningKey[], now = NOW) =>
  createCentrifugoTokens({ keys, audience: AUD, issuer: ISS, now: () => now })

const decode = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >

/** Header and claims of a token whose signature checks out with its JWKS key. */
async function verified(tokens: SignalTokens, token: string) {
  const [head, body, signature] = token.split(".") as [string, string, string]
  const header = decode(head)
  const jwk = tokens.jwks().keys.find((k) => k.kid === header.kid)
  expect(jwk, `kid ${String(header.kid)} in jwks`).toBeDefined()
  const key = await crypto.subtle.importKey("jwk", jwk!, ED, false, ["verify"])
  const ok = await crypto.subtle.verify(
    ED,
    key,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${head}.${body}`)
  )
  expect(ok, "signature verifies with the JWKS key").toBe(true)
  return { header, claims: decode(body) }
}

const signerKid = async (tokens: SignalTokens) =>
  (
    await verified(
      tokens,
      (await tokens.connectionToken(createChannelGrant(USER, []))).token
    )
  ).header.kid

describe("createCentrifugoTokens", () => {
  it("the public entry exposes no grant constructor", async () => {
    expect(Object.keys(await import("simetra/server/signals")).sort()).toEqual([
      "SIGNALS_JWKS_PATH",
      "SignalTokenError",
      "createCentrifugoTokens",
    ])
  })

  it("signs a connection token: sub, aud, iss, exp of 15 minutes, kid in the header", async () => {
    const tokens = await create([
      { kid: "a", privateJwk: jwkA, addedAt: ago(600) },
    ])
    const { token, expiresAt } = await tokens.connectionToken(
      createChannelGrant(USER, [CH_A])
    )
    const { header, claims } = await verified(tokens, token)
    expect(header).toEqual({ alg: "EdDSA", typ: "JWT", kid: "a" })
    expect(claims).toEqual({
      sub: USER,
      aud: AUD,
      iss: ISS,
      exp: NOW_S + 15 * 60,
    })
    expect(expiresAt).toEqual(new Date(NOW.getTime() + 15 * MIN))
  })

  it("signs exactly the grant's channels, 5 minutes each", async () => {
    const tokens = await create([
      { kid: "a", privateJwk: jwkA, addedAt: ago(600) },
    ])
    const signed = await tokens.channelTokens(
      createChannelGrant(USER, [CH_A, CH_B])
    )
    expect(signed.map((s) => s.channel)).toEqual([CH_A, CH_B])
    for (const { channel, token, expiresAt } of signed) {
      const { header, claims } = await verified(tokens, token)
      expect(header.kid).toBe("a")
      expect(claims).toEqual({
        sub: USER,
        channel,
        aud: AUD,
        iss: ISS,
        exp: NOW_S + 5 * 60,
      })
      expect(expiresAt).toEqual(new Date(NOW.getTime() + 5 * MIN))
    }
    expect(await tokens.channelTokens(createChannelGrant(USER, []))).toEqual([])
  })

  it("a channel added after the grant was made is not signed", async () => {
    const tokens = await create([
      { kid: "a", privateJwk: jwkA, addedAt: ago(600) },
    ])
    const input = [CH_A]
    const grant = createChannelGrant(USER, input)
    input.push(CH_B)
    expect(() => (grant.channels as string[]).push(CH_B)).toThrow(TypeError)
    const signed = await tokens.channelTokens(grant)
    expect(signed.map((s) => s.channel)).toEqual([CH_A])
  })

  it.each<[string, () => ChannelGrant]>([
    ["a plain object", () => ({ subject: USER, channels: [CH_A] })],
    ["a copy of a real grant", () => ({ ...createChannelGrant(USER, [CH_A]) })],
    [
      "a real grant's prototype",
      () => Object.create(createChannelGrant(USER, [CH_A])) as ChannelGrant,
    ],
  ])("refuses %s as a grant", async (_, forge) => {
    const tokens = await create([
      { kid: "a", privateJwk: jwkA, addedAt: ago(600) },
    ])
    await expect(tokens.connectionToken(forge())).rejects.toMatchObject({
      code: "signals.forged-grant",
    })
    await expect(tokens.channelTokens(forge())).rejects.toMatchObject({
      code: "signals.forged-grant",
    })
  })

  it("a grant without a user gets no token", async () => {
    const tokens = await create([
      { kid: "a", privateJwk: jwkA, addedAt: ago(600) },
    ])
    const grant = createChannelGrant(null, [])
    await expect(tokens.connectionToken(grant)).rejects.toMatchObject({
      code: "signals.no-user",
    })
    await expect(tokens.channelTokens(grant)).rejects.toMatchObject({
      code: "signals.no-user",
    })
  })

  describe("signing key", () => {
    it.each([
      [64, "old"],
      [66, "new"],
    ])(
      "a successor added %i minutes ago: signs with %s",
      async (minutes, kid) => {
        const tokens = await create([
          { kid: "old", privateJwk: jwkA, addedAt: ago(600) },
          { kid: "new", privateJwk: jwkB, addedAt: ago(minutes) },
        ])
        expect(await signerKid(tokens)).toBe(kid)
      }
    )

    it("first run: the oldest young key signs at once", async () => {
      const tokens = await create([
        { kid: "younger", privateJwk: jwkB, addedAt: ago(1) },
        { kid: "older", privateJwk: jwkA, addedAt: ago(2) },
      ])
      expect(await signerKid(tokens)).toBe("older")
    })

    it.each([
      [64, undefined],
      [66, "new"],
    ])(
      "after a retirement, a successor added %i minutes ago signs only when mature",
      async (minutes, kid) => {
        const tokens = await create([
          {
            kid: "old",
            privateJwk: jwkA,
            addedAt: ago(600),
            retiredAt: ago(1),
          },
          { kid: "new", privateJwk: jwkB, addedAt: ago(minutes) },
        ])
        if (kid === undefined) {
          await expect(signerKid(tokens)).rejects.toMatchObject({
            code: "signals.no-mature-key",
          })
        } else {
          expect(await signerKid(tokens)).toBe(kid)
        }
      }
    )

    it("every key retired: no token", async () => {
      const tokens = await create([
        { kid: "a", privateJwk: jwkA, addedAt: ago(600), retiredAt: ago(1) },
      ])
      await expect(signerKid(tokens)).rejects.toMatchObject({
        code: "signals.no-signing-key",
      })
    })
  })

  describe("jwks", () => {
    it.each([
      [19, ["a", "b"]],
      [21, ["b"]],
    ])(
      "a key retired %i minutes ago: published kids %j",
      async (minutes, kids) => {
        const tokens = await create([
          {
            kid: "a",
            privateJwk: jwkA,
            addedAt: ago(600),
            retiredAt: ago(minutes),
          },
          { kid: "b", privateJwk: jwkB, addedAt: ago(300) },
        ])
        expect(tokens.jwks().keys.map((k) => k.kid)).toEqual(kids)
      }
    )

    it("publishes only the whitelisted public members", async () => {
      // Приватний JWK несе `d`, `ext`, `key_ops`: жоден не має дійти до JWKS.
      expect(jwkA.d).toBeTypeOf("string")
      const tokens = await create([
        { kid: "a", privateJwk: jwkA, addedAt: ago(600) },
      ])
      expect(tokens.jwks()).toEqual({
        keys: [
          {
            kty: "OKP",
            crv: "Ed25519",
            x: jwkA.x,
            kid: "a",
            alg: "EdDSA",
            use: "sig",
          },
        ],
      })
    })
  })

  describe("refuses at creation", () => {
    it("a repeated kid", async () => {
      await expect(
        create([
          { kid: "a", privateJwk: jwkA, addedAt: ago(600) },
          { kid: "a", privateJwk: jwkB, addedAt: ago(10) },
        ])
      ).rejects.toMatchObject({ code: "signals.duplicate-kid" })
    })

    it("an RSA key", async () => {
      const pair = (await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"]
      )) as KeyPair
      const rsa = (await crypto.subtle.exportKey(
        "jwk",
        pair.privateKey
      )) as PrivateJwk
      await expect(
        create([{ kid: "r", privateJwk: rsa, addedAt: ago(600) }])
      ).rejects.toMatchObject({ code: "signals.invalid-key" })
    })

    // Імпорт примусово Ed25519, тож справжній матеріал Ed25519 з чужою
    // міткою пройшов би без перевірки `kty`/`crv`.
    it.each([
      ["crv X25519", { crv: "X25519" }],
      ["kty EC", { kty: "EC" }],
    ])("a key labelled %s over Ed25519 material", async (_, label) => {
      await expect(
        create([
          { kid: "a", privateJwk: { ...jwkA, ...label }, addedAt: ago(600) },
        ])
      ).rejects.toMatchObject({ code: "signals.invalid-key" })
    })

    it("an x that is not the public key of d", async () => {
      await expect(
        create([
          { kid: "a", privateJwk: { ...jwkA, x: jwkB.x }, addedAt: ago(600) },
        ])
      ).rejects.toMatchObject({ code: "signals.invalid-key" })
    })
  })
})
