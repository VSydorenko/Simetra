import {
  CENTRIFUGO_CHANNEL_MAX,
  ZERO_UUID,
  channelTopic,
  type SessionClaims,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import { isChannelGrant } from "../signals/grant"
import { failureOf } from "./fake-database"
import {
  COMMIT,
  CURRENT_USER,
  OPEN,
  READ_BEGIN,
  ROLLBACK,
  USER,
  create,
  readSetup,
  session,
  setup,
  type Override,
} from "./harness"

/**
 * `runtime.authorizeChannels` на порт-фейку (спека П4-B §8.3; Р5, Р12 плану
 * B2): що йде в базу, а що відмовляє до неї, і що несе грант. Чи справді
 * оракул відсіює чужий скоуп, вирішує Postgres — DB-тест designer
 * `authorize-channels`.
 */

// Роль запиту профілю supabase обв'язки.
const REQUEST_ROLE = "authenticated"
const CHANNELS_TEXT =
  'SELECT c AS channel FROM pg_catalog.unnest($1::text[]) AS c WHERE "simetra"."signal_topic_allowed"(c, false)'
const channelsCall = (...channels: string[]) => ({
  text: CHANNELS_TEXT,
  params: [`{${channels.map((c) => `"${c}"`).join(",")}}`],
})
const topic = (n: number) =>
  channelTopic({
    kind: "changes",
    scopeKindId: ZERO_UUID,
    scope: ZERO_UUID,
    object: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  })
const [A, B, C] = [topic(1), topic(2), topic(3)]
/** Оракул бази дозволяє рівно `allowed` з запитаних. */
const allowing =
  (...allowed: string[]): Override =>
  (text) =>
    text === CHANNELS_TEXT
      ? { rows: allowed.map((channel) => ({ channel })) }
      : undefined
const opened = [
  { connect: true },
  READ_BEGIN,
  readSetup(REQUEST_ROLE),
  CURRENT_USER,
]
const plain = (grant: unknown) => ({ ...(grant as object) })

describe("runtime.authorizeChannels", () => {
  it("one READ ONLY transaction under the request role: the user from current_user_id(), the allowed channels sorted and deduplicated", async () => {
    const { runtime, db } = await setup(allowing(C, A))
    const grant = await runtime.authorizeChannels(session, [C, B, A, C, A])
    expect(db.calls).toEqual([
      ...opened,
      channelsCall(A, B, C),
      COMMIT,
      { release: false },
    ])
    // `sub` сесії — "user-1": суб'єкт гранту — відповідь бази (Р12).
    expect(plain(grant)).toEqual({ subject: USER, channels: [A, C] })
    expect(isChannelGrant(grant)).toBe(true)
    expect(Object.isFrozen(grant.channels)).toBe(true)
  })

  it("a channel the database did not answer is not in the grant", async () => {
    const { runtime } = await setup(allowing())
    expect(plain(await runtime.authorizeChannels(session, [A, B]))).toEqual({
      subject: USER,
      channels: [],
    })
  })

  it("no valid user: no channel query, a grant without a subject and channels", async () => {
    const { runtime, db } = await setup((text) =>
      text.includes("current_user_id")
        ? { rows: [{ user_id: null }] }
        : allowing(A)(text, [])
    )
    const grant = await runtime.authorizeChannels(session, [A])
    expect(db.calls).toEqual([...opened, COMMIT, { release: false }])
    expect(plain(grant)).toEqual({ subject: null, channels: [] })
    expect(isChannelGrant(grant)).toBe(true)
  })

  it("no channels asked: the user only, for the connection token", async () => {
    const { runtime, db } = await setup()
    const grant = await runtime.authorizeChannels(session, [])
    expect(db.calls).toEqual([...opened, COMMIT, { release: false }])
    expect(plain(grant)).toEqual({ subject: USER, channels: [] })
  })

  it.each([true, "true"])(
    "an anonymous session (claim %j) gets an empty grant without the database",
    async (claim) => {
      const { runtime, db } = await setup(allowing(A))
      const grant = await runtime.authorizeChannels(
        { ...session, is_anonymous: claim },
        [A]
      )
      expect(db.calls).toEqual([])
      expect(plain(grant)).toEqual({ subject: null, channels: [] })
      expect(isChannelGrant(grant)).toBe(true)
    }
  )

  it.each([
    ["without the anonymous claim", { sub: "user-1" }],
    ["without a subject", { is_anonymous: false }],
  ])(
    "refuses a session %s as command.unauthenticated before the database",
    async (_, claims) => {
      const { runtime, db } = await setup()
      // Сесію з тіла запиту host типу не проходить.
      const raw = claims as unknown as SessionClaims
      expect(await failureOf(runtime.authorizeChannels(raw, [A]))).toEqual({
        code: "command.unauthenticated",
      })
      expect(db.calls).toEqual([])
    }
  )

  it("256 channels go to the database, 257 are refused before it", async () => {
    const many = Array.from({ length: 257 }, (_, i) => topic(i))
    const { runtime, db } = await setup()
    await runtime.authorizeChannels(session, many.slice(0, 256))
    expect(db.calls).toHaveLength(7)
    db.calls.splice(0)
    expect(await failureOf(runtime.authorizeChannels(session, many))).toEqual({
      code: "command.invalid",
      reason: "batch-too-large",
    })
    // Межа — за числом запитаних, до дедуплікації: повтори теж важать.
    expect(
      await failureOf(
        runtime.authorizeChannels(
          session,
          Array.from({ length: 257 }, () => A)
        )
      )
    ).toEqual({ code: "command.invalid", reason: "batch-too-large" })
    expect(db.calls).toEqual([])
  })

  it("a channel over CENTRIFUGO_CHANNEL_MAX UTF-8 bytes is refused before the database", async () => {
    const { runtime, db } = await setup()
    await runtime.authorizeChannels(session, [
      "x".repeat(CENTRIFUGO_CHANNEL_MAX),
    ])
    expect(db.calls).toHaveLength(7)
    db.calls.splice(0)
    for (const long of [
      "x".repeat(CENTRIFUGO_CHANNEL_MAX + 1),
      // 128 символів, 256 байтів: межа Centrifugo — в октетах.
      "ї".repeat(128),
    ]) {
      expect(
        await failureOf(runtime.authorizeChannels(session, [A, long]))
      ).toEqual({ code: "command.invalid", reason: "too-large", path: "1" })
    }
    // Анонім теж: межі — до розгалуження за видом сесії.
    expect(
      await failureOf(
        runtime.authorizeChannels({ ...session, is_anonymous: true }, [
          "x".repeat(CENTRIFUGO_CHANNEL_MAX + 1),
        ])
      )
    ).toEqual({ code: "command.invalid", reason: "too-large", path: "0" })
    expect(db.calls).toEqual([])
  })

  it("a non-string channel is command.invalid before the database", async () => {
    const { runtime, db } = await setup()
    expect(
      await failureOf(
        runtime.authorizeChannels(session, [A, 1 as unknown as string])
      )
    ).toEqual({ code: "command.invalid", path: "1" })
    expect(db.calls).toEqual([])
  })

  it("inside a hook it is command.nested and takes no connection", async () => {
    const inner: unknown[] = []
    const { db, runtime } = await setup(undefined, {
      objectModules: {
        "Catalog.Client": {
          async beforeWrite({ draft }) {
            inner.push(await failureOf(runtime.authorizeChannels(session, [A])))
            return draft
          },
        },
      },
    })
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.nested",
    })
    expect(inner).toEqual([{ code: "command.nested" }])
    expect(db.calls).toEqual([...OPEN, ROLLBACK, { release: false }])
  })

  it("an answer outside the request is an anomaly: rolled back, logged, command.internal", async () => {
    const { runtime, db, log } = await setup(allowing(A, B))
    expect(await failureOf(runtime.authorizeChannels(session, [A]))).toEqual({
      code: "command.internal",
    })
    expect(db.calls.slice(-2)).toEqual([ROLLBACK, { release: false }])
    expect(log).toHaveBeenCalledTimes(1)
  })

  it("a database error of the oracle is mapped and rolls back", async () => {
    const { runtime, db } = await setup((text) =>
      text === CHANNELS_TEXT
        ? { error: Object.assign(new Error("denied"), { code: "42501" }) }
        : undefined
    )
    expect(await failureOf(runtime.authorizeChannels(session, [A]))).toEqual({
      code: "command.forbidden",
      reason: "rls",
    })
    expect(db.calls.slice(-2)).toEqual([ROLLBACK, { release: false }])
  })

  it("a COMMIT that answers ROLLBACK grants nothing", async () => {
    // Перший `COMMIT` — транзакції створення рантайму.
    let commits = 0
    const { runtime, log } = await setup((text) =>
      text === "COMMIT" && commits++ > 0
        ? { command: "ROLLBACK" }
        : allowing(A)(text, [])
    )
    expect(await failureOf(runtime.authorizeChannels(session, [A]))).toEqual({
      code: "command.internal",
    })
    expect(log).toHaveBeenCalledTimes(1)
  })
})
