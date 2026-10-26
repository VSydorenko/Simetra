import pg from "pg"
import { describe, expect, it } from "vitest"
import { applyChanges, promoteObject } from "simetra/compiler"
import {
  COUNTERPARTY_SQL,
  SHARED_SQL,
  counterpartyMapping,
  promotionProject,
} from "../../src/compiler/__tests__/fixtures/promotion"
import { acceptDebt, uuid } from "../../src/compiler/__tests__/helpers"
import { testSuperuserUrl, withRollback } from "./connection"

/**
 * Переписані промоцією тіла функцій проти живого Postgres: на схемі після
 * перейменувань із запису вони проходять `plpgsql_check` і зберігають форму
 * результату, а вихідні — ні. Без негативного контролю зелений тест не
 * відрізнив би переписування від схеми, яку перейменування не зачепили.
 */

// Прийнята таблиця фікстури (`Counterparty.meta.json`) — у фізичних іменах до промоції
const ADOPTED_TABLE = `
CREATE SCHEMA app;
CREATE TABLE app.counterparties (
  id uuid NOT NULL,
  name text NOT NULL,
  inn text,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT counterparties_pkey PRIMARY KEY (id),
  CONSTRAINT counterparties_inn_key UNIQUE (inn)
);
ALTER TABLE app.counterparties ENABLE ROW LEVEL SECURITY;
`

const TOUCH = "app.counterparty_touch()"
const NAMES = "app.counterparty_names()"

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`

/** Повідомлення рівня `error` від `plpgsql_check` для функції на таблиці тригера. */
async function checkErrors(
  db: pg.Client,
  fn: string,
  relid: string
): Promise<string[]> {
  const { rows } = await db.query<{ message: string }>(
    `SELECT message FROM plpgsql_check_function_tb($1::regprocedure, $2::regclass)
     WHERE level = 'error'`,
    [fn, relid]
  )
  return rows.map((r) => r.message)
}

/** Помилка запиту в точці збереження: транзакція тесту лишається живою. */
async function failure(db: pg.Client, sql: string): Promise<string> {
  await db.query("SAVEPOINT probe")
  try {
    await db.query(sql)
    return "no error"
  } catch (error) {
    return (error as Error).message
  } finally {
    await db.query("ROLLBACK TO SAVEPOINT probe")
  }
}

// Файл функції створює її; на базі, де вона вже є, П3 її замінює
const replacing = (text: string) =>
  text.replaceAll(/CREATE FUNCTION/g, "CREATE OR REPLACE FUNCTION")

async function promoted() {
  const files = await acceptDebt(promotionProject())
  let n = 960_000
  const result = await promoteObject(files, counterpartyMapping(), {
    schemaPath: (file, schemaFile) => `schemas-of/${file}/${schemaFile}`,
    newId: () => uuid(++n),
  })
  // Контакти лишаються CustomTable, тож їхній каскад на промотований об'єкт
  // промоція переводить у restrict із попередженням (Р2c1-34).
  expect(result.diagnostics.map((d) => [d.code, d.params])).toEqual([
    [
      "promote.cascade-to-restrict",
      expect.objectContaining({
        table: "app.counterparty_contacts",
        foreignKey: "counterparty_contacts_counterparty_id_fkey",
        action: "cascade",
      }),
    ],
  ])
  expect(result.record).toBeDefined()
  return {
    before: files,
    after: applyChanges(files, result.changes),
    record: result.record!,
  }
}

describe("promote: rewritten function bodies on the renamed schema", () => {
  it("rewritten bodies pass plpgsql_check and keep result shapes", async () => {
    const { before, after, record } = await promoted()
    expect(record.tables).toEqual([
      expect.objectContaining({ from: "counterparties", to: "counterparty" }),
    ])
    expect(record.rewrittenUnits.map((u) => u.identity).sort()).toEqual([
      `function:${NAMES}`,
      `function:${TOUCH}`,
    ])

    // `CREATE EXTENSION plpgsql_check` роль застосунку не виконає.
    await withRollback(async (db) => {
      // 1. Прийнята схема: таблиця, вихідні функції, тригер — з файлів фікстури
      await db.query(ADOPTED_TABLE)
      await db.query(before.get(COUNTERPARTY_SQL)!)
      await db.query(before.get(SHARED_SQL)!)
      await db.query(
        "INSERT INTO app.counterparties (id, name, inn) VALUES (gen_random_uuid(), 'Acme', 'X1')"
      )

      // 2.
      await db.query("CREATE EXTENSION plpgsql_check")

      // 3. Перейменування з запису: колонки називають нову таблицю
      for (const t of record.tables) {
        await db.query(
          `ALTER TABLE ${ident(t.schema)}.${ident(t.from)} RENAME TO ${ident(t.to)}`
        )
      }
      for (const c of record.columns) {
        if (c.from === c.to) continue
        await db.query(
          `ALTER TABLE ${ident(c.schema)}.${ident(c.table)} RENAME COLUMN ${ident(c.from)} TO ${ident(c.to)}`
        )
      }

      // 4. Негативний контроль: вихідні тіла на перейменованій схемі ламаються
      expect(await checkErrors(db, TOUCH, "app.counterparty")).toEqual([
        'record "new" has no field "name"',
      ])
      await db.query("SET LOCAL check_function_bodies = on")
      expect(await failure(db, replacing(before.get(SHARED_SQL)!))).toMatch(
        /app\.counterparties.*does not exist/
      )

      // 5. Переписані функції з файлів після promote
      const rewritten = [
        ...new Set(record.rewrittenUnits.map((u) => u.file)),
      ].sort()
      for (const file of rewritten) {
        await db.query(replacing(after.get(file)!))
      }

      // 6. Без помилок, ті самі рядки, старі назви колонок результату
      expect(await checkErrors(db, TOUCH, "app.counterparty")).toEqual([])
      const names = await db.query(`SELECT * FROM ${NAMES}`)
      expect(names.fields.map((f) => f.name)).toEqual(["name", "inn"])
      expect(names.rows).toEqual([{ name: "Acme", inn: "X1" }])

      // 7. Тригер на перейменованій таблиці кличе переписане тіло
      const inserted = await db.query<{ description: string }>(
        `INSERT INTO app.counterparty (id, description, tax_id)
         VALUES (gen_random_uuid(), '  Globex  ', 'Y2')
         RETURNING description`
      )
      expect(inserted.rows).toEqual([{ description: "Globex" }])
    }, testSuperuserUrl())
  })
})
