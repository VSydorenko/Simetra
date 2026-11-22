import { randomBytes, randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { buildClientCatalog } from "simetra/compiler"
import {
  createDataRuntime,
  type DataLogEntry,
  type DataRuntime,
} from "simetra/data"
import {
  SignalAuthRefused,
  createCentrifugoTransport,
} from "simetra/data/centrifugo"
import {
  channelTopic,
  quoteIdent,
  type DataRequest,
  type SignalError,
  type SignalTransport,
} from "simetra/model"
import {
  createCommandRuntime,
  createDataHandler,
  fromPgPool,
  type CommandRuntime,
} from "simetra/server"
import {
  SignalTokenError,
  createCentrifugoTokens,
  type SignalTokens,
  type SigningKey,
} from "simetra/server/signals"
import {
  ORG_KIND_ID,
  TICKET_READER_ID,
  TICKET_WRITER_ID,
  loginUrl,
  runTag,
  superuserClient,
  testProvider,
  testRoleName,
} from "../../../simetra/test/support"
import { nodeExec, runContainers } from "../../../simetra/test/db/external"
import {
  downAllStands,
  grantStandConsumer,
  startJwksServer,
  startSignalStand,
  type JwksServer,
  type SignalStand,
} from "../../../simetra/test/db/signal-stand"
import { runtimeHandleOf } from "../../../simetra/src/data/runtime/handle"
import { REJOIN_JITTER_MS } from "../../../simetra/src/data/store/receiver"
import type { ViewSnapshot } from "../../../simetra/src/data/store/types"
import { loginSettingSql } from "../../../simetra/src/schema/apply/platform-roles"
import { centrifugoConfig } from "../tools/signals-config"
import { heldResource, seedUnderMaintenance } from "./support/db"
import {
  TICKET,
  type Env,
  type Org,
  type Person,
  type Pools,
  heldEnv,
  heldLogin,
  seedOrg,
} from "./rights-admin-commands.support"

/**
 * Стенд транспорту й приймача (рядок «стенд сигналу» §12 П4-B, частина B5;
 * Р7 плану B5b-4): рантайм даних справжнього клієнта — `createDataRuntime`
 * над обробником даних розгорнутої цілі — з транспортом
 * `createCentrifugoTransport` до Centrifugo прогону. Токени — як у host-а:
 * `authorizeChannels` на кожен виклик, відмова — `SignalAuthRefused`. Що
 * Centrifugo віддає на розрив, рестарт, втрату стану потоку й відмову
 * токена, і як приймач це перетворює на перечитування чи `purge`, — вирішує
 * справжній сервер, фейк SDK цього не доводить.
 */

const MINUTE = 60_000
// TTL токена каналу за спекою профілю §6.2; короткий токен підписано
// годинником порту так, щоб до `exp` лишалося кілька секунд
const CHANNEL_TTL_MS = 5 * MINUTE
const REFRESH_LEAD_MS = 15_000
// Скільки чекається подія, якої не має бути
const QUIET_MS = 1_000
// Скільки чекається, що відмовлений канал не перепросить токена
const NO_RETRY_MS = 3_000
// Хвиля приєднання — з джитером до 2 с (`REJOIN_JITTER_MS` приймача) плюс
// читання
const CONVERGE_MS = 10_000
// Код розриву HTTP API з повторним з'єднанням (3000–3499): клієнт не скидає
// стану підписок, тож відновлення з історії можливе (3014 скинув би його)
const RECONNECT_CODE = 3100
// Втрата стану потоку (Memory engine): метадані потоку живуть
// `history_meta_ttl`, після них наступна публікація відкриває нову епоху, і
// Centrifugo знімає живу підписку з 2500 «insufficient state»
const SHORT_HISTORY_TTL = "2s"
const SHORT_META_TTL = "4s"
const META_IDLE_MS = 8_000
// Перечитування не за сигналом (такт інтервалу) не мішає лічильникам запитів
const LIMITS = { revalidateIntervalMs: 30 * MINUTE }
// Хвиля першої підписки перечитує й знімок прав: відкликання до неї дало б
// `purge` заміною знімка, а не відмовою токена, яку доводять кейси відкликання
const WAVE_MS = REJOIN_JITTER_MS + QUIET_MS

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Чекає умови не довше `ms`, інакше — помилка з `message`. */
async function until(condition: () => boolean, ms: number, message: string) {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message)
    await sleep(50)
  }
}

/** Ключ Ed25519 у формі JWK порту. */
async function signingKey(kid: string, addedAt: Date): Promise<SigningKey> {
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
  }
}

/** Подія порту, як її бачить приймач, з міткою часу отримання. */
type PortEvent =
  | { type: "signal"; channel: string; data: Record<string, unknown> }
  | { type: "error"; error: SignalError }
  | { type: "subscribed"; channel: string; recovered: boolean }

/** Транспорт, що записує кожну подію, яку дістає приймач. */
function recorded(inner: SignalTransport, log: PortEvent[]): SignalTransport {
  return {
    subscribe: (channels, onSignal, onError) =>
      inner.subscribe(
        channels,
        (channel, payload) => {
          log.push({
            type: "signal",
            channel,
            data: payload as Record<string, unknown>,
          })
          onSignal(channel, payload)
        },
        (error) => {
          log.push({ type: "error", error })
          onError(error)
        }
      ),
    onSubscribed: (handler) =>
      inner.onSubscribed((event) => {
        log.push({ type: "subscribed", ...event })
        handler(event)
      }),
    refreshTokens: (channels) => inner.refreshTokens(channels),
    close: () => inner.close(),
  }
}

/** Клієнт одного користувача: рантайм даних, його порт і токени. */
interface Client {
  readonly runtime: DataRuntime
  readonly port: PortEvent[]
  /** Канали кожного виклику `getChannelToken`, по порядку. */
  readonly channelCalls: string[]
  readonly requests: DataRequest[]
  /** Журнал рантайму: метрики приймача йдуть сюди, а не в консоль прогону. */
  readonly journal: DataLogEntry[]
  transport(): SignalTransport
}

/** Утримуваний вигляд картки і кожен його знімок, від першого. */
interface Card {
  readonly snapshots: ViewSnapshot[]
  current(): ViewSnapshot
  release(): void
}

export function describeSignalReceiver(): void {
  describe("the signal receiver over the Centrifugo transport on the signal stand", () => {
    const target = heldEnv()
    let env: Env
    let a: Org
    let b: Org

    beforeAll(async () => {
      env = await target.open()
      a = await seedOrg(env.owner, {
        writer: [TICKET_WRITER_ID],
        reader: [TICKET_READER_ID],
        refreshed: [TICKET_READER_ID],
        expiring: [TICKET_READER_ID],
        member: [],
      })
      b = await seedOrg(env.owner, {
        writer: [TICKET_WRITER_ID],
        reader: [TICKET_READER_ID],
      })
    }, 180_000)
    afterAll(() => target.close(), 60_000)

    const login = heldLogin(() => env.url)
    let pools: Pools
    beforeAll(async () => {
      pools = await login.open()
    }, 60_000)
    afterAll(() => login.close(), 60_000)

    // Роль входу споживача прогону тієї самої форми, що `simetra_signals`,
    // над групою з грантами outbox з генератора (`grantStandConsumer`)
    const consumer = heldResource<string>(async (use) => {
      const group = testRoleName("rcv_grp")
      const name = testRoleName("rcv_signals")
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

    const API_KEY = "signal-receiver-api-key"
    let key: SigningKey
    let tokens: SignalTokens
    let jwks: JwksServer
    let stand: SignalStand
    let runtime: CommandRuntime
    let handler: ReturnType<typeof createDataHandler>
    // Конфіг генератора під JWKS прогону; `http_api` — лише щоб тест міг
    // розірвати з'єднання користувача (`disconnect`), решта — як у розгортанні
    const config = (namespace: Record<string, unknown> = {}) => {
      const base = centrifugoConfig({
        projectName: env.model.project.name,
        origin: jwks.origin,
        issuer: jwks.origin,
        jwksUrl: jwks.jwksUrl,
      })
      return {
        ...base,
        channel: {
          ...base.channel,
          namespaces: base.channel.namespaces.map((n) =>
            n.name === "simetra" ? { ...n, ...namespace } : n
          ),
        },
        http_api: { key: API_KEY },
      }
    }
    beforeAll(async () => {
      key = await signingKey("k-rcv", new Date(Date.now() - 120 * MINUTE))
      jwks = await startJwksServer(() => tokens.jwks())
      tokens = await createCentrifugoTokens({
        keys: [key],
        audience: `centrifugo:${env.model.project.name}`,
        issuer: jwks.origin,
      })
      stand = await startSignalStand({
        databaseUrl: consumerUrl,
        notifyUrl: consumerUrl,
        config: config(),
        apiKey: API_KEY,
      })
      runtime = await createCommandRuntime({
        database: fromPgPool(pools.direct),
        catalog: env.catalog,
      })
      handler = createDataHandler(runtime)
    }, 120_000)
    afterAll(async () => {
      try {
        await downAllStands()
      } finally {
        await jwks?.close()
      }
    }, 60_000)

    // Рантайми кейсу: кожен закривається й на падінні, разом зі своїм
    // транспортом
    const open = new Set<DataRuntime>()
    afterEach(() => {
      for (const r of open) r.dispose()
      open.clear()
    })

    const objectId = () =>
      env.catalog.objects.find((o) => o.name === TICKET.name)!.id
    const channelOf = (org: Org) =>
      channelTopic({
        kind: "changes",
        scopeKindId: ORG_KIND_ID,
        scope: org.id,
        object: objectId(),
      })

    // Відмова host-а рівно за Р1: `signals.no-user` гранту без користувача й
    // канал поза грантом; решта помилок (мережа, 5xx) — не відмова
    const refusalOf = (error: unknown): never => {
      if (error instanceof SignalTokenError && error.code === "signals.no-user")
        throw new SignalAuthRefused()
      throw error
    }

    /**
     * Рантайм даних особи з транспортом до `url`; `channelPort` — порт
     * токена каналу на n-й виклик (від 0), типово — порт прогону.
     */
    function client(
      person: Person,
      o: {
        url?: string
        channelPort?: (call: number) => SignalTokens
      } = {}
    ): Client {
      const port: PortEvent[] = []
      const channelCalls: string[] = []
      const requests: DataRequest[] = []
      const journal: DataLogEntry[] = []
      let transport: SignalTransport | undefined
      const data = createDataRuntime({
        catalog: buildClientCatalog(env.catalog),
        subject: person.session.sub,
        limits: LIMITS,
        log: (entry) => journal.push(entry),
        transport: (request) => {
          requests.push(request)
          return handler(person.session, request, { inProcess: true })
        },
        signals: () => {
          transport = recorded(
            createCentrifugoTransport({
              url: o.url ?? stand.wsUrl,
              getConnectionToken: async () => {
                try {
                  const grant = await runtime.authorizeChannels(
                    person.session,
                    []
                  )
                  return (await tokens.connectionToken(grant)).token
                } catch (error) {
                  return refusalOf(error)
                }
              },
              getChannelToken: async (channel) => {
                const call = channelCalls.push(channel) - 1
                const issuer = o.channelPort?.(call) ?? tokens
                let found: string | undefined
                try {
                  const grant = await runtime.authorizeChannels(
                    person.session,
                    [channel]
                  )
                  found = (await issuer.channelTokens(grant)).find(
                    (t) => t.channel === channel
                  )?.token
                } catch (error) {
                  return refusalOf(error)
                }
                if (found === undefined) throw new SignalAuthRefused()
                return found
              },
            }),
            port
          )
          return transport
        },
      })
      open.add(data)
      return {
        runtime: data,
        port,
        channelCalls,
        requests,
        journal,
        transport: () => transport!,
      }
    }

    function card(c: Client, key: string): Card {
      const view = runtimeHandleOf(c.runtime).core.view({
        kind: "card",
        object: `${TICKET.kind}.${TICKET.name}`,
        key,
      })
      const snapshots: ViewSnapshot[] = []
      const release = view.subscribe(() => snapshots.push(view.getSnapshot()))
      snapshots.push(view.getSnapshot())
      return { snapshots, current: () => view.getSnapshot(), release }
    }

    const rowOf = (snapshot: ViewSnapshot, key: string) => {
      const row = snapshot.rows.find((r) => r.key === key)
      return row === undefined || row.state === "removed" ? undefined : row
    }
    const versionIn = (c: Card, key: string) => rowOf(c.current(), key)?.version

    const subscribedOf = (c: Client, channel: string) =>
      c.port.filter(
        (e): e is Extract<PortEvent, { type: "subscribed" }> =>
          e.type === "subscribed" && e.channel === channel
      )
    const errorsOf = (c: Client) =>
      c.port.flatMap((e) => (e.type === "error" ? [e.error] : []))
    const signalsAbout = (c: Client, id: string, from = 0) =>
      c.port
        .slice(from)
        .filter(
          (e) =>
            e.type === "signal" &&
            (e.data.keys as { id?: string } | undefined)?.id === id
        )

    /** Вигляд готовий, а канал пари — підписаний. */
    async function ready(c: Client, view: Card, key: string, channel: string) {
      await until(
        () => versionIn(view, key) !== undefined,
        CONVERGE_MS,
        `the card of ${key} never loaded: ${JSON.stringify(view.current())}`
      )
      await until(
        () => subscribedOf(c, channel).length > 0,
        CONVERGE_MS,
        `${channel} was never subscribed: ${JSON.stringify(c.port)}`
      )
    }

    const createTicket = async (person: Person, org: Org) => {
      const id = randomUUID()
      const { rows } = await runtime.run(person.session, {
        action: "create",
        object: TICKET,
        id,
        values: { org: org.id },
      })
      return { id, version: rows[0]!.version as number }
    }
    const updateTicket = async (
      person: Person,
      ticket: { id: string; version: number },
      description: string
    ) => {
      const { rows } = await runtime.run(person.session, {
        action: "update",
        object: TICKET,
        id: ticket.id,
        expectedVersion: ticket.version,
        values: { description },
      })
      return { id: ticket.id, version: rows[0]!.version as number }
    }
    const revoke = (assignment: string) =>
      seedUnderMaintenance(env.owner, async () => {
        await env.owner.query(
          "DELETE FROM public.org_role_assignments WHERE id = $1",
          [assignment]
        )
      })

    it("a signal reaches the reader of its scope exactly once, the reader of another scope gets no signal and sends no request", async () => {
      const inA = client(a.people.reader!)
      const inB = client(b.people.reader!)
      const ticketA = await createTicket(a.people.writer!, a)
      const ticketB = await createTicket(b.people.writer!, b)
      const cardA = card(inA, ticketA.id)
      const cardB = card(inB, ticketB.id)
      await ready(inA, cardA, ticketA.id, channelOf(a))
      await ready(inB, cardB, ticketB.id, channelOf(b))
      // Хвиля першої підписки ще може читати: лічильники — після неї
      await sleep(WAVE_MS)
      const requestsB = inB.requests.length
      const portB = inB.port.length
      const portA = inA.port.length

      const changed = await updateTicket(a.people.writer!, ticketA, "changed")
      await until(
        () => versionIn(cardA, ticketA.id) === changed.version,
        CONVERGE_MS,
        "the reader of A never saw the change"
      )
      expect(rowOf(cardA.current(), ticketA.id)?.values.description).toBe(
        "changed"
      )
      await sleep(QUIET_MS)
      const delivered = signalsAbout(inA, ticketA.id, portA)
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toMatchObject({
        channel: channelOf(a),
        data: { op: "update", row_ver: changed.version },
      })
      expect(inB.port.slice(portB)).toEqual([])
      expect(inB.requests).toHaveLength(requestsB)
      expect(
        inB.port.some((e) => e.type === "signal" && e.channel === channelOf(a))
      ).toBe(false)
    }, 60_000)

    it("a member without a read right: the receiver asks no channel token, and the grant gives none", async () => {
      const member = a.people.member!
      const ticket = await createTicket(a.people.writer!, a)
      const c = client(member)
      card(c, ticket.id)
      await until(
        () => runtimeHandleOf(c.runtime).core.rights() !== undefined,
        CONVERGE_MS,
        "the rights snapshot never arrived"
      )
      await sleep(QUIET_MS)
      expect(c.channelCalls).toEqual([])
      expect(c.port.filter((e) => e.type === "subscribed")).toEqual([])
      const grant = await runtime.authorizeChannels(member.session, [
        channelOf(a),
      ])
      expect(grant.channels).toEqual([])
      expect(await tokens.channelTokens(grant)).toEqual([])
    }, 60_000)

    it("a short disconnect with history: onSubscribed again with recovered: true, the missed signal reaches the receiver after it", async () => {
      const reader = a.people.reader!
      const ticket = await createTicket(a.people.writer!, a)
      const c = client(reader)
      const view = card(c, ticket.id)
      await ready(c, view, ticket.id, channelOf(a))
      const response = await fetch(`${stand.httpUrl}/api/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({
          user: reader.user,
          disconnect: { code: RECONNECT_CODE, reason: "test gap" },
        }),
      })
      expect(await response.json()).toEqual({ result: {} })
      // Клієнт з'єднується знову не раніше `minReconnectDelay` (500 мс): зміна
      // публікується в цьому вікні
      const changed = await updateTicket(a.people.writer!, ticket, "in the gap")
      await until(
        () => subscribedOf(c, channelOf(a)).length >= 2,
        CONVERGE_MS,
        `no resubscribe after the gap: ${JSON.stringify(c.port)}`
      )
      const resumed = c.port.indexOf(subscribedOf(c, channelOf(a))[1]!)
      expect(c.port[resumed]).toEqual({
        type: "subscribed",
        channel: channelOf(a),
        recovered: true,
      })
      // Розрив дійшов до приймача раніше за повторну підписку — без каналу
      expect(c.port.slice(0, resumed)).toContainEqual({
        type: "error",
        error: { kind: "transport" },
      })
      await until(
        () => signalsAbout(c, ticket.id, resumed).length > 0,
        CONVERGE_MS,
        "the missed signal never reached the receiver"
      )
      expect(signalsAbout(c, ticket.id)).toHaveLength(1)
      await until(
        () => versionIn(view, ticket.id) === changed.version,
        CONVERGE_MS,
        "the card never showed the change of the gap"
      )
    }, 60_000)

    it("a channel token refused after the right is revoked (explicit refreshTokens): auth for the channel, the pair purged, no new token request", async () => {
      const person = a.people.refreshed!
      const ticket = await createTicket(a.people.writer!, a)
      const c = client(person)
      const view = card(c, ticket.id)
      await ready(c, view, ticket.id, channelOf(a))
      await sleep(WAVE_MS)
      await revoke(a.assignments[`refreshed:${TICKET_READER_ID}`]!)
      const before = c.channelCalls.length
      await c.transport().refreshTokens()
      await until(
        () =>
          errorsOf(c).some(
            (e) => e.kind === "auth" && e.channel === channelOf(a)
          ),
        CONVERGE_MS,
        `no auth refusal of the channel: ${JSON.stringify(c.port)}`
      )
      expect(c.channelCalls.slice(before)).toEqual([channelOf(a)])
      await until(
        () => rowOf(view.current(), ticket.id) === undefined,
        CONVERGE_MS,
        `the pair was not purged: ${JSON.stringify(view.current())}`
      )
      expect(view.current()).toMatchObject({
        status: "purged",
        reason: "access-changed",
      })
      await sleep(NO_RETRY_MS)
      expect(c.channelCalls.slice(before)).toEqual([channelOf(a)])
    }, 60_000)

    it("the SDK's own channel token refresh by ttl after the right is revoked: auth for the channel and the pair purged", async () => {
      const person = a.people.expiring!
      const ticket = await createTicket(a.people.writer!, a)
      // Перший токен каналу спливає за кілька секунд: SDK сам поновлює його
      // за `ttl` відповіді підписки, без `refreshTokens`
      const short = await createCentrifugoTokens({
        keys: [key],
        audience: `centrifugo:${env.model.project.name}`,
        issuer: jwks.origin,
        now: () => new Date(Date.now() - CHANNEL_TTL_MS + REFRESH_LEAD_MS),
      })
      const c = client(person, {
        channelPort: (call) => (call === 0 ? short : tokens),
      })
      const view = card(c, ticket.id)
      await ready(c, view, ticket.id, channelOf(a))
      await sleep(WAVE_MS)
      await revoke(a.assignments[`expiring:${TICKET_READER_ID}`]!)
      await until(
        () =>
          errorsOf(c).some(
            (e) => e.kind === "auth" && e.channel === channelOf(a)
          ),
        REFRESH_LEAD_MS + CONVERGE_MS,
        `the SDK refresh was never refused: ${JSON.stringify(c.port)}`
      )
      // Відмову дало саме поновлення SDK: другий виклик токена того самого каналу
      expect(c.channelCalls).toEqual([channelOf(a), channelOf(a)])
      await until(
        () => rowOf(view.current(), ticket.id) === undefined,
        CONVERGE_MS,
        `the pair was not purged: ${JSON.stringify(view.current())}`
      )
      expect(view.current()).toMatchObject({
        status: "purged",
        reason: "access-changed",
      })
    }, 60_000)

    it("a restart of Centrifugo: onSubscribed again with recovered: false, and the re-read shows the change made while it was down", async () => {
      const ticket = await createTicket(a.people.writer!, a)
      const c = client(a.people.reader!)
      const view = card(c, ticket.id)
      await ready(c, view, ticket.id, channelOf(a))
      let changed: { id: string; version: number } | undefined
      await stand.restart(async () => {
        changed = await updateTicket(a.people.writer!, ticket, "while down")
      })
      await until(
        () => subscribedOf(c, channelOf(a)).length >= 2,
        30_000,
        `no resubscribe after the restart: ${JSON.stringify(c.port)}`
      )
      expect(subscribedOf(c, channelOf(a))[1]).toEqual({
        type: "subscribed",
        channel: channelOf(a),
        recovered: false,
      })
      expect(errorsOf(c)).toContainEqual({ kind: "transport" })
      // Значення може принести й читання, що стартувало до приєднання: позначку
      // розриву знімає лише перше читання після нього (§8.4)
      await until(
        () =>
          versionIn(view, ticket.id) === changed!.version &&
          rowOf(view.current(), ticket.id)?.stale === undefined,
        CONVERGE_MS,
        `the re-read never showed the change: ${JSON.stringify(view.current())}`
      )
      expect(rowOf(view.current(), ticket.id)?.values.description).toBe(
        "while down"
      )
    }, 90_000)

    // Втрата на живому з'єднанні (передумова правила епох §8.4): у Memory
    // engine одного вузла публікація потоку завжди доходить до хаба, тож
    // відтворюється лише втрата стану потоку — метадані спливли, наступна
    // публікація відкрила нову епоху й не дійшла. Окремий контейнер прогону
    // з конфігом генератора, де скорочено лише TTL історії простору
    // `simetra`; основний стенд на цей час зупинено — два споживачі одного
    // outbox ділили б його рядки
    it("a lost stream state on a live connection: 2500 gives transport for the channel and onSubscribed with recovered: false; the row is marked until the first read after the join", async () => {
      const ticket = await createTicket(a.people.writer!, a)
      await stand.stop()
      let gapStand: SignalStand | undefined
      try {
        gapStand = await startSignalStand({
          databaseUrl: consumerUrl,
          notifyUrl: consumerUrl,
          config: config({
            history_ttl: SHORT_HISTORY_TTL,
            history_meta_ttl: SHORT_META_TTL,
          }),
          apiKey: API_KEY,
        })
        const c = client(a.people.reader!, { url: gapStand.wsUrl })
        const view = card(c, ticket.id)
        await ready(c, view, ticket.id, channelOf(a))
        await sleep(META_IDLE_MS)
        const from = c.port.length
        const changed = await updateTicket(a.people.writer!, ticket, "lost")
        await until(
          () => subscribedOf(c, channelOf(a)).length >= 2,
          CONVERGE_MS,
          `no resubscribe after the lost state: ${JSON.stringify(c.port)}`
        )
        // З'єднання живе: розрив — лише каналу, сигнал зміни не дійшов
        expect(c.port.slice(from)).toEqual([
          {
            type: "error",
            error: { kind: "transport", channel: channelOf(a) },
          },
          { type: "subscribed", channel: channelOf(a), recovered: false },
        ])
        await until(
          () => versionIn(view, ticket.id) === changed.version,
          CONVERGE_MS,
          `the read after the join never came: ${JSON.stringify(view.current())}`
        )
        const marked = view.snapshots.findIndex(
          (s) => rowOf(s, ticket.id)?.stale === true
        )
        expect(marked).toBeGreaterThanOrEqual(0)
        expect(rowOf(view.snapshots[marked]!, ticket.id)?.version).toBe(
          ticket.version
        )
        expect(rowOf(view.current(), ticket.id)).toMatchObject({
          version: changed.version,
          values: { description: "lost" },
        })
        expect(rowOf(view.current(), ticket.id)?.stale).toBeUndefined()
        expect(signalsAbout(c, ticket.id)).toEqual([])
      } finally {
        for (const r of open) r.dispose()
        open.clear()
        try {
          await gapStand?.down()
        } finally {
          await stand.start()
        }
      }
      // Контейнер кейсу прибрано, лишився тільки основний стенд прогону
      const left = (await runContainers(testProvider(), nodeExec)).filter(
        (container) => container.tag === runTag()
      )
      expect(left.map((container) => container.name)).toEqual([stand.name])
    }, 120_000)
  })
}
