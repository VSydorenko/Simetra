import { describe, expect, it } from "vitest"
import type pg from "pg"
import { compile } from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
import {
  attribute,
  catalog,
  metaFiles,
  project,
} from "../../src/compiler/__tests__/helpers"
import { readCatalog } from "./catalog"
import { expectCatalogMatchesSnapshot } from "./compare"
import { withRollback } from "./connection"

/**
 * Правило рядка модуля виду на справжньому Postgres: канонічний текст
 * компілятора розгортається як CHECK таблиці з тим самим ім'ям, а порушник
 * дає `check_violation`. Текст бази (`IN` — як `= ANY (ARRAY[…])`) звіряє
 * двигун у designer; тут — що обмеження живе й працює.
 */

const ROW_RULE_FILES = {
  "project.meta.json": project(),
  "catalogs/Party/Party.meta.json": catalog("Party", {
    attributes: [
      attribute("person", { type: "String", length: 20 }),
      attribute("company", { type: "String", length: 20 }),
      attribute("status", { type: "String", length: 10 }),
    ],
  }),
  "catalogs/Party/Party.sql":
    "ALTER TABLE public.party ADD CONSTRAINT party_one_side CHECK (num_nonnulls(person, company) <= 1 AND (status IN ('new', 'done') OR status IS NULL));",
}

async function deploy(client: pg.Client) {
  const result = await compile(metaFiles(ROW_RULE_FILES))
  expect(result.diagnostics).toEqual([])
  await client.query(renderDesiredState(result.model!).sql)
  return result.model!
}

async function attempt(client: pg.Client, sql: string): Promise<string> {
  await client.query("SAVEPOINT attempt")
  try {
    await client.query(sql)
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT attempt")
    return (error as { code: string }).code
  }
  await client.query("RELEASE SAVEPOINT attempt")
  return "ok"
}

const insert = (values: string) =>
  `INSERT INTO public.party (id, person, company, status) VALUES (gen_random_uuid(), ${values})`

describe("row rule in Postgres", () => {
  it("deploys as a table CHECK and the catalog matches the snapshot", async () => {
    await withRollback(async (client) => {
      const model = await deploy(client)
      const catalog = await readCatalog(client, ["public"])
      expectCatalogMatchesSnapshot(catalog, model.physical)
      const party = catalog.tables.find((t) => t.name === "party")!
      expect(
        party.constraints.find((c) => c.name === "party_one_side")?.definition
      ).toContain("num_nonnulls(person, company) <= 1")
    })
  })

  it("a violating row gives check_violation", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      expect(await attempt(client, insert("'p', NULL, 'new'"))).toBe("ok")
      expect(await attempt(client, insert("NULL, NULL, NULL"))).toBe("ok")
      expect(await attempt(client, insert("'p', 'c', NULL"))).toBe("23514")
      expect(await attempt(client, insert("'p', NULL, 'x'"))).toBe("23514")
    })
  })
})
