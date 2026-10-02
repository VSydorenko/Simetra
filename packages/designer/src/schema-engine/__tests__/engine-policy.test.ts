import {
  flattenPolicy,
  supabasePolicy,
  type Policy,
  type Predicate,
} from "@supabase/pg-delta"
import { describe, expect, it } from "vitest"
import {
  SUPABASE_EXTENSIONS,
  SUPABASE_ROLES,
  SUPABASE_SCHEMAS,
  SUPABASE_SURFACES,
} from "simetra/schema"
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

/**
 * Поверхня політик пресету: таблиці (`schema` + glob таблиці) і цілі схеми з
 * правила `supabase.user-policy-surface`, у формі `схема.glob`.
 */
function policySurface(policy: Policy): Set<string> {
  const rule = flattenPolicy(policy).filter.find(
    (r) => r.audit?.reasonCode === "supabase.user-policy-surface"
  )
  if (rule === undefined || !("all" in rule.match)) return new Set()
  const surfaces = rule.match.all.flatMap((m) => ("any" in m ? m.any : []))
  return new Set(
    surfaces.map((s) => {
      if ("schema" in s) return `${list(s.schema).join()}.*`
      if (!("all" in s)) return "?"
      const schema = s.all.flatMap((m) => ("schema" in m ? list(m.schema) : []))
      const table = s.all.flatMap((m) =>
        "idField" in m && m.idField.field === "table"
          ? list(m.idField.glob)
          : []
      )
      return `${schema.join()}.${table.join()}`
    })
  )
}

/**
 * Схеми поверхні тригерів — правило включення тригерів пресету (Rule 3):
 * його схеми мінус схеми з виключенням таблиць (`not all [schema, idField]`,
 * черги `pgmq`), якого позитивний glob поверхні не виражає.
 */
function triggerSurfaceSchemas(policy: Policy): Set<string> {
  const rule = flattenPolicy(policy).filter.find(
    (r) =>
      r.action === "include" &&
      "all" in r.match &&
      r.match.all.some((m) => "kind" in m && list(m.kind).includes("trigger"))
  )
  if (rule === undefined || !("all" in rule.match)) return new Set()
  const schemas = rule.match.all.flatMap((m) =>
    "schema" in m ? list(m.schema) : []
  )
  const carved = rule.match.all.flatMap((m) =>
    "not" in m && "all" in m.not
      ? m.not.all.flatMap((n) => ("schema" in n ? list(n.schema) : []))
      : []
  )
  return new Set(schemas.filter((schema) => !carved.includes(schema)))
}

/** Ролі провайдера — правило «власник — системна роль». */
function ownerRoles(policy: Policy): Set<string> {
  return new Set(
    flattenPolicy(policy).filter.flatMap((rule) =>
      rule.action === "exclude" && "owner" in rule.match
        ? list(rule.match.owner)
        : []
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

  it("surfaces match the engine preset", () => {
    const policies = SUPABASE_SURFACES.filter((s) =>
      s.classes.includes("policy")
    ).map((s) => `${s.schema}.${s.table}`)
    expect(new Set(policies)).toEqual(policySurface(supabasePolicy))
    expect(policies.length).toBeGreaterThan(0)
  })

  it("trigger surface matches the engine preset", () => {
    const triggers = SUPABASE_SURFACES.filter((s) =>
      s.classes.includes("trigger")
    )
    for (const surface of triggers) expect(surface.table).toBe("*")
    expect(new Set(triggers.map((s) => s.schema))).toEqual(
      triggerSurfaceSchemas(supabasePolicy)
    )
    expect(triggers.length).toBeGreaterThan(0)
  })

  it("extension list is not empty", () => {
    // Порожній перелік робив би контракт вище тавтологічним
    expect(SUPABASE_EXTENSIONS).toContain("pg_graphql")
  })

  it("provider roles are the engine's system roles", () => {
    expect(new Set(SUPABASE_ROLES)).toEqual(ownerRoles(supabasePolicy))
    expect(SUPABASE_ROLES).toContain("authenticated")
  })
})
