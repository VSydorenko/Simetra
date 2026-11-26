import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import { PLATFORM_ROLES } from "simetra/model"
import {
  LANGUAGES_TABLE,
  ROLE_FILE,
  SUPPORT_ID,
  compileRights,
  grant,
  languagesLayer,
  objects,
  policyDomain,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import { claimsFor, commandAs, queryAs, testRoleFor } from "./connection"
import {
  type Seed,
  assignmentRow,
  deploy,
  describeTransaction,
  insert,
  profileLayer,
} from "./rights-seed"

/**
 * Інваріанти безпеки довідника «Мови» на справжньому Postgres (план B2 §5,
 * інваріанти 1–7): частковий унікальний індекс, CHECK, тригер стану, гранти
 * ролі команд і гостя та політика читання опублікованих. Причина DB-рівня:
 * порядок BEFORE-тригерів і CHECK, колонкові гранти й RLS вирішує Postgres —
 * unit-тести бачать лише текст SQL. Тести тригера й CHECK — від власника
 * таблиці (обхід грантів і RLS), щоб втрату гілки тригера не ховав грант;
 * тести грантів і політик — від справжніх ролей профілю. Одне розгортання на
 * опис: схема й засів — у транзакції опису, кожен кейс — у точці збереження.
 */

const T = `public.${LANGUAGES_TABLE}`
const COMMAND = PLATFORM_ROLES.command

/**
 * Домен політик з «Мовами» і глобальною `Support`, що читає їх `read@any` і
 * створює (`create`): створення пускає вставку ролі команд крізь RLS до CHECK.
 */
async function languagesModel() {
  const result = await compileRights(
    policyDomain(
      languagesLayer(),
      {
        [ROLE_FILE("Support")]: {
          grants: [
            grant(objects(["Catalog", "Languages"]), ["read", "create"], "any"),
          ],
        },
      },
      profileLayer()
    )
  )
  expect(result.diagnostics).toEqual([])
  return result.model!
}

/**
 * Засів: основна `uk` (`published`), `en` (`published`), `de` (`draft`),
 * `fr` (`disabled`); користувач `u0` без прав на «Мови» і `s1` з `Support`.
 * Рядки — від власника; основну вставляє так само, як засів apply (тригер
 * пропускає вставку основної в `published`), не-основні проходять стан
 * `draft`, як команди.
 */
async function seedLanguages(client: pg.Client): Promise<Seed> {
  const ids: Seed = { u0: await signUp(client), s1: await signUp(client) }
  await insert(
    client,
    "global_role_assignments",
    assignmentRow(ids.s1!, { archetype: SUPPORT_ID })
  )
  ids.uk = randomUUID()
  await client.query(
    `INSERT INTO ${T} (id, code, description, state, is_primary) VALUES ($1, 'uk', 'uk', 'published', true)`,
    [ids.uk]
  )
  for (const [code, state] of [
    ["en", "published"],
    ["de", "draft"],
    ["fr", "disabled"],
  ] as const) {
    ids[code] = randomUUID()
    await client.query(
      `INSERT INTO ${T} (id, code, description) VALUES ($1, $2, $2)`,
      [ids[code], code]
    )
    if (state !== "draft")
      await client.query(`UPDATE ${T} SET state = $2 WHERE id = $1`, [
        ids[code],
        state,
      ])
  }
  return ids
}

/**
 * Наслідок запису власника: `ok` або код, повідомлення й деталь відмови, а
 * також чи взяв відмовлений запис версію рядка. Видача версії —
 * `nextval` послідовності `simetra.row_version` у `simetra_touch`, а
 * `currval` сесії відкат точки збереження не повертає: незмінний `currval`
 * доводить, що відмова сталася до тригера механіки.
 */
type Outcome =
  | "ok"
  | { code: string; message: string; detail?: string; versionTaken: boolean }

const VERSION = "SELECT currval('simetra.row_version')::text AS v"

/** Відмова тригера стану (Р-B2-4) — до `simetra_touch`. */
const STATE_REFUSAL: Outcome = {
  code: "22023",
  message: "command.invalid",
  detail: "language-state",
  versionTaken: false,
}

describe("languages catalog invariants on a live database", () => {
  const tx = describeTransaction()
  let ids: Seed = {}

  beforeAll(async () => {
    const client = await tx.open()
    await deploy(client, await languagesModel())
    ids = await seedLanguages(client)
  })

  afterAll(() => tx.close())

  /**
   * Оператори від власника в точці збереження: підготовчі мусять пройти,
   * наслідок — останнього, і версію судимо лише за ним. Деталь порушення
   * обмеження (`Failing row contains …`) — шум: обмеження називає повідомлення.
   */
  const asOwner = async (...sql: string[]): Promise<Outcome> => {
    const client = tx.client()
    const setup = sql.slice(0, -1)
    const last = sql.at(-1)!
    await client.query("SAVEPOINT owner_write")
    try {
      for (const statement of setup) await client.query(statement)
      const before = (await client.query<{ v: string }>(VERSION)).rows[0]!.v
      await client.query("SAVEPOINT owner_last")
      try {
        await client.query(last)
        return "ok"
      } catch (error) {
        const { code, message, detail, constraint } = error as pg.DatabaseError
        await client.query("ROLLBACK TO SAVEPOINT owner_last")
        const after = (await client.query<{ v: string }>(VERSION)).rows[0]!.v
        return {
          code: code!,
          message,
          ...(detail === undefined || constraint !== undefined
            ? {}
            : { detail }),
          versionTaken: after !== before,
        }
      }
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT owner_write")
    }
  }

  const id = (key: string) => {
    const value = ids[key]
    if (value === undefined) throw new Error(`unknown seed key ${key}`)
    return value
  }

  /** Вставка мови `code` з додатковими колонками `extra` (значення — SQL). */
  const insertRow = (code: string, extra: Record<string, string> = {}) => {
    const columns = ["id", "code", "description", ...Object.keys(extra)]
    const values = [
      "gen_random_uuid()",
      `'${code}'`,
      `'${code}'`,
      ...Object.values(extra),
    ]
    return `INSERT INTO ${T} (${columns.join(", ")}) VALUES (${values.join(", ")})`
  }

  describe("1: at most one primary language", () => {
    it("a second primary row breaks the partial unique index", async () => {
      expect(
        await asOwner(
          insertRow("pl", { state: "'published'", is_primary: "true" })
        )
      ).toMatchObject({ code: "23505" })
    })
  })

  describe("2: the primary language stays published", () => {
    it.each<[string, Outcome]>([
      // `published → disabled` матриця дозволяє: відмовляє лише CHECK основної
      [
        "disabled",
        {
          code: "23514",
          message: `new row for relation "${LANGUAGES_TABLE}" violates check constraint "${LANGUAGES_TABLE}_is_primary_check"`,
          versionTaken: true,
        },
      ],
      // `published → draft` поза матрицею: тригер стану стоїть перед CHECK
      ["draft", STATE_REFUSAL],
    ])("moving the primary to %s is refused", async (state, outcome) => {
      expect(
        await asOwner(`UPDATE ${T} SET state = '${state}' WHERE code = 'uk'`)
      ).toEqual(outcome)
    })
  })

  describe("3: is_primary and code are immutable", () => {
    it.each([
      ["is_primary true → false", "SET is_primary = false WHERE code = 'uk'"],
      ["is_primary false → true", "SET is_primary = true WHERE code = 'en'"],
      ["code", "SET code = 'pl' WHERE code = 'en'"],
    ])("the owner changing %s meets the state trigger", async (_, change) => {
      expect(await asOwner(`UPDATE ${T} ${change}`)).toEqual(STATE_REFUSAL)
    })
  })

  describe("4: state transitions follow the matrix", () => {
    // Оракул — літерал матриці §3, а не факт T0
    const MATRIX: [from: string, to: string, allowed: boolean][] = [
      ["draft", "draft", true],
      ["draft", "published", true],
      ["draft", "disabled", true],
      ["published", "draft", false],
      ["published", "published", true],
      ["published", "disabled", true],
      ["disabled", "draft", true],
      ["disabled", "published", true],
      ["disabled", "disabled", true],
    ]

    it.each(MATRIX)("%s → %s allowed: %s", async (from, to, allowed) => {
      const setState = (state: string) =>
        `UPDATE ${T} SET state = '${state}' WHERE code = 'pl'`
      expect(
        await asOwner(
          insertRow("pl"),
          ...(from === "draft" ? [] : [setState(from)]),
          setState(to)
        )
      ).toEqual(allowed ? "ok" : STATE_REFUSAL)
    })
  })

  describe("5: a non-primary language is inserted only as draft", () => {
    it.each<[string, Record<string, string>, Outcome]>([
      ["published", { state: "'published'" }, STATE_REFUSAL],
      ["disabled", { state: "'disabled'" }, STATE_REFUSAL],
      ["draft", { state: "'draft'" }, "ok"],
      ["the default state", {}, "ok"],
    ])("an insert with %s", async (_, extra, outcome) => {
      expect(await asOwner(insertRow("pl", extra))).toEqual(outcome)
    })
  })

  describe("6: no deletion and no deletion mark", () => {
    it.each<[string, string, Outcome]>([
      ["DELETE", `DELETE FROM ${T} WHERE code = 'en'`, STATE_REFUSAL],
      // `UPDATE` мітки — саме тригер: CHECK дав би 23514 і сховав би втрату гілки
      [
        "setting the deletion mark",
        `UPDATE ${T} SET deletion_mark = true WHERE code = 'de'`,
        STATE_REFUSAL,
      ],
      [
        "an insert with the deletion mark",
        insertRow("pl", { deletion_mark: "true" }),
        {
          code: "23514",
          message: `new row for relation "${LANGUAGES_TABLE}" violates check constraint "${LANGUAGES_TABLE}_deletion_mark_check"`,
          versionTaken: true,
        },
      ],
      ["TRUNCATE", `TRUNCATE ${T}`, STATE_REFUSAL],
    ])("%s by the owner is refused", async (_, sql, outcome) => {
      expect(await asOwner(sql)).toEqual(outcome)
    })
  })

  describe("3, 5, 6: the command role writes only outside the role columns", () => {
    const denied = {
      code: "42501",
      message: `permission denied for table ${LANGUAGES_TABLE}`,
    }

    // Відмова гранту, а не RLS: та дала б 42501 з іншим повідомленням
    it.each([
      ["UPDATE is_primary", `UPDATE ${T} SET is_primary = false`],
      ["UPDATE code", `UPDATE ${T} SET code = 'pl'`],
      ["UPDATE deletion_mark", `UPDATE ${T} SET deletion_mark = true`],
      ["INSERT state", insertRow("pl", { state: "'draft'" })],
      ["INSERT is_primary", insertRow("pl", { is_primary: "false" })],
      ["INSERT deletion_mark", insertRow("pl", { deletion_mark: "false" })],
      ["DELETE", `DELETE FROM ${T}`],
    ])("%s is outside the grant", async (_, sql) => {
      expect(
        await commandAs(
          tx.client(),
          claimsFor("user", id("u0")),
          undefined,
          sql
        )
      ).toMatchObject(denied)
    })

    it("the column grants of the command role match the role facts", async () => {
      const { rows } = await tx.client().query<{ privilege: string }>(
        `SELECT c.column_name || ' ' || p.kind AS privilege
           FROM information_schema.columns c
          CROSS JOIN (VALUES ('INSERT'), ('UPDATE')) AS p(kind)
          WHERE c.table_schema = 'public' AND c.table_name = $2
            AND has_column_privilege($1, '${T}', c.column_name, p.kind)
          ORDER BY 1`,
        [COMMAND, LANGUAGES_TABLE]
      )
      expect(rows.map((r) => r.privilege)).toEqual([
        "code INSERT",
        "description INSERT",
        "description UPDATE",
        "id INSERT",
        "state UPDATE",
      ])
      const { rows: del } = await tx
        .client()
        .query<{ v: boolean }>(
          "SELECT has_table_privilege($1, $2, 'DELETE') AS v",
          [COMMAND, T]
        )
      expect(del[0]!.v).toBe(false)
    })
  })

  describe("the code is required", () => {
    // CHECK ролі, а не NOT NULL колонки: код без значення дав би мову, якій
    // код уже не задати (тригер) і яку не видалити (Р-B2-1)
    it.each<[string, string, object]>([
      [
        "without code",
        `INSERT INTO ${T} (id, description) VALUES ($1, 'xx') RETURNING code`,
        {
          code: "23514",
          message: `new row for relation "${LANGUAGES_TABLE}" violates check constraint "${LANGUAGES_TABLE}_code_check"`,
        },
      ],
      [
        "with an explicit NULL code",
        `INSERT INTO ${T} (id, code, description) VALUES ($1, NULL, 'xx') RETURNING code`,
        {
          code: "23514",
          message: `new row for relation "${LANGUAGES_TABLE}" violates check constraint "${LANGUAGES_TABLE}_code_check"`,
        },
      ],
      [
        "with a valid code",
        `INSERT INTO ${T} (id, code, description) VALUES ($1, 'pl', 'pl') RETURNING code`,
        { rows: [{ code: "pl" }] },
      ],
    ])("an insert %s by a user with create", async (_, sql, outcome) => {
      const fresh = randomUUID()
      expect(
        await commandAs(
          tx.client(),
          claimsFor("user", id("s1")),
          { action: "create", object: LANGUAGES_TABLE, root: fresh },
          sql,
          { params: [fresh] }
        )
      ).toMatchObject(outcome)
    })
  })

  describe("7: who sees which languages", () => {
    const CODES = `SELECT coalesce(array_agg(code ORDER BY code), '{}') AS v FROM ${T}`
    const codes = (result: { rows: { v: string[] }[] } | { code: string }) =>
      "rows" in result ? result.rows[0]!.v : result

    it("the guest sees only published rows through the four columns", async () => {
      const guest = (sql: string) =>
        queryAs(tx.client(), "anonymous", claimsFor("anonymous"), sql)
      const visible = await guest(
        `SELECT id, state, code, description FROM ${T} ORDER BY code`
      )
      expect("rows" in visible ? visible.rows : visible).toEqual([
        { id: id("en"), state: "published", code: "en", description: "en" },
        { id: id("uk"), state: "published", code: "uk", description: "uk" },
      ])
      expect(await guest(`SELECT version FROM ${T}`)).toEqual({ code: "42501" })
    })

    it("the guest has SELECT only on the four columns, not on the table", async () => {
      const guestRole = testRoleFor("anonymous")!
      const { rows } = await tx.client().query<{ column: string }>(
        `SELECT c.column_name AS column FROM information_schema.columns c
          WHERE c.table_schema = 'public' AND c.table_name = $2
            AND has_column_privilege($1, '${T}', c.column_name, 'SELECT')
          ORDER BY 1`,
        [guestRole, LANGUAGES_TABLE]
      )
      expect(rows.map((r) => r.column)).toEqual([
        "code",
        "description",
        "id",
        "state",
      ])
    })

    it.each([
      [
        "a user without rights on languages sees only published rows",
        "u0",
        ["en", "uk"],
      ],
      ["a user with read sees every row", "s1", ["de", "en", "fr", "uk"]],
    ])("%s", async (_, user, expected) => {
      expect(
        codes(
          await queryAs<{ v: string[] }>(
            tx.client(),
            "user",
            claimsFor("user", id(user)),
            CODES
          )
        )
      ).toEqual(expected)
    })

    it("the command role on behalf of a user without rights sees only published rows", async () => {
      const result = await commandAs<{ v: string[] }>(
        tx.client(),
        claimsFor("user", id("u0")),
        undefined,
        CODES
      )
      expect("rows" in result ? result.rows[0]!.v : result).toEqual([
        "en",
        "uk",
      ])
    })
  })
})
