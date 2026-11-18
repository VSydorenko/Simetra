import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  CommandFailure,
  channelTopic,
  defineObjectModule,
  quoteIdent,
  type MetadataRef,
  type ObjectModule,
  type Operation,
} from "simetra/model"
import {
  createCommandRuntime,
  fromPgPool,
  type CommandRuntime,
} from "simetra/server"
import {
  createCentrifugoTokens,
  type SignalTokens,
  type SigningKey,
} from "simetra/server/signals"
import {
  ORG_ADMIN_ID,
  ORG_KIND_ID,
  PROJECT_TICKET_WRITER_ID,
  RIGHTS_ADMIN_ID,
  TASK_VIEWER_ID,
  TICKET_READER_ID,
  TICKET_TARGETS_READER_ID,
  TICKET_WRITER_ID,
  loginUrl,
  runTag,
  superuserClient,
  testProvider,
  testRoleName,
} from "../../../simetra/test/support"
import { nodeExec, runContainers } from "../../../simetra/test/db/external"
import {
  closeAllClients,
  connectSignals,
  downAllStands,
  grantStandConsumer,
  startJwksServer,
  startSignalStand,
  type JwksServer,
  type SignalClient,
  type SignalStand,
  type SignalSubscription,
} from "../../../simetra/test/db/signal-stand"
import { loginSettingSql } from "../../../simetra/src/schema/apply/platform-roles"
import { centrifugoConfig } from "../tools/signals-config"
import { heldResource, seedUnderMaintenance } from "./support/db"
import {
  ASSIGNMENTS,
  TICKET,
  type Env,
  type Org,
  type Person,
  type Pools,
  addPeople,
  assign,
  heldEnv,
  heldLogin,
  seedOrg,
  unassign,
} from "./rights-admin-commands.support"

/**
 * Гейт доставки сигналу на стенді (рядок «стенд сигналу» §12 П4-B без рядків
 * B5/B6; задача 13 плану B2): команда справжнього рантайму над ціллю,
 * розгорнутою `plan` + `apply`, → outbox → споживач Centrifugo в контейнері
 * прогону → клієнт `centrifuge` з токенами порту `createCentrifugoTokens`
 * над грантом `runtime.authorizeChannels`. Конфіг Centrifugo — вихід
 * генератора `centrifugoConfig` під JWKS цього прогону (Р17). Доставку,
 * відмови токенів, відновлення й межу відкликання вирішує Centrifugo — ні
 * порт-фейк, ні історія HTTP API цього не доводять.
 */

const ORGANIZATION: MetadataRef = { kind: "Catalog", name: "Organization" }
const MINUTE = 60_000
// TTL токена каналу за спекою профілю §6.2; токен Р18 підписано годинником
// порту так, щоб до `exp` лишалося кілька секунд
const CHANNEL_TTL_MS = 5 * MINUTE
const REVOKE_LEAD_MS = 4_000
// Межа відкликання (спека профілю §6.2): `exp` + `expired_sub_close_delay`
// (25 с) + такт присутності (5 с) — обидва ключі пише генератор — + запас
const EXPIRED_SUB_CLOSE_DELAY_MS = 25_000
const PRESENCE_UPDATE_INTERVAL_MS = 5_000
const REVOKE_SLACK_MS = 5_000
// Скільки клієнт чекає публікації, якої не має бути, після контрольної
const QUIET_MS = 500
const WARMUP = 20
const MEASURED = 200

const percentile = (sorted: number[], p: number) =>
  sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!

const b64json = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url")
const decode = (part: string) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >
const headerOf = (token: string) => decode(token.split(".")[0]!)
const claimsOf = (token: string) => decode(token.split(".")[1]!)

/** Ключ Ed25519 у формі JWK порту. */
async function signingKey(
  kid: string,
  addedAt: Date,
  retiredAt?: Date
): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as {
    privateKey: Parameters<typeof crypto.subtle.exportKey>[1]
  }
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
  return {
    kid,
    privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d },
    addedAt,
    ...(retiredAt === undefined ? {} : { retiredAt }),
  }
}

/**
 * Підробки інваріанта 10: заголовок `alg: none` без підпису і HS256, ключ
 * HMAC якого — байти публічного ключа Ed25519 з JWKS.
 */
function forged(token: string, alg: "none" | "HS256", publicX: string) {
  const [header, payload] = token.split(".") as [string, string]
  const head = `${b64json({ ...decode(header), alg })}.${payload}`
  if (alg === "none") return `${head}.`
  const signature = createHmac("sha256", Buffer.from(publicX, "base64url"))
    .update(head)
    .digest("base64url")
  return `${head}.${signature}`
}

export function describeSignalDelivery(): void {
  describe("signal delivery on the signal stand", () => {
    const target = heldEnv()
    let env: Env
    let a: Org
    let b: Org
    let project: string

    beforeAll(async () => {
      env = await target.open()
      a = await seedOrg(env.owner, {
        writer: [TICKET_WRITER_ID],
        reader: [TICKET_READER_ID],
        late: [TICKET_READER_ID],
        member: [],
        rights: [RIGHTS_ADMIN_ID],
        admin: [ORG_ADMIN_ID],
      })
      b = await seedOrg(env.owner, {
        writer: [TICKET_WRITER_ID],
        reader: [TICKET_READER_ID],
      })
      // Писар лише з контейнерною роллю: `ProjectTicketWriter` на проєкті P1
      // і читання цілей посилань (без нього `project` дав би
      // `command.invalid` раніше за перевірку права)
      project = randomUUID()
      await seedUnderMaintenance(env.owner, async () => {
        await env.owner.query(
          "INSERT INTO public.project (id, org_id) VALUES ($1, $2)",
          [project, a.id]
        )
        await addPeople(env.owner, a, {
          container: [TICKET_TARGETS_READER_ID],
        })
        await env.owner.query(
          "INSERT INTO public.org_role_assignments (id, org_id, subject, archetype, container) VALUES ($1, $2, $3, $4, $5)",
          [
            randomUUID(),
            a.id,
            a.people.container!.member,
            PROJECT_TICKET_WRITER_ID,
            project,
          ]
        )
      })
    }, 180_000)
    afterAll(() => target.close(), 60_000)

    // Рантайм — над роллю входу форми `simetra_runtime`, після розгортання
    const login = heldLogin(() => env.url)
    let pools: Pools
    beforeAll(async () => {
      pools = await login.open()
    }, 60_000)
    afterAll(() => login.close(), 60_000)

    // Роль входу споживача прогону тієї самої форми, що `simetra_signals`,
    // над групою з грантами outbox з генератора (`grantStandConsumer`)
    const consumer = heldResource<string>(async (use) => {
      const group = testRoleName("dlv_grp")
      const name = testRoleName("dlv_signals")
      const password = randomBytes(12).toString("hex")
      const database = decodeURIComponent(new URL(env.url).pathname.slice(1))
      const su = await superuserClient(database)
      let created = 0
      try {
        await su.query(`CREATE ROLE ${quoteIdent(group)} NOLOGIN NOINHERIT`)
        created = 1
        await su.query(
          `CREATE ROLE ${quoteIdent(name)} LOGIN NOINHERIT PASSWORD '${password}'`
        )
        created = 2
        await su.query(
          `GRANT ${quoteIdent(group)} TO ${quoteIdent(name)} WITH INHERIT FALSE, SET TRUE`
        )
        await su.query(
          `GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${quoteIdent(name)}`
        )
        for (const sql of loginSettingSql({
          name,
          memberOf: [],
          settings: { role: group },
        }))
          await su.query(sql)
        expect(await grantStandConsumer(su, group)).toBeGreaterThanOrEqual(5)
        await use(loginUrl(env.url, name, password))
      } finally {
        try {
          await su.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1",
            [name]
          )
          // Гранти й політики групи — у базі цілі: без них роль видаляється
          if (created >= 1) await su.query(`DROP OWNED BY ${quoteIdent(group)}`)
          if (created >= 2) {
            await su.query(
              `REVOKE CONNECT ON DATABASE ${quoteIdent(database)} FROM ${quoteIdent(name)}`
            )
            await su.query(`DROP ROLE IF EXISTS ${quoteIdent(name)}`)
          }
          if (created >= 1)
            await su.query(`DROP ROLE IF EXISTS ${quoteIdent(group)}`)
        } finally {
          await su.end()
        }
      }
    })
    let consumerUrl: string
    beforeAll(async () => {
      consumerUrl = await consumer.open()
    }, 60_000)
    afterAll(() => consumer.close(), 60_000)

    // Ключі порту: старий (зрілий) і молодший за 65 хв — обидва в JWKS з
    // першого читання; годинник порту зсувається в кейсі ротації
    let shift = 0
    const clock = () => new Date(Date.now() + shift)
    let oldKey: SigningKey
    let newKey: SigningKey
    let tokens: SignalTokens
    let audience: string
    let jwks: JwksServer
    let stand: SignalStand
    let runtime: CommandRuntime
    beforeAll(async () => {
      const now = Date.now()
      oldKey = await signingKey("k-old", new Date(now - 120 * MINUTE))
      newKey = await signingKey("k-new", new Date(now - 30 * MINUTE))
      audience = `centrifugo:${env.model.project.name}`
      let served: () => unknown = () => ({ keys: [] })
      jwks = await startJwksServer(() => served())
      tokens = await createCentrifugoTokens({
        keys: [oldKey, newKey],
        audience,
        issuer: jwks.origin,
        now: clock,
      })
      served = () => tokens.jwks()
      stand = await startSignalStand({
        databaseUrl: consumerUrl,
        notifyUrl: consumerUrl,
        config: centrifugoConfig({
          projectName: env.model.project.name,
          origin: jwks.origin,
          issuer: jwks.origin,
          jwksUrl: jwks.jwksUrl,
        }),
      })
      runtime = await createCommandRuntime({
        database: fromPgPool(pools.direct),
        catalog: env.catalog,
      })
    }, 120_000)
    afterAll(async () => {
      closeAllClients()
      try {
        await downAllStands()
      } finally {
        await jwks?.close()
      }
    }, 60_000)

    const objectId = (ref: MetadataRef) =>
      env.catalog.objects.find((o) => o.name === ref.name)!.id
    const channelOf = (ref: MetadataRef, scope: string) =>
      channelTopic({
        kind: "changes",
        scopeKindId: ORG_KIND_ID,
        scope,
        object: objectId(ref),
      })
    const ticketChannel = (org: Org) => channelOf(TICKET, org.id)

    /** З'єднання й підписки особи за грантом рантайму. */
    async function subscriber(
      person: Person,
      channels: string[],
      port: SignalTokens = tokens
    ): Promise<{ client: SignalClient; subs: SignalSubscription[] }> {
      const grant = await runtime.authorizeChannels(person.session, channels)
      expect(grant.channels).toEqual(channels)
      const connection = await port.connectionToken(grant)
      const outcome = await connectSignals(stand, { token: connection.token })
      if (outcome.state !== "connected")
        throw new Error(`connect refused: ${JSON.stringify(outcome)}`)
      const subs: SignalSubscription[] = []
      for (const token of await port.channelTokens(grant)) {
        const sub = await outcome.client.subscribe(token.channel, {
          token: token.token,
        })
        if (sub.state !== "subscribed")
          throw new Error(`subscribe refused: ${JSON.stringify(sub)}`)
        subs.push(sub.subscription)
      }
      return { client: outcome.client, subs }
    }

    const run = (person: Person, operations: Operation | Operation[]) =>
      runtime.run(person.session, operations)
    const createTicket = async (person: Person, org: Org, values = {}) => {
      const id = randomUUID()
      const { rows } = await run(person, {
        action: "create",
        object: TICKET,
        id,
        values: { org: org.id, ...values },
      })
      return { id, version: rows[0]!.version as number }
    }
    /** Сигнал зміни рівно за схемою відправки: `data` — п'ять полів. */
    const signalOf = (
      ref: MetadataRef,
      op: string,
      key: string,
      version: number
    ) => ({
      id: expect.stringMatching(/^[1-9][0-9]*$/) as unknown as string,
      object: objectId(ref),
      op,
      keys: { id: key },
      row_ver: version,
    })
    const about = (key: string) => (data: Record<string, unknown>) =>
      (data.keys as { id?: string } | undefined)?.id === key
    const countOf = (sub: SignalSubscription, key: string) =>
      sub.received.filter((r) => about(key)(r.data)).length
    const quiet = () => new Promise((r) => setTimeout(r, QUIET_MS))

    it("an Ed25519 (OKP) token of the port connects with the grant's user as sub", async () => {
      expect(tokens.jwks().keys.map((k) => [k.kty, k.crv, k.kid])).toEqual([
        ["OKP", "Ed25519", "k-old"],
        ["OKP", "Ed25519", "k-new"],
      ])
      const reader = a.people.reader!
      const grant = await runtime.authorizeChannels(reader.session, [])
      const token = (await tokens.connectionToken(grant)).token
      expect(headerOf(token)).toMatchObject({ alg: "EdDSA", kid: "k-old" })
      expect(claimsOf(token)).toMatchObject({
        sub: reader.user,
        aud: audience,
        iss: jwks.origin,
      })
      const outcome = await connectSignals(stand, { token })
      expect(outcome.state).toBe("connected")
      if (outcome.state === "connected") outcome.client.disconnect()
      expect(jwks.reads()).toBeGreaterThan(0)
    })

    it("save of a creation and of a change, mark_deletion: each reaches a reader with any", async () => {
      const { client, subs } = await subscriber(a.people.reader!, [
        ticketChannel(a),
      ])
      try {
        const [sub] = subs as [SignalSubscription]
        const writer = a.people.writer!
        const created = await createTicket(writer, a)
        expect((await sub.next(about(created.id))).data).toEqual(
          signalOf(TICKET, "create", created.id, created.version)
        )
        const updated = await run(writer, {
          action: "update",
          object: TICKET,
          id: created.id,
          expectedVersion: created.version,
          values: { description: "changed" },
        })
        const updatedVersion = updated.rows[0]!.version as number
        expect(
          (
            await sub.next(
              (d) => about(created.id)(d) && d.op === "update",
              undefined
            )
          ).data
        ).toEqual(signalOf(TICKET, "update", created.id, updatedVersion))
        const marked = await run(writer, {
          action: "markDeletion",
          object: TICKET,
          id: created.id,
          expectedVersion: updatedVersion,
          mark: true,
        })
        expect(
          (
            await sub.next(
              (d) => about(created.id)(d) && d.op === "markDeletion"
            )
          ).data
        ).toEqual(
          signalOf(
            TICKET,
            "markDeletion",
            created.id,
            marked.rows[0]!.version as number
          )
        )
        expect(countOf(sub, created.id)).toBe(3)
      } finally {
        client.disconnect()
      }
    })

    it("delete of an assignment reaches its reader with the version before", async () => {
      const rights = a.people.rights!
      const { client, subs } = await subscriber(rights, [
        channelOf(ASSIGNMENTS, a.id),
      ])
      try {
        const [sub] = subs as [SignalSubscription]
        const id = randomUUID()
        const created = await run(
          rights,
          assign(
            a.id,
            a.people.member!.member,
            { archetype: TASK_VIEWER_ID },
            id
          )
        )
        await sub.next(about(id))
        await run(rights, unassign(id, created.rows[0]!.version as number))
        expect(
          (await sub.next((d) => about(id)(d) && d.op === "delete")).data
        ).toEqual(
          signalOf(
            ASSIGNMENTS,
            "delete",
            id,
            created.rows[0]!.version as number
          )
        )
      } finally {
        client.disconnect()
      }
    })

    it("a change of the scope root reaches the root's own channel", async () => {
      const admin = a.people.admin!
      const { client, subs } = await subscriber(admin, [
        channelOf(ORGANIZATION, a.id),
      ])
      try {
        const [sub] = subs as [SignalSubscription]
        const { rows } = await env.owner.query<{ version: number }>(
          "SELECT version::int AS version FROM public.organization WHERE id = $1",
          [a.id]
        )
        const changed = await run(admin, {
          action: "update",
          object: ORGANIZATION,
          id: a.id,
          expectedVersion: rows[0]!.version,
          values: { description: "renamed" },
        })
        expect((await sub.next(about(a.id))).data).toEqual(
          signalOf(
            ORGANIZATION,
            "update",
            a.id,
            changed.rows[0]!.version as number
          )
        )
      } finally {
        client.disconnect()
      }
    })

    it("a writer with only a container role: the signal reaches a reader with any, the writer gets no channel token", async () => {
      const writer = a.people.container!
      const grant = await runtime.authorizeChannels(writer.session, [
        ticketChannel(a),
      ])
      expect(grant.channels).toEqual([])
      const { client, subs } = await subscriber(a.people.reader!, [
        ticketChannel(a),
      ])
      try {
        const [sub] = subs as [SignalSubscription]
        const created = await createTicket(writer, a, { project })
        expect((await sub.next(about(created.id))).data).toEqual(
          signalOf(TICKET, "create", created.id, created.version)
        )
      } finally {
        client.disconnect()
      }
    })

    it("two clients of two scopes: each signal exactly once in its own scope and none in the other", async () => {
      const inA = await subscriber(a.people.reader!, [ticketChannel(a)])
      const inB = await subscriber(b.people.reader!, [ticketChannel(b)])
      try {
        const [subA] = inA.subs as [SignalSubscription]
        const [subB] = inB.subs as [SignalSubscription]
        const created: string[] = []
        for (let i = 0; i < 5; i++)
          created.push((await createTicket(a.people.writer!, a)).id)
        // Контрольні сигнали в B, потім в A: outbox публікується за `id`, тож
        // після них жоден ранній сигнал уже не прийде
        const sentinelB = (await createTicket(b.people.writer!, b)).id
        await subB.next(about(sentinelB))
        const sentinelA = (await createTicket(a.people.writer!, a)).id
        await subA.next(about(sentinelA))
        await quiet()
        for (const id of [...created, sentinelA])
          expect(countOf(subA, id), id).toBe(1)
        expect(subA.received).toHaveLength(created.length + 1)
        expect(
          subB.received.map((r) => (r.data.keys as { id: string }).id)
        ).toEqual([sentinelB])
      } finally {
        inA.client.disconnect()
        inB.client.disconnect()
      }
    })

    it("a member without a read right connects but gets no channel token", async () => {
      const member = a.people.member!
      const grant = await runtime.authorizeChannels(member.session, [
        ticketChannel(a),
      ])
      expect(grant.channels).toEqual([])
      expect(await tokens.channelTokens(grant)).toEqual([])
      const outcome = await connectSignals(stand, {
        token: (await tokens.connectionToken(grant)).token,
      })
      if (outcome.state !== "connected")
        throw new Error(`connect refused: ${JSON.stringify(outcome)}`)
      outcome.client.disconnect()
    })

    it("a channel token of another channel is refused", async () => {
      const reader = a.people.reader!
      const grant = await runtime.authorizeChannels(reader.session, [
        ticketChannel(a),
      ])
      const [own] = await tokens.channelTokens(grant)
      const outcome = await connectSignals(stand, {
        token: (await tokens.connectionToken(grant)).token,
      })
      if (outcome.state !== "connected")
        throw new Error(`connect refused: ${JSON.stringify(outcome)}`)
      try {
        const foreign = await outcome.client.subscribe(ticketChannel(b), {
          token: own!.token,
        })
        // Centrifugo рве з'єднання з токеном, якого не приймає: 3500
        expect(foreign).toMatchObject({ state: "refused", code: 3500 })
      } finally {
        outcome.client.disconnect()
      }
      // Контроль: той самий токен на свій канал — нове з'єднання підписано
      const control = await connectSignals(stand, {
        token: (await tokens.connectionToken(grant)).token,
      })
      if (control.state !== "connected")
        throw new Error(`connect refused: ${JSON.stringify(control)}`)
      try {
        expect(
          await control.client.subscribe(own!.channel, { token: own!.token })
        ).toMatchObject({ state: "subscribed" })
      } finally {
        control.client.disconnect()
      }
    })

    it("the client cannot publish into the simetra namespace", async () => {
      const writerSide = await subscriber(a.people.writer!, [ticketChannel(a)])
      const readerSide = await subscriber(a.people.reader!, [ticketChannel(a)])
      try {
        const [pub] = writerSide.subs as [SignalSubscription]
        const [sub] = readerSide.subs as [SignalSubscription]
        const fake = randomUUID()
        await expect(
          pub.publish({
            object: objectId(TICKET),
            op: "update",
            keys: { id: fake },
          })
        ).rejects.toMatchObject({ code: 103 })
        const sentinel = (await createTicket(a.people.writer!, a)).id
        await sub.next(about(sentinel))
        await quiet()
        expect(countOf(sub, fake)).toBe(0)
      } finally {
        writerSide.client.disconnect()
        readerSide.client.disconnect()
      }
    })

    describe("connection token refusals", () => {
      // Коди Centrifugo v6: 3500 — токен не прийнято; прострочений токен —
      // спершу відмова 109 на `connect` (SDK по неї кличе `getToken`, а
      // відмову поновлення сервер закриває 3501); невідомий `kid` (немає в
      // JWKS і після перечитування) — 3501
      const variants: [
        string,
        { code: number; error?: number },
        () => Promise<string>,
      ][] = [
        [
          "an expired token",
          { code: 3501, error: 109 },
          async () =>
            (
              await (
                await createCentrifugoTokens({
                  keys: [oldKey],
                  audience,
                  issuer: jwks.origin,
                  now: () => new Date(Date.now() - 16 * MINUTE),
                })
              ).connectionToken(await readerGrant())
            ).token,
        ],
        [
          "a foreign aud",
          { code: 3500 },
          async () =>
            (
              await (
                await createCentrifugoTokens({
                  keys: [oldKey],
                  audience: "centrifugo:another-app",
                  issuer: jwks.origin,
                })
              ).connectionToken(await readerGrant())
            ).token,
        ],
        [
          "a foreign iss",
          { code: 3500 },
          async () =>
            (
              await (
                await createCentrifugoTokens({
                  keys: [oldKey],
                  audience,
                  issuer: "http://127.0.0.2:1",
                })
              ).connectionToken(await readerGrant())
            ).token,
        ],
        [
          "an unknown kid",
          { code: 3501 },
          async () =>
            (
              await (
                await createCentrifugoTokens({
                  keys: [
                    await signingKey(
                      "k-unknown",
                      new Date(Date.now() - 120 * MINUTE)
                    ),
                  ],
                  audience,
                  issuer: jwks.origin,
                })
              ).connectionToken(await readerGrant())
            ).token,
        ],
        [
          "alg none",
          { code: 3500 },
          async () =>
            forged(
              (await tokens.connectionToken(await readerGrant())).token,
              "none",
              oldKey.privateJwk.x!
            ),
        ],
        [
          "HS256 keyed with the public key bytes",
          { code: 3500 },
          async () =>
            forged(
              (await tokens.connectionToken(await readerGrant())).token,
              "HS256",
              oldKey.privateJwk.x!
            ),
        ],
      ]
      const readerGrant = () =>
        runtime.authorizeChannels(a.people.reader!.session, [])

      it.each(variants)("%s is refused", async (_, expected, token) => {
        const outcome = await connectSignals(stand, { token: await token() })
        if (outcome.state === "connected") outcome.client.disconnect()
        expect(outcome).toMatchObject({ state: "refused", ...expected })
      })
    })

    it("key rotation without a gap: the port clock moves signing to the matured key, both connections keep receiving", async () => {
      const reader = a.people.reader!
      const first = await subscriber(reader, [ticketChannel(a)])
      let disconnected = 0
      first.client.centrifuge.on("disconnected", () => disconnected++)
      try {
        const grant = await runtime.authorizeChannels(reader.session, [
          ticketChannel(a),
        ])
        expect(headerOf((await tokens.connectionToken(grant)).token).kid).toBe(
          "k-old"
        )
        // Через 40 хв ключ `k-new` (доданий 30 хв тому) — старший за 65 хв
        shift = 40 * MINUTE
        expect(headerOf((await tokens.connectionToken(grant)).token).kid).toBe(
          "k-new"
        )
        // Старий ключ відставлено: підписує лише новий, а старий лишається
        // в JWKS ще 20 хв — з'єднання на ньому не рветься
        const retired = await createCentrifugoTokens({
          keys: [
            { ...oldKey, retiredAt: new Date(Date.now() + 35 * MINUTE) },
            newKey,
          ],
          audience,
          issuer: jwks.origin,
          now: clock,
        })
        expect(retired.jwks().keys.map((k) => k.kid)).toEqual([
          "k-old",
          "k-new",
        ])
        const second = await subscriber(reader, [ticketChannel(a)], retired)
        try {
          const created = await createTicket(a.people.writer!, a)
          await first.subs[0]!.next(about(created.id))
          await second.subs[0]!.next(about(created.id))
          expect(disconnected).toBe(0)
        } finally {
          second.client.disconnect()
        }
      } finally {
        shift = 0
        first.client.disconnect()
      }
    })

    it("a command rolled back delivers nothing", async () => {
      const { client, subs } = await subscriber(a.people.reader!, [
        ticketChannel(a),
      ])
      try {
        const [sub] = subs as [SignalSubscription]
        const writer = a.people.writer!
        const lost = randomUUID()
        const conflict = await createTicket(writer, a)
        await sub.next(about(conflict.id))
        await expect(
          run(writer, [
            {
              action: "create",
              object: TICKET,
              id: lost,
              values: { org: a.id },
            },
            {
              action: "update",
              object: TICKET,
              id: conflict.id,
              expectedVersion: conflict.version + 1000,
              values: { description: "stale" },
            },
          ])
        ).rejects.toBeInstanceOf(CommandFailure)
        // Відмова хука після вдалого запису: транзакцію відкочує сам рантайм
        // (`ROLLBACK`), а не помилка Postgres, яка обірвала б її й без нього
        const refused = randomUUID()
        const hooked = await createCommandRuntime({
          database: fromPgPool(pools.direct),
          catalog: env.catalog,
          objectModules: {
            "Catalog.Ticket": defineObjectModule({
              onWrite: async ({ ctx }) => {
                if (ctx.action === "create")
                  throw new CommandFailure({ code: "command.internal" })
              },
            }) as ObjectModule<object>,
          },
        })
        await expect(
          hooked.run(writer.session, {
            action: "create",
            object: TICKET,
            id: refused,
            values: { org: a.id },
          })
        ).rejects.toBeInstanceOf(CommandFailure)
        const sentinel = (await createTicket(writer, a)).id
        await sub.next(about(sentinel))
        await quiet()
        expect(countOf(sub, lost)).toBe(0)
        expect(countOf(sub, refused)).toBe(0)
      } finally {
        client.disconnect()
      }
    })

    it("a short gap recovers the missed signals with recovered: true", async () => {
      const { client, subs } = await subscriber(a.people.reader!, [
        ticketChannel(a),
      ])
      try {
        const [sub] = subs as [SignalSubscription]
        client.disconnect()
        const missed: string[] = []
        for (let i = 0; i < 3; i++)
          missed.push((await createTicket(a.people.writer!, a)).id)
        await client.connect()
        const resumed = await sub.subscribedAt(2)
        expect(resumed).toMatchObject({ wasRecovering: true, recovered: true })
        for (const id of missed) await sub.next(about(id))
        for (const id of missed) expect(countOf(sub, id), id).toBe(1)
      } finally {
        client.disconnect()
      }
    })

    // Р18: відкликане право не закриває підписки миттєво — межа: `exp`
    // токена каналу + `expired_sub_close_delay`. Поновлення відмовлено
    // (грант після відкликання порожній), і закриває підписку сервер.
    it("a revoked reader: the refresh is refused and the subscription closes no later than exp + 25 s + 5 s", async () => {
      const late = a.people.late!
      const assignment = a.assignments[`late:${TICKET_READER_ID}`]!
      const short = await createCentrifugoTokens({
        keys: [oldKey, newKey],
        audience,
        issuer: jwks.origin,
        now: () => new Date(Date.now() - CHANNEL_TTL_MS + REVOKE_LEAD_MS),
      })
      const grant = await runtime.authorizeChannels(late.session, [
        ticketChannel(a),
      ])
      const [token] = await short.channelTokens(grant)
      const exp = (claimsOf(token!.token).exp as number) * 1000
      expect(exp - Date.now()).toBeLessThanOrEqual(REVOKE_LEAD_MS)
      expect(exp - Date.now()).toBeGreaterThan(REVOKE_LEAD_MS / 2)
      const outcome = await connectSignals(stand, {
        token: (await tokens.connectionToken(grant)).token,
      })
      if (outcome.state !== "connected")
        throw new Error(`connect refused: ${JSON.stringify(outcome)}`)
      let refreshes = 0
      try {
        const subscribed = await outcome.client.subscribe(token!.channel, {
          token: token!.token,
          // Host: новий грант після відкликання — без каналу, токена немає
          getToken: async () => {
            refreshes++
            const again = await runtime.authorizeChannels(late.session, [
              ticketChannel(a),
            ])
            if (again.channels.length === 0)
              throw new Error("the host refused the channel token")
            return (await tokens.channelTokens(again))[0]!.token
          },
        })
        if (subscribed.state !== "subscribed")
          throw new Error(`subscribe refused: ${JSON.stringify(subscribed)}`)
        const sub = subscribed.subscription
        await seedUnderMaintenance(env.owner, async () => {
          await env.owner.query(
            "DELETE FROM public.org_role_assignments WHERE id = $1",
            [assignment]
          )
        })
        const bound =
          exp +
          EXPIRED_SUB_CLOSE_DELAY_MS +
          PRESENCE_UPDATE_INTERVAL_MS +
          REVOKE_SLACK_MS
        await new Promise<void>((resolve, reject) => {
          const timer = setInterval(() => {
            if (sub.closes.length > 0) {
              clearInterval(timer)
              resolve()
            } else if (Date.now() > bound) {
              clearInterval(timer)
              reject(
                new Error(
                  `the subscription is still open ${Date.now() - exp} ms after exp`
                )
              )
            }
          }, 100)
        })
        expect(sub.closes[0]).toMatchObject({
          code: 2501,
          reason: "subscription expired",
        })
        expect(sub.closes[0]!.at).toBeLessThanOrEqual(bound)
        expect(refreshes).toBeGreaterThan(0)
        // Після закриття сигнал каналу до відкликаного не доходить
        const reader = await subscriber(a.people.reader!, [ticketChannel(a)])
        try {
          const after = (await createTicket(a.people.writer!, a)).id
          await reader.subs[0]!.next(about(after))
          await quiet()
          expect(countOf(sub, after)).toBe(0)
          expect(sub.state()).not.toBe("subscribed")
        } finally {
          reader.client.disconnect()
        }
      } finally {
        outcome.client.disconnect()
      }
    }, 90_000)

    it("with LISTEN the p95 commit-to-client-event is at most 50 ms over 200 commands", async () => {
      const { client, subs } = await subscriber(a.people.reader!, [
        ticketChannel(a),
      ])
      try {
        const [sub] = subs as [SignalSubscription]
        const latencies: number[] = []
        for (let i = 0; i < WARMUP + MEASURED; i++) {
          const created = await createTicket(a.people.writer!, a)
          const committed = performance.now()
          const event = await sub.next(about(created.id))
          if (i >= WARMUP) latencies.push(event.at - committed)
        }
        latencies.sort((x, y) => x - y)
        expect(percentile(latencies, 0.95)).toBeLessThanOrEqual(50)
      } finally {
        client.disconnect()
      }
    }, 180_000)

    it("a restart of Centrifugo (a new epoch) resubscribes with recovered: false", async () => {
      const { client, subs } = await subscriber(a.people.reader!, [
        ticketChannel(a),
      ])
      try {
        const [sub] = subs as [SignalSubscription]
        const before = (await createTicket(a.people.writer!, a)).id
        await sub.next(about(before))
        await stand.restart()
        const resumed = await sub.subscribedAt(2, 30_000)
        expect(resumed).toMatchObject({
          wasRecovering: true,
          recovered: false,
        })
        const after = (await createTicket(a.people.writer!, a)).id
        await sub.next(about(after))
      } finally {
        client.disconnect()
      }
    }, 90_000)

    it("a failing case leaves no container of its stand", async () => {
      let name = ""
      await expect(
        (async () => {
          const s = await startSignalStand({
            databaseUrl: consumerUrl,
            config: centrifugoConfig({
              projectName: env.model.project.name,
              origin: jwks.origin,
              issuer: jwks.origin,
              jwksUrl: jwks.jwksUrl,
            }),
          })
          name = s.name
          try {
            throw new Error("boom")
          } finally {
            await s.down()
          }
        })()
      ).rejects.toThrow("boom")
      const left = (await runContainers(testProvider(), nodeExec)).filter(
        (c) => c.tag === runTag()
      )
      expect(name).not.toBe("")
      expect(left.map((c) => c.name)).not.toContain(name)
      expect(left.map((c) => c.name)).toEqual([stand.name])
    }, 60_000)
  })
}
