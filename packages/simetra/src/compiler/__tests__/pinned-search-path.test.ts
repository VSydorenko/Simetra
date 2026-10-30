import { beforeAll, describe, expect, it } from "vitest"
import { compile } from "../compile"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { assertPinnedSearchPath } from "../sql/pinned-search-path"
import { generatedUnit, type SqlUnit } from "../sql/units"
import { kitchenSink } from "./fixtures/kitchen-sink"
import { readReferenceDomain } from "./fixtures/reference-domain"
import {
  adminRoles,
  authorCarrier,
  policyDomain,
  singleTenantRights,
  writeRoles,
} from "./fixtures/rights"
import { snakeCaseTwin } from "./fixtures/snake-case"

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const fn = (options: string) =>
  `CREATE FUNCTION public.f() RETURNS int LANGUAGE sql STABLE ${options} AS $$ SELECT 1 $$;`

/** Одиниця з тексту; `generated: false` — SQL застосунку. */
function unit(sql: string, generated = true): SqlUnit {
  return {
    ...generatedUnit(sql, "public", parse),
    module: "app",
    ...(generated ? { generator: "rights" as const } : { file: "sql/f.sql" }),
  }
}

describe("assertPinnedSearchPath", () => {
  it("accepts a generated function with SET search_path = ''", () => {
    expect(() =>
      assertPinnedSearchPath([unit(fn("SET search_path = ''"))])
    ).not.toThrow()
  })

  it.each([
    ["no SET search_path", ""],
    ["a non-empty search_path", "SET search_path = public"],
    ["RESET ALL after the empty path", "SET search_path = '' RESET ALL"],
  ])("rejects a generated function with %s", (_, options) => {
    expect(() => assertPinnedSearchPath([unit(fn(options))])).toThrow(
      /^internal: generated function function:public\.f\(\) without SET search_path = ''$/
    )
  })

  it.each([
    "ALTER FUNCTION public.f() SET search_path = public",
    "ALTER FUNCTION public.f() RESET search_path",
    "ALTER FUNCTION public.f() RESET ALL",
  ])("rejects a generated %s", (alter) => {
    // Сам `ALTER`, без своєї функції серед одиниць: правило не залежить від
    // того, чию функцію він змінює.
    expect(() => assertPinnedSearchPath([unit(`${alter};`)])).toThrow(
      /^internal: generated .* changes search_path of a function$/
    )
    // Поруч зі своєю функцією — її ефективний шлях уже не порожній.
    expect(() =>
      assertPinnedSearchPath([
        unit(fn("SET search_path = ''")),
        unit(`${alter};`),
      ])
    ).toThrow(/^internal: /)
  })

  // Судження SQL застосунку — гейт закритих форм, з діагностикою.
  it("leaves application SQL to the closed-forms gate", () => {
    expect(() =>
      assertPinnedSearchPath([
        unit(fn(""), false),
        unit("ALTER FUNCTION public.f() RESET ALL;", false),
      ])
    ).not.toThrow()
  })
})

/**
 * Кожне наявне місце рендеру функції на цих проєктах проходить інваріант:
 * компіляція кидала б `internal:`, а не давала б модель.
 */
describe("generated functions of real projects keep search_path pinned", () => {
  const rights = () => policyDomain(writeRoles(), adminRoles())
  const authors = () =>
    singleTenantRights({ ...authorCarrier(), ...authorCarrier("long") })
  it.each([
    ["kitchen sink", kitchenSink],
    ["policy domain", rights],
    ["policy domain, snake_case", () => snakeCaseTwin(rights())],
    ["author carriers", authors],
    ["author carriers, snake_case", () => snakeCaseTwin(authors())],
    ["examples/reference", readReferenceDomain],
  ])("%s", async (_, files) => {
    const result = await compile(files())
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(
      result.model!.sqlUnits.some(
        (u) => u.generator !== undefined && u.class === "function"
      )
    ).toBe(true)
  })
})
