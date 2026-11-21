import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  PROVIDER_IDENTITY_SOURCES,
  ZERO_UUID,
  channelTopic,
  quoteIdent,
  type SessionClaims,
} from "simetra/model"
import {
  createCommandRuntime,
  fromPgPool,
  type CommandDatabase,
  type CommandRuntime,
} from "simetra/server"
import {
  ORG_KIND_ID,
  TICKET_WRITER_ID,
  queryAs,
  testProvider,
} from "../../../simetra/test/support"
import { SIGNAL_FUNCTIONS } from "../../../simetra/src/compiler/signal/names"
import { sessionOf } from "./support/db"
import {
  TICKET,
  type Env,
  type Org,
  type Pools,
  heldEnv,
  heldLogin,
  seedOrg,
} from "./rights-admin-commands.support"

/**
 * `runtime.authorizeChannels` над ціллю, розгорнутою справжніми `plan` +
 * `apply` (спека П4-B §8.3; Р5, Р12 плану B2): суб'єкт гранту —
 * `current_user_id()` під claims сесії, а канал у гранті — лише той, який
 * оракул `signal_topic_allowed(c, false)` пропускає під роллю запиту.
 * Видимість скоупу й права судить Postgres — порт-фейк unit-тестів T3 цього
 * не доводить. Відповідь звіряється з оракулом, спитаним напряму на кожному
 * каналі набору, і з явними очікуваннями: свій канал є, чужий скоуп відсіяно.
 */

const TOPIC_SQL = `SELECT ${quoteIdent(SIGNAL_FUNCTIONS.topicAllowed.schema)}.${quoteIdent(SIGNAL_FUNCTIONS.topicAllowed.name)}($1, false) AS v`

export function describeAuthorizeChannels(): void {
  describe("runtime.authorizeChannels over a planned and applied target", () => {
    const target = heldEnv()
    let env: Env
    let own: Org
    let foreign: Org

    beforeAll(async () => {
      env = await target.open()
      own = await seedOrg(env.owner, {
        reader: [TICKET_WRITER_ID],
        member: [],
      })
      foreign = await seedOrg(env.owner, { reader: [TICKET_WRITER_ID] })
    }, 180_000)
    afterAll(() => target.close(), 60_000)

    // Роль входу — після розгортання: план відмовляє, доки роль команд має
    // чужого члена.
    const login = heldLogin(() => env.url)
    let pools: Pools
    beforeAll(async () => {
      pools = await login.open()
    }, 60_000)
    afterAll(() => login.close(), 60_000)

    /** Рантайм над портом, що лічить з'єднання після створення. */
    async function counted(): Promise<{
      runtime: CommandRuntime
      connects: () => number
    }> {
      const base = fromPgPool(pools.direct)
      let connects = 0
      const database: CommandDatabase = {
        connect: () => {
          connects++
          return base.connect()
        },
      }
      const runtime = await createCommandRuntime({
        database,
        catalog: env.catalog,
      })
      const created = connects
      return { runtime, connects: () => connects - created }
    }

    const ticketId = () =>
      env.catalog.objects.find((o) => o.name === TICKET.name)!.id
    const ticketChannel = (scope: string) =>
      channelTopic({
        kind: "changes",
        scopeKindId: ORG_KIND_ID,
        scope,
        object: ticketId(),
      })
    const rightsChannel = (scope: string) =>
      channelTopic({ kind: "rights", scopeKindId: ORG_KIND_ID, scope })
    const userChannel = (userId: string) =>
      channelTopic({ kind: "user", userId })
    const GLOBAL_RIGHTS = channelTopic({
      kind: "rights",
      scopeKindId: ZERO_UUID,
      scope: ZERO_UUID,
    })
    /**
     * Набір кейсу: канали змін свого й чужого скоупу, канали прав обох
     * скоупів і глобальний, канал свого й чужого користувача, сміття.
     */
    const channels = (user: string) => [
      ticketChannel(own.id),
      ticketChannel(foreign.id),
      channelTopic({
        kind: "changes",
        scopeKindId: ZERO_UUID,
        scope: ZERO_UUID,
        object: ticketId(),
      }),
      userChannel(user),
      userChannel(randomUUID()),
      rightsChannel(own.id),
      rightsChannel(foreign.id),
      GLOBAL_RIGHTS,
      "not-a-channel",
    ]
    /** Канали прав учасника скоупу `scope` (Р10 плану B6-1): без умови права. */
    const rightsOf = (user: string, scope: string) => [
      userChannel(user),
      rightsChannel(scope),
      GLOBAL_RIGHTS,
    ]

    /** Оракул, спитаний напряму під роллю запиту з тими самими claims. */
    async function oracle(
      session: SessionClaims,
      list: string[]
    ): Promise<string[]> {
      await env.owner.query("BEGIN")
      try {
        const allowed: string[] = []
        for (const channel of list) {
          const answer = await queryAs<{ v: boolean }>(
            env.owner,
            "user",
            session,
            TOPIC_SQL,
            [channel]
          )
          if (!("rows" in answer))
            throw new Error(`oracle refused: ${answer.code}`)
          if (answer.rows[0]!.v) allowed.push(channel)
        }
        return allowed.sort()
      } finally {
        await env.owner.query("ROLLBACK")
      }
    }

    it("a reader gets its own scope's channel and not the foreign one; the grant equals the oracle on every channel", async () => {
      const reader = own.people.reader!
      const list = channels(reader.user)
      const { runtime } = await counted()
      const grant = await runtime.authorizeChannels(reader.session, [
        ...list,
        list[0]!,
      ])
      expect({ ...grant }).toEqual({
        subject: reader.user,
        channels: [
          ticketChannel(own.id),
          ...rightsOf(reader.user, own.id),
        ].sort(),
      })
      expect(grant.channels).toEqual(await oracle(reader.session, list))
    })

    it("the reader of the other scope gets only its own", async () => {
      const reader = foreign.people.reader!
      const list = channels(reader.user)
      const { runtime } = await counted()
      const grant = await runtime.authorizeChannels(reader.session, list)
      expect(grant.channels).toEqual(
        [ticketChannel(foreign.id), ...rightsOf(reader.user, foreign.id)].sort()
      )
      expect(grant.channels).toEqual(await oracle(reader.session, list))
    })

    // Канали прав — межа тенанта, не право (Р10 плану B6-1): учасник без
    // права читання дізнається про зміну своїх прав, каналів змін не має.
    it("a member without a read right: the user, only the rights channels", async () => {
      const member = own.people.member!
      const list = channels(member.user)
      const { runtime } = await counted()
      const grant = await runtime.authorizeChannels(member.session, list)
      expect({ ...grant }).toEqual({
        subject: member.user,
        channels: rightsOf(member.user, own.id).sort(),
      })
      expect(grant.channels).toEqual(await oracle(member.session, list))
    })

    it("a subject without a valid user: no subject, no channels", async () => {
      const { runtime } = await counted()
      const grant = await runtime.authorizeChannels(
        sessionOf(randomUUID()),
        channels(randomUUID())
      )
      expect({ ...grant }).toEqual({ subject: null, channels: [] })
    })

    // Інваріант 9: гість не має ні з'єднання, ні каналів — і до бази не йде.
    it("an anonymous session gets an empty grant without a connection", async () => {
      const claim = PROVIDER_IDENTITY_SOURCES[testProvider()].anonymousClaim!
      const reader = own.people.reader!
      const { runtime, connects } = await counted()
      const grant = await runtime.authorizeChannels(
        { ...reader.session, [claim]: true },
        channels(reader.user)
      )
      expect({ ...grant }).toEqual({ subject: null, channels: [] })
      expect(connects()).toBe(0)
    })
  })
}
