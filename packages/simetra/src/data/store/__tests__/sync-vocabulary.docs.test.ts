import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { SITE_CODES, TEST_SITE } from "../sync/vocabulary"

/**
 * Додаток Б спеки ядра синхронізації — інвентар шляхів читання `main`; його
 * колонка «Код» і `SITE_CODES` — один перелік у двох місцях. Тест не дає їм
 * розійтися в жоден бік: код без рядка інвентаря чи рядок без коду в
 * словнику червоніють.
 */
describe("the codes of the read inventory", () => {
  const spec = readFileSync(
    resolve(
      __dirname,
      "../../../../../../docs/superpowers/specs/2026-11-23-t4-sync-kernel-design.md"
    ),
    "utf8"
  )
  const start = spec.indexOf("## Додаток Б.")
  // Таблиця інвентаря: рядки `| <код> | …`, де код — літера й номер.
  const documented = spec
    .slice(start)
    .split("\n")
    .flatMap((line) => {
      const m = /^\| ([A-Z]\d+) \|/.exec(line)
      return m === null ? [] : [m[1]!]
    })

  it("the table of Appendix Б is found", () => {
    expect(start).toBeGreaterThan(0)
    expect(documented.length).toBeGreaterThan(0)
  })

  it("every code of the vocabulary has a row in Appendix Б", () => {
    expect(SITE_CODES.filter((code) => !documented.includes(code))).toEqual([])
  })

  it("every row of Appendix Б has its code in the vocabulary", () => {
    const known: readonly string[] = SITE_CODES
    expect(documented.filter((code) => !known.includes(code))).toEqual([])
  })

  it("the codes of Appendix Б are unique", () => {
    expect(new Set(documented).size).toBe(documented.length)
  })

  it("the service code of the tests is not a row of the inventory", () => {
    const known: readonly string[] = SITE_CODES
    expect(known).not.toContain(TEST_SITE)
  })
})
