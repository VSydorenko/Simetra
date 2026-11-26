import { randomUUID } from "node:crypto"
import pg from "pg"
import { describe, expect, it } from "vitest"
import { buildRuntimeCatalog, compile } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  type MetadataRef,
} from "simetra/model"
import { createCommandRuntime, fromPgPool, readRoleOf } from "simetra/server"
import {
  gaugeRichTextLayer,
  policyDomain,
  profileLayer,
  RICH_TEXT_EMPTINESS_CASES,
  STARTER_KIT_SAMPLE,
  testProvider,
  UNKNOWN_NODE_SAMPLE,
} from "../../../simetra/test/support"
import {
  commandRefusal,
  seedMarker,
  seedRuntimeActor,
  sessionOf,
  withModelTarget,
  withRuntimeLogin,
} from "./support/db"

/**
 * Запис і читання `RichText` на стенді. Причина DB-рівня: значення проходить
 * `jsonb` і роль запиту (порядок ключів, права на таблицю), а
 * `simetra.rich_text_is_empty` виконує Postgres від ролі, що пише, — T0
 * цього не бачить. Один сценарій на одній базі.
 */

const GAUGE: MetadataRef = { kind: "Catalog", name: "Gauge" }
const REQUEST_ROLE = readRoleOf(testProvider())!
const USER_ROLE = PROVIDER_API_ROLES[testProvider()].user
const MIB = 1024 * 1024

const docOf = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

describe("RichText on a live database", () => {
  it("writes, reads, refuses and answers emptiness for both session roles", async () => {
    const result = await compile(
      policyDomain(gaugeRichTextLayer({}), profileLayer())
    )
    expect(result.diagnostics).toEqual([])
    const model = result.model!
    await withModelTarget(model, async (url) => {
      const owner = new pg.Client({ connectionString: url })
      await owner.connect()
      try {
        await seedMarker(owner, model.hash)
        const actor = await seedRuntimeActor(owner)
        const session = sessionOf(actor.user)
        await withRuntimeLogin(
          url,
          [PLATFORM_ROLES.command, REQUEST_ROLE, USER_ROLE],
          async (login) => {
            const pool = new pg.Pool({ connectionString: login })
            try {
              const rt = await createCommandRuntime({
                database: fromPgPool(pool),
                catalog: buildRuntimeCatalog(model),
              })
              const id = randomUUID()
              const created = await rt.run(session, {
                action: "create",
                object: GAUGE,
                id,
                values: {
                  org: actor.org,
                  counter: 1n,
                  article: STARTER_KIT_SAMPLE,
                },
              })
              const version = created.rows[0]!.version as number

              // `jsonb` міняє порядок ключів: порівнюємо глибоко, не текстом
              const card = await rt.read(session, { object: GAUGE, id })
              expect(card.rows[0]!.article).toEqual(STARTER_KIT_SAMPLE)
              // Лінивий реквізит шапки списком не віддається
              const list = await rt.read(session, {
                object: GAUGE,
                where: { attribute: "ref", op: "in", value: [id] },
                limit: 10,
              })
              expect(list.rows).toHaveLength(1)
              expect(list.rows[0]).not.toHaveProperty("article")

              const stored = async () =>
                (
                  await owner.query(
                    "SELECT article, version FROM public.gauge WHERE id = $1",
                    [id]
                  )
                ).rows[0]
              const before = await stored()

              expect(
                await commandRefusal(
                  rt.run(session, {
                    action: "update",
                    object: GAUGE,
                    id,
                    expectedVersion: version,
                    values: { article: UNKNOWN_NODE_SAMPLE },
                  })
                )
              ).toMatchObject({
                code: "command.invalid",
                path: "article",
                reason: "rich-text-profile",
              })
              expect(await stored()).toEqual(before)

              expect(
                await commandRefusal(
                  rt.run(session, {
                    action: "update",
                    object: GAUGE,
                    id,
                    expectedVersion: version,
                    values: { article: docOf("a".repeat(MIB + 1)) },
                  })
                )
              ).toMatchObject({
                code: "command.invalid",
                path: "article",
                reason: "too-large",
              })
              expect(await stored()).toEqual(before)

              expect(
                await commandRefusal(
                  rt.read(session, {
                    object: GAUGE,
                    where: {
                      attribute: "article",
                      op: "eq",
                      value: STARTER_KIT_SAMPLE,
                    },
                    limit: 10,
                  })
                )
              ).toMatchObject({ code: "command.invalid" })
            } finally {
              await pool.end()
            }

            // Функцію виконує кожна роль, що може писати: роль команд і роль
            // користувача (`SET ROLE` — логін членствує без наслідування)
            for (const role of [PLATFORM_ROLES.command, USER_ROLE]) {
              const client = new pg.Client({ connectionString: login })
              await client.connect()
              try {
                await client.query(`SET ROLE "${role}"`)
                for (const row of RICH_TEXT_EMPTINESS_CASES) {
                  const answer = await client.query(
                    "SELECT simetra.rich_text_is_empty($1::jsonb) AS empty",
                    [JSON.stringify(row.doc)]
                  )
                  expect(
                    { role, name: row.name, empty: answer.rows[0].empty },
                    `${role}: ${row.name}`
                  ).toEqual({ role, name: row.name, empty: row.empty })
                }
                const nul = await client.query(
                  "SELECT simetra.rich_text_is_empty(NULL) AS empty"
                )
                expect(nul.rows[0].empty).toBeNull()
              } finally {
                await client.end()
              }
            }
          },
          "rich_text"
        )
      } finally {
        await owner.end()
      }
    })
  }, 120_000)
})
