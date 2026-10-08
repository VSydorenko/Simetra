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
 * Межі числа й формат рядка на справжньому Postgres: головне — що вирази, які
 * схема пропускає (`pattern` проходить `new RegExp`), розгортаються в CHECK, а
 * порушник дає `check_violation`, тоді як `NULL` проходить.
 */

async function deploy(client: pg.Client) {
  const result = await compile(
    metaFiles({
      "project.meta.json": project(),
      "catalogs/Item/Item.meta.json": catalog("Item", {
        attributes: [
          attribute("sku", {
            type: "String",
            length: 20,
            pattern: "^[A-Z]{2,}\\d*$",
            minLength: 3,
          }),
          attribute("qty", {
            type: "Numeric",
            precision: 10,
            scale: 2,
            nonNegative: true,
            maxValue: "1000.50",
          }),
          attribute("rank", {
            type: "Integer",
            positive: true,
            minValue: 2,
            maxValue: 9,
          }),
          // Конструкції, спільні для JS і ARE: перегляд уперед і назад,
          // класи, лічильники, не жадібні квантори.
          attribute("tag", {
            type: "Text",
            pattern: "^(?=[a-z])[a-z0-9_-]+?(?<!_)$",
          }),
          attribute("memo", { type: "Text", pattern: "^it's [\\w.]+$" }),
        ],
      }),
    })
  )
  expect(result.diagnostics).toEqual([])
  await client.query(renderDesiredState(result.model!).sql)
  return result.model!
}

/** Вставка у власній точці збереження: код помилки Postgres або `ok`. */
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

const insert = (column: string, literal: string) =>
  `INSERT INTO public.item (id, ${column}) VALUES (gen_random_uuid(), ${literal})`

describe("value checks in Postgres", () => {
  it("deploys and the catalog matches the snapshot", async () => {
    await withRollback(async (client) => {
      const model = await deploy(client)
      expectCatalogMatchesSnapshot(
        await readCatalog(client, ["public"]),
        model.physical
      )
    })
  })

  it("format: a violating row gives check_violation, NULL passes", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      expect(await attempt(client, insert("sku", "'AB1'"))).toBe("ok")
      expect(await attempt(client, insert("sku", "'ABC'"))).toBe("ok")
      // Шаблон не збігається / коротше за minLength / нижній регістр.
      expect(await attempt(client, insert("sku", "'ab1'"))).toBe("23514")
      expect(await attempt(client, insert("sku", "'A1'"))).toBe("23514")
      expect(await attempt(client, insert("sku", "'AB1x'"))).toBe("23514")
      expect(await attempt(client, insert("sku", "NULL"))).toBe("ok")
    })
  })

  it("format: lookaround and an apostrophe in the pattern deploy", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      expect(await attempt(client, insert("tag", "'a-b_c1'"))).toBe("ok")
      expect(await attempt(client, insert("tag", "'1abc'"))).toBe("23514")
      expect(await attempt(client, insert("tag", "'abc_'"))).toBe("23514")
      expect(await attempt(client, insert("memo", "'it''s a.b'"))).toBe("ok")
      expect(await attempt(client, insert("memo", "'its a.b'"))).toBe("23514")
    })
  })

  it("bounds: a violating row gives check_violation, NULL passes", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      expect(await attempt(client, insert("qty", "1000.50"))).toBe("ok")
      expect(await attempt(client, insert("qty", "0"))).toBe("ok")
      expect(await attempt(client, insert("qty", "-0.01"))).toBe("23514")
      expect(await attempt(client, insert("qty", "1000.51"))).toBe("23514")
      expect(await attempt(client, insert("rank", "2"))).toBe("ok")
      expect(await attempt(client, insert("rank", "9"))).toBe("ok")
      expect(await attempt(client, insert("rank", "1"))).toBe("23514")
      expect(await attempt(client, insert("rank", "10"))).toBe("23514")
      expect(await attempt(client, insert("rank", "NULL"))).toBe("ok")
    })
  })
})
