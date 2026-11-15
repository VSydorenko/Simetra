import { describe, expect, it } from "vitest"
import { catalogCoverageGaps } from "./fingerprint-coverage.support"

/**
 * Контракт покриття відбитка на стеку Supabase: постачальник міток безпеки
 * `pgsodium` є лише тут, тож мітка має екземпляр і жоден вид не застарілий.
 * Решта каталогу — `fingerprint-coverage.support.ts`.
 */

describe("fingerprint coverage of the engine model", () => {
  it("maps every engine property to a section or an exception", async () => {
    expect(
      await catalogCoverageGaps(
        "security label for pgsodium on column app.u.c is 'ENCRYPT WITH KEY ID 00000000-0000-0000-0000-000000000000';"
      )
    ).toEqual([])
  })
})
