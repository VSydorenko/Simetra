import { describe, expect, it } from "vitest"
import type pg from "pg"
import { compile } from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
import {
  catalog,
  metaFiles,
  project,
} from "../../src/compiler/__tests__/helpers"
import { withRollback } from "./connection"

/**
 * Механіка рядка на справжньому Postgres (спека промоції §9.2): `version` і
 * `updated_at` тримає тригер, а не клієнт. Під `postgres`: гранти таблиць
 * виду (план П3-3a1) закривають DML ролям API, а механіці роль байдужа —
 * тригер спрацьовує в будь-якій ролі, що пише.
 */

async function deploy(client: pg.Client): Promise<void> {
  const result = await compile(
    metaFiles({
      "project.meta.json": project(),
      "catalogs/Item/Item.meta.json": catalog("Item"),
    })
  )
  expect(result.diagnostics).toEqual([])
  await client.query(renderDesiredState(result.model!).sql)
}

interface Row {
  version: string
  touched: boolean
}

// `now()` у межах транзакції сталий, тож рівність з ним — це «дав тригер».
const ROW = "version, updated_at = now() AS touched"

describe("row mechanics in Postgres", () => {
  it("a client cannot write version or updated_at: the trigger does", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const inserted = await client.query<Row & { id: string }>(
        `INSERT INTO public.item (id, description) VALUES (gen_random_uuid(), 'a') RETURNING id, ${ROW}`
      )
      const id = inserted.rows[0]!.id
      expect(inserted.rows[0]).toMatchObject({ version: "1", touched: true })

      const first = await client.query<Row>(
        `UPDATE public.item SET description = 'x', version = 100, updated_at = '2000-01-01' WHERE id = $1 RETURNING ${ROW}`,
        [id]
      )
      expect(first.rows).toEqual([{ version: "2", touched: true }])

      const second = await client.query<Row>(
        `UPDATE public.item SET description = 'y' WHERE id = $1 RETURNING ${ROW}`,
        [id]
      )
      expect(second.rows).toEqual([{ version: "3", touched: true }])

      // Спроба скинути версію — та сама механіка: OLD.version + 1
      const reset = await client.query<Row>(
        `UPDATE public.item SET version = 0 WHERE id = $1 RETURNING ${ROW}`,
        [id]
      )
      expect(reset.rows).toEqual([{ version: "4", touched: true }])
    })
  })

  it("an insert starts at version 1 whatever the client writes", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const inserted = await client.query<Row>(
        `INSERT INTO public.item (id, description, version, updated_at) VALUES (gen_random_uuid(), 'a', 999, '2000-01-01') RETURNING ${ROW}`
      )
      expect(inserted.rows).toEqual([{ version: "1", touched: true }])
    })
  })
})
