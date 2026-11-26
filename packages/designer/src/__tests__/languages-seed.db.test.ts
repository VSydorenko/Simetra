import { describe, expect, it } from "vitest"
import type pg from "pg"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  LANGUAGES_FILE,
  LANGUAGES_TABLE,
  PROJECT_FILE,
  attribute,
  languagesLayer,
  policyDomain,
  profileLayer,
  superuserClient,
  type Layer,
  uuid,
} from "../../../simetra/test/support"
import { applyOn, planOn, withModelTarget } from "./support/db"

/**
 * Засів основної мови (Р-B2-7) і звірка цілі перед ним (Р-B2-8) на
 * справжньому apply дизайнера (план B2 §5, інваріант 9). Причина DB-рівня:
 * рядок засіву проходить BEFORE-тригери таблиці під роллю apply, а звірку
 * план робить читанням живої цілі — unit-тести бачать лише вердикт над
 * підставними рядками. Стани цілі, яких тригер стану не пропускає, готує
 * суперкористувач у режимі `session_replication_role = replica` (тригери
 * користувача не спрацьовують, CHECK і індекси — діють) і комітить: план
 * читає ціль власними з'єднаннями.
 */

const T = `public.${LANGUAGES_TABLE}`
const LABEL = "primary_language"
const REFUSAL = "apply.primary-language-changed"

/** Модель домену політик з «Мовами»; `extra` — шари поверх. */
async function model(...extra: Layer[]): Promise<CompiledModel> {
  const result = await compile(
    policyDomain(languagesLayer(), profileLayer(), ...extra)
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

/** Той самий довідник без ролі й без основної мови проєкту. */
const withoutRole: Layer = {
  [PROJECT_FILE]: { primaryDataLanguage: undefined },
  [LANGUAGES_FILE]: { role: undefined },
}

const primary = (code: string): Layer => ({
  [PROJECT_FILE]: { primaryDataLanguage: code },
})

/**
 * Непов'язана зміна моделі (новий реквізит «Мов»): хеш інший, тож план не
 * `unchanged` і звірка засіву виконується над засіяною ціллю.
 */
const unrelatedChange: Layer = {
  [LANGUAGES_FILE]: {
    attributes: [
      attribute("note", { id: uuid(9990), type: "String", length: 20 }),
    ],
  },
}

/**
 * План засіяної цілі зі зміною моделі: вердикт `seeded` (дозволений стан 2
 * Р-B2-8) — план без помилок і без кроку засіву.
 */
const seededPlan = async (url: string, m: CompiledModel) => {
  const outcome = await planOn(url, m)
  return {
    status: outcome.status,
    errors: outcome.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => d.code),
    seedSteps:
      outcome.status === "planned"
        ? outcome.artifact.steps.filter((s) => s.origin === "seeds").length
        : null,
  }
}

const SEEDED_PLAN = { status: "planned", errors: [], seedSteps: 0 }

const database = (url: string) => new URL(url).pathname.slice(1)

/** Оператори в одній закомітованій транзакції без тригерів користувача. */
async function committedReplica(
  client: pg.Client,
  ...sql: string[]
): Promise<void> {
  await client.query("BEGIN")
  try {
    await client.query("SET LOCAL session_replication_role = replica")
    for (const statement of sql) await client.query(statement)
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  }
}

async function rows(client: pg.Client, columns: string) {
  return (await client.query(`SELECT ${columns} FROM ${T} ORDER BY code`)).rows
}

/** Помилки плану: статус і коди з параметрами. */
const refusalOf = async (url: string, m: CompiledModel) => {
  const outcome = await planOn(url, m)
  return {
    status: outcome.status,
    errors: outcome.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => ({ code: d.code, params: d.params })),
  }
}

const refused = (language: string) => ({
  status: "refused",
  errors: [
    {
      code: REFUSAL,
      params: { table: `public.${LANGUAGES_TABLE}`, language },
    },
  ],
})

const SEEDED = {
  code: "uk",
  state: "published",
  is_primary: true,
  predefined_name: LABEL,
}

describe("the seed of the primary language on apply", () => {
  it("seeds once, then refuses every target state the seed would swallow", async () => {
    const uk = await model()
    await withModelTarget(uk, async (url) => {
      const client = await superuserClient(database(url))
      try {
        // Засів пройшов тригери таблиці під роллю apply: застосування закомічено
        expect(
          await rows(client, "code, state, is_primary, predefined_name")
        ).toEqual([SEEDED])
        // Повторний план тієї самої моделі — ярлик хешу, звірки немає
        expect((await planOn(url, uk)).status).toBe("unchanged")
        // Зі зміною моделі звірка бачить засіяну ціль: план без кроку засіву
        const changed = await model(unrelatedChange)
        expect(await seededPlan(url, changed)).toEqual(SEEDED_PLAN)
        // Інша основна мова в конфігу — відмова плану до будь-якого кроку
        expect(await refusalOf(url, await model(primary("en")))).toEqual(
          refused("en")
        )
        expect(
          await rows(client, "code, state, is_primary, predefined_name")
        ).toEqual([SEEDED])

        // Решта заборонених станів — над єдиним рядком цілі, який план з
        // основною `en` (інший хеш моделі, тож план не `unchanged`) мусить
        // відмовити саме через цей стан: рядок із кодом `en` у кожному
        const en = await model(primary("en"))
        const restore = `UPDATE ${T} SET code = 'uk', state = 'published', is_primary = true, predefined_name = '${LABEL}'`
        for (const [state, change] of [
          [
            "the labelled row without is_primary",
            "SET code = 'en', is_primary = false",
          ],
          [
            "the primary without the label",
            "SET code = 'en', predefined_name = NULL",
          ],
          [
            "an unlabelled row with the primary code",
            "SET code = 'en', predefined_name = NULL, is_primary = false, state = 'draft'",
          ],
        ] as const) {
          await committedReplica(client, `UPDATE ${T} ${change}`)
          try {
            expect([state, await refusalOf(url, en)]).toEqual([
              state,
              refused("en"),
            ])
          } finally {
            await committedReplica(client, restore)
          }
        }
        // Відновлена ціль — знову засіяна
        expect(await seededPlan(url, changed)).toEqual(SEEDED_PLAN)
      } finally {
        await client.end()
      }
    })
  }, 300_000)

  it("the role added to a catalog with rows seeds next to them, refusing a row the seed would collide with", async () => {
    await withModelTarget(await model(withoutRole), async (url) => {
      const client = await superuserClient(database(url))
      try {
        await client.query(
          `INSERT INTO ${T} (id, code, description) VALUES (gen_random_uuid(), 'en', 'en'), (gen_random_uuid(), 'de', 'de')`
        )
        const uk = await model()
        // Колонок ролі на цілі ще немає: рядок з міткою чи з кодом основної —
        // відмова, а не тихий `DO NOTHING` чи `23505` на застосуванні
        for (const [state, setup, undo] of [
          [
            "a row with the label",
            `UPDATE ${T} SET predefined_name = '${LABEL}' WHERE code = 'en'`,
            `UPDATE ${T} SET predefined_name = NULL WHERE code = 'en'`,
          ],
          [
            "an unlabelled row with the primary code",
            `INSERT INTO ${T} (id, code, description) VALUES (gen_random_uuid(), 'uk', 'uk')`,
            `DELETE FROM ${T} WHERE code = 'uk'`,
          ],
        ] as const) {
          await committedReplica(client, setup)
          try {
            expect([state, await refusalOf(url, uk)]).toEqual([
              state,
              refused("uk"),
            ])
          } finally {
            await committedReplica(client, undo)
          }
        }
        // Без збігів — засів поруч з наявними рядками, вони — `draft`, не основні
        expect((await applyOn(url, uk)).status).toBe("committed")
        expect(
          await rows(client, "code, state, is_primary, predefined_name")
        ).toEqual([
          {
            code: "de",
            state: "draft",
            is_primary: false,
            predefined_name: null,
          },
          {
            code: "en",
            state: "draft",
            is_primary: false,
            predefined_name: null,
          },
          SEEDED,
        ])
        // Повторний план зі зміною моделі — засіяно, кроку засіву немає
        expect(await seededPlan(url, await model(unrelatedChange))).toEqual(
          SEEDED_PLAN
        )
      } finally {
        await client.end()
      }
    })
  }, 300_000)
})
