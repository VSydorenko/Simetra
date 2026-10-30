import { randomUUID } from "node:crypto"
import pg from "pg"
import { describe, expect, it } from "vitest"
import { compile, hierarchyNames } from "simetra/compiler"
import {
  COMMAND_SETTING,
  PLATFORM_ROLES,
  RIGHTS_MAINTENANCE_SETTING,
  SESSION_CLAIMS_SETTING,
} from "simetra/model"
import { engineScope, renderDesiredState } from "simetra/schema"
import {
  TICKET_CHECKLIST_TABLE,
  TICKET_TABLE,
  TICKET_TARGETS_READER_ID,
  TICKET_WRITER_ID,
  commandCoreLayer,
  policyDomain,
  ticketMoveToHandler,
  withSql,
  writeRoles,
} from "../../../simetra/test/support"
import { inTarget, waitForLock } from "./support/db"

/**
 * Паралельні правки ядра довідника й цикл ієрархії (план П4-A2, Задача 9).
 * Замок рядка, advisory-замок ієрархії й знімок `READ COMMITTED` вирішує
 * Postgres, і лише між двома з'єднаннями над закоміченими даними: точка
 * збереження однієї транзакції (`commandAs`) відкотила б і замок. Тому ціль
 * — тінь рушія з бажаним SQL (стан провайдера є), засів закомічений, кожна
 * команда — власна транзакція сесії, як її виконає `runCommand`.
 */

const LINES = TICKET_CHECKLIST_TABLE
const INVALID_PARENT = {
  code: "22023",
  message: "command.invalid",
  detail: "parent_id",
}
const HIERARCHY = hierarchyNames({ schema: "public", name: TICKET_TABLE })

interface Actor {
  org: string
  user: string
}

async function session(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  return client
}

/** Транзакція засіву власником: закомічена, бо її читає інша сесія. */
async function committed(
  owner: pg.Client,
  steps: () => Promise<void>
): Promise<void> {
  await owner.query("BEGIN")
  try {
    await steps()
    await owner.query("COMMIT")
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined)
    throw error
  }
}

/**
 * Актор команд: організація, користувач і учасник із `TicketWriter` (`any`)
 * і `TicketTargetsReader` (без читання цілей `Ref` дав би `command.invalid`
 * раніше за ієрархію). Призначення — довідник прав, тож засів під режимом
 * обслуговування, а відкладені запобіжники перевіряються до його вимкнення.
 */
async function seedActor(owner: pg.Client): Promise<Actor> {
  const org = randomUUID()
  const user = randomUUID()
  const member = randomUUID()
  await committed(owner, async () => {
    await owner.query("SELECT set_config($1, 'on', true)", [
      RIGHTS_MAINTENANCE_SETTING,
    ])
    await owner.query("INSERT INTO public.organization (id) VALUES ($1)", [org])
    await owner.query("INSERT INTO public.users (id) VALUES ($1)", [user])
    await owner.query(
      "INSERT INTO public.org_member (id, org_id, user_id) VALUES ($1, $2, $3)",
      [member, org, user]
    )
    for (const archetype of [TICKET_WRITER_ID, TICKET_TARGETS_READER_ID])
      await owner.query(
        "INSERT INTO public.org_role_assignments (id, org_id, subject, archetype) VALUES ($1, $2, $3, $4)",
        [randomUUID(), org, member, archetype]
      )
    await owner.query("SET CONSTRAINTS ALL IMMEDIATE")
    await owner.query("SELECT set_config($1, 'off', true)", [
      RIGHTS_MAINTENANCE_SETTING,
    ])
  })
  return { org, user }
}

/**
 * Свіжі рядки `Ticket` для кейсу (`[ключ, ключ батька | null]`, батько —
 * раніше в переліку): кейси ділять закомічену базу, тож кожен бере свої.
 */
async function seedTickets(
  owner: pg.Client,
  actor: Actor,
  rows: [string, string | null][]
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {}
  await committed(owner, async () => {
    for (const [key, parent] of rows) {
      ids[key] = randomUUID()
      await owner.query(
        `INSERT INTO public.${TICKET_TABLE} (id, org_id, parent_id) VALUES ($1, $2, $3)`,
        [ids[key], actor.org, parent === null ? null : ids[parent]]
      )
    }
  })
  return ids
}

async function versionOf(owner: pg.Client, id: string): Promise<string> {
  const { rows } = await owner.query<{ v: string }>(
    `SELECT version::text AS v FROM public.${TICKET_TABLE} WHERE id = $1`,
    [id]
  )
  return rows[0]!.v
}

/**
 * Початок команди в сесії: `BEGIN` → claims → контекст → роль команд, як
 * `runCommand`. Транзакцію завершує той, хто кличе: замок має пережити крок.
 */
async function openCommand(
  client: pg.Client,
  actor: Actor,
  root: string,
  isolation = "READ COMMITTED"
): Promise<void> {
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`)
  await client.query("SELECT set_config($1, $2, true)", [
    SESSION_CLAIMS_SETTING,
    JSON.stringify({ sub: actor.user, role: "authenticated" }),
  ])
  await client.query("SELECT set_config($1, $2, true)", [
    COMMAND_SETTING,
    JSON.stringify({ action: "update", object: TICKET_TABLE, root }),
  ])
  await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
}

const saveSql = `SELECT public.${TICKET_TABLE}_save($1::jsonb, $2::bigint) AS r`
const saveParams = (item: Record<string, unknown>, version: string) => [
  JSON.stringify(item),
  version,
]

/** Помилка Postgres кроку чи `undefined`: відмова — очікуваний результат. */
async function failureOf(step: Promise<unknown>): Promise<unknown> {
  try {
    await step
    return undefined
  } catch (error) {
    if (!(error instanceof pg.DatabaseError)) throw error
    return error
  }
}

/** Одна команда в сесії з відкатом наприкінці: її помилка чи `undefined`. */
async function attempt(
  client: pg.Client,
  actor: Actor,
  root: string,
  sql: string,
  params: unknown[],
  isolation?: string
): Promise<unknown> {
  try {
    await openCommand(client, actor, root, isolation)
    // Наявний цикл у даних не має завісити обхід: тайм-аут перетворює
    // зависання на червоний кейс, а не на зависле прогоном
    await client.query("SET LOCAL statement_timeout = '5s'")
    return await failureOf(client.query(sql, params))
  } finally {
    await client.query("ROLLBACK").catch(() => undefined)
  }
}

/**
 * Дві команди двома сесіями: перша виконує крок і тримає транзакцію, друга
 * стає в чергу на замок (`waitForLock`), перша комітить. Результат — помилка
 * другої (чи `undefined`).
 */
async function race(
  url: string,
  observer: pg.Client,
  actor: Actor,
  first: { root: string; sql: string; params: unknown[] },
  second: { root: string; sql: string; params: unknown[] }
): Promise<unknown> {
  const one = await session(url)
  const two = await session(url)
  try {
    await openCommand(one, actor, first.root)
    await one.query(first.sql, first.params)
    await openCommand(two, actor, second.root)
    const { rows } = await two.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid"
    )
    const pending = failureOf(
      (async () => {
        await two.query(second.sql, second.params)
        await two.query("COMMIT")
      })()
    )
    await waitForLock(observer, rows[0]!.pid)
    await one.query("COMMIT")
    return await pending
  } finally {
    await one.query("ROLLBACK").catch(() => undefined)
    await two.query("ROLLBACK").catch(() => undefined)
    await one.end()
    await two.end()
  }
}

describe("catalog command core: concurrency and hierarchy", () => {
  it("serializes tabular-only edits and rejects hierarchy cycles", async () => {
    const handler = ticketMoveToHandler()
    const result = await compile(
      withSql(
        policyDomain(writeRoles(), commandCoreLayer(), handler.layer),
        handler
      )
    )
    expect(result.diagnostics).toEqual([])
    const model = result.model!
    await inTarget(
      renderDesiredState(model).sql,
      (await engineScope(model)).scope,
      async (url) => {
        const owner = await session(url)
        // Членство в ролі команд — закомічене: сесії команд окремі. Сторож
        // стека бачить лише імена ролей, тож `REVOKE` — обов'язково в `finally`
        await owner.query(
          `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
        )
        try {
          const actor = await seedActor(owner)
          const probe = await session(url)
          try {
            // Правка лише ТЧ теж оновлює шапку (порожній `UPDATE`): інакше
            // друга сесія з тією самою версією не чекала б і не побачила б
            // конфлікту
            {
              const t = await seedTickets(owner, actor, [["K", null]])
              const line = randomUUID()
              await committed(owner, async () => {
                await owner.query(
                  `INSERT INTO public.${LINES} (id, org_id, parent_id, line_number) VALUES ($1, $2, $3, 1)`,
                  [line, actor.org, t.K]
                )
              })
              const version = await versionOf(owner, t.K!)
              const edit = () => ({
                root: t.K!,
                sql: saveSql,
                params: saveParams(
                  {
                    id: t.K,
                    tabular: { [LINES]: [{ id: line }, { id: randomUUID() }] },
                  },
                  version
                ),
              })
              expect(
                await race(url, probe, actor, edit(), edit())
              ).toMatchObject({
                code: "P0001",
                message: "command.conflict",
                detail: "version",
              })
            }

            // Самопосилання й A → B → A через `save`
            {
              const t = await seedTickets(owner, actor, [
                ["A", null],
                ["B", "A"],
              ])
              for (const parent of [t.A!, t.B!])
                expect(
                  await attempt(
                    probe,
                    actor,
                    t.A!,
                    saveSql,
                    saveParams(
                      { id: t.A, parent_id: parent },
                      await versionOf(owner, t.A!)
                    )
                  )
                ).toMatchObject(INVALID_PARENT)
            }

            // Один оператор міняє місцями двох батьків: `AFTER`-тригер кожного
            // рядка бачить обидві зміни. Автор — власник: інваріант бази для
            // будь-якого автора (мігратор, імпорт), не лише для команди
            {
              const t = await seedTickets(owner, actor, [
                ["A", null],
                ["B", null],
              ])
              expect(
                await failureOf(
                  owner.query(
                    `UPDATE public.${TICKET_TABLE} SET parent_id = CASE id WHEN $1::uuid THEN $2::uuid ELSE $1::uuid END WHERE id IN ($1, $2)`,
                    [t.A, t.B]
                  )
                )
              ).toMatchObject(INVALID_PARENT)
            }

            // Два паралельні переміщення прямим `UPDATE`: друге чекає на
            // advisory-замок тригера і після `COMMIT` першого бачить цикл.
            // Не через `save`: він бере той самий замок раніше (Р-A2-17), і
            // без замка в тригері кейс не почервонів би
            {
              const t = await seedTickets(owner, actor, [
                ["A", null],
                ["B", null],
              ])
              const move = (row: string, parent: string) => ({
                root: row,
                sql: `UPDATE public.${TICKET_TABLE} SET parent_id = $2 WHERE id = $1`,
                params: [row, parent],
              })
              expect(
                await race(
                  url,
                  probe,
                  actor,
                  move(t.A!, t.B!),
                  move(t.B!, t.A!)
                )
              ).toMatchObject(INVALID_PARENT)
            }

            // Те саме через `save`: замок ядра серіалізує так само
            {
              const t = await seedTickets(owner, actor, [
                ["A", null],
                ["B", null],
              ])
              const move = async (row: string, parent: string) => ({
                root: row,
                sql: saveSql,
                params: saveParams(
                  { id: row, parent_id: parent },
                  await versionOf(owner, row)
                ),
              })
              expect(
                await race(
                  url,
                  probe,
                  actor,
                  await move(t.A!, t.B!),
                  await move(t.B!, t.A!)
                )
              ).toMatchObject(INVALID_PARENT)
            }

            // Обробник `beforeWrite` присвоює `parent_id` з `move_to`: прямий
            // `UPDATE` іншої колонки. `BEFORE … UPDATE OF parent_id` тут не
            // спрацював би, а `save` присвоює всі ключі зміни, зокрема
            // `parent_id`, — тож лише прямий шлях доводить форму `AFTER`
            {
              const t = await seedTickets(owner, actor, [
                ["A", null],
                ["B", "A"],
              ])
              expect(
                await attempt(
                  probe,
                  actor,
                  t.A!,
                  `UPDATE public.${TICKET_TABLE} SET move_to = $2 WHERE id = $1`,
                  [t.A, t.B]
                )
              ).toMatchObject(INVALID_PARENT)
            }

            // Наявний цикл у даних (прийнята таблиця, імпорт): засів з
            // поіменно вимкненими тригерами ієрархії — `ALL` вимкнув би й FK
            // і вимагав би суперкористувача. Обхід зупиняється на циклі
            {
              const t = await seedTickets(owner, actor, [
                ["C1", null],
                ["C2", "C1"],
                ["E", "C1"],
                ["D", null],
              ])
              await committed(owner, async () => {
                for (const trigger of [HIERARCHY.insert, HIERARCHY.update])
                  await owner.query(
                    `ALTER TABLE public.${TICKET_TABLE} DISABLE TRIGGER "${trigger}"`
                  )
                await owner.query(
                  `UPDATE public.${TICKET_TABLE} SET parent_id = $2 WHERE id = $1`,
                  [t.C1, t.C2]
                )
                for (const trigger of [HIERARCHY.insert, HIERARCHY.update])
                  await owner.query(
                    `ALTER TABLE public.${TICKET_TABLE} ENABLE TRIGGER "${trigger}"`
                  )
              })
              const moveUnder = async (row: string, parent: string) =>
                attempt(
                  probe,
                  actor,
                  row,
                  saveSql,
                  saveParams(
                    { id: row, parent_id: parent },
                    await versionOf(owner, row)
                  )
                )
              // Ланцюг C1 → C2 → C1 … не доходить до D: успіх
              expect(await moveUnder(t.D!, t.C1!)).toBeUndefined()
              // Ланцюг від E доходить до C1: відмова, а не зависання
              expect(await moveUnder(t.C1!, t.E!)).toMatchObject(INVALID_PARENT)
            }

            // Поза `READ COMMITTED` обхід після замка не бачить закоміченого
            // переміщення (Р-A2-13): зміна батька відхиляється одразу
            for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"]) {
              const t = await seedTickets(owner, actor, [
                ["A", null],
                ["B", null],
              ])
              expect(
                await attempt(
                  probe,
                  actor,
                  t.A!,
                  saveSql,
                  saveParams(
                    { id: t.A, parent_id: t.B },
                    await versionOf(owner, t.A!)
                  ),
                  isolation
                )
              ).toMatchObject({ code: "0A000", message: "hierarchy.isolation" })
            }
          } finally {
            await probe.end()
          }
        } finally {
          try {
            await owner.query(
              `REVOKE ${PLATFORM_ROLES.command} FROM CURRENT_USER`
            )
          } finally {
            await owner.end()
          }
        }
      }
    )
  }, 180_000)
})
