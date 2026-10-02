import {
  flattenPolicy,
  supabasePolicy,
  type Policy,
  type Predicate,
} from "@supabase/pg-delta"
import { describe, expect, it } from "vitest"
import { SUPABASE_EXTENSIONS, SUPABASE_SCHEMAS } from "simetra/schema"
import { scopePolicy } from "../pg-delta/policy"

/**
 * Контракт нейтрального пресету провайдера з закріпленою версією двигуна:
 * перепис і межа моделі читають пресет, а двигун — свою політику, тож
 * розбіжність переліків дала б вічний `engine.census-mismatch` або тихо
 * некерований об'єкт.
 */

const list = (value: string | string[]) =>
  Array.isArray(value) ? value : [value]

/** Розширення, які політика виключає правилом «вид extension + імена». */
function excludedExtensions(policy: Policy): Set<string> {
  const names = (match: Predicate): string[] => {
    if (!("all" in match)) return []
    const isExtension = match.all.some(
      (m) => "kind" in m && list(m.kind).includes("extension")
    )
    return isExtension
      ? match.all.flatMap((m) => ("name" in m ? list(m.name) : []))
      : []
  }
  return new Set(
    flattenPolicy(policy).filter.flatMap((rule) =>
      rule.action === "exclude" ? names(rule.match) : []
    )
  )
}

describe("provider preset matches the pinned engine", () => {
  it("provider schemas are the engine's assumed schemas", () => {
    expect(new Set(SUPABASE_SCHEMAS)).toEqual(
      new Set(flattenPolicy(supabasePolicy).assumedSchemas)
    )
  })

  it("the census and the engine exclude the same provider extensions", () => {
    // Двигун виключає об'єднання правила межі (перелік пресету) і правила
    // свого пресету; перепис — лише перелік пресету
    const scope = { schemas: ["app"], provider: "supabase" } as const
    expect(excludedExtensions(scopePolicy(scope))).toEqual(
      new Set(SUPABASE_EXTENSIONS)
    )
    for (const name of excludedExtensions(supabasePolicy))
      expect(SUPABASE_EXTENSIONS, `engine preset excludes ${name}`).toContain(
        name
      )
  })
})
