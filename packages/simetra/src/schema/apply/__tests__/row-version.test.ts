import { describe, expect, it } from "vitest"
import { rowVersionSeedBlock } from "../row-version"

const TABLES = ["public.a", "public.b"]

describe("rowVersionSeedBlock", () => {
  it("fresh: locks every table and the sequence first, then rescans and sets upward only", () => {
    const sql = rowVersionSeedBlock(TABLES, "fresh")
    const at = (s: string) => sql.indexOf(s)
    expect(at("LOCK TABLE public.a IN SHARE MODE;")).toBeGreaterThan(-1)
    expect(at("LOCK TABLE public.b IN SHARE MODE;")).toBeGreaterThan(-1)
    expect(at("ALTER SEQUENCE simetra.row_version NO CYCLE;")).toBeGreaterThan(
      at("LOCK TABLE public.b")
    )
    // Єдине сканування, і воно під замками
    expect(sql.match(/INTO v_max/g)).toHaveLength(1)
    expect(at("INTO v_max")).toBeGreaterThan(at("ALTER SEQUENCE"))
    expect(at("setval(")).toBeGreaterThan(at("INTO v_max"))
    // `setval` лише під умовою «максимум не нижче наступного значення»
    expect(sql).toMatch(/IF v_max >= v_next THEN\n\s+PERFORM setval\(/)
  })

  it("entering: checks without a lock first, locks only when the check says so", () => {
    const sql = rowVersionSeedBlock(TABLES, "entering")
    const scans = [...sql.matchAll(/INTO v_max/g)].map((m) => m.index!)
    expect(scans).toHaveLength(2)
    const lock = sql.indexOf("LOCK TABLE")
    // без замка → замок → повторно → setval
    expect(scans[0]).toBeLessThan(lock)
    expect(lock).toBeLessThan(sql.indexOf("ALTER SEQUENCE"))
    expect(sql.indexOf("ALTER SEQUENCE")).toBeLessThan(scans[1]!)
    expect(scans[1]).toBeLessThan(sql.indexOf("setval("))
    expect(sql.slice(scans[0], lock)).toContain("IF v_max >= v_next THEN")
    expect(sql).toContain(
      "CASE WHEN is_called THEN last_value + 1 ELSE last_value END"
    )
  })

  it("has nothing to seed without mechanics tables, but still runs the trailing statements", () => {
    const sql = rowVersionSeedBlock([], "entering", ["PERFORM 1;"])
    expect(sql).not.toContain("LOCK TABLE")
    expect(sql).not.toContain("setval")
    expect(sql).toContain("PERFORM 1;")
  })
})
