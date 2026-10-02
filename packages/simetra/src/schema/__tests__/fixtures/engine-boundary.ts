import { parseId, type StableId } from "@supabase/pg-delta"
import type { EngineAction, EngineScope } from "simetra/schema"
import { SUPABASE_SCHEMAS } from "../../engine/provider/supabase"

/** Схема ідентичності: власна або цілі сателіта; без схеми — `undefined`. */
function schemaOf(id: StableId): string | undefined {
  if (id.kind === "schema") return id.name
  if ("target" in id) return schemaOf(id.target)
  if ("schema" in id) return id.schema ?? undefined
  return undefined
}

/** Вид ідентичності, яку змінює сателіт (ACL, коментар), — вид його цілі. */
function subjectKind(id: StableId): string {
  return "target" in id ? subjectKind(id.target) : id.kind
}

/** Об'єкти застосунку, які §6.9 дозволяє в схемах провайдера. */
const FOREIGN_APP_KINDS = new Set(["trigger", "policy", "publicationRel"])

/**
 * Порушення межі §6.9 за структурованими цілями дії, а не за текстом SQL:
 * жодна ціль не лежить у некерованій схемі поза пресетом провайдера; у схемі
 * провайдера дія створює чи видаляє лише об'єкт застосунку; дія без власних
 * `produces`/`destroys` (GRANT, `ENABLE RLS`) діє на те, що споживає, тож усе
 * споживане зі схемою — у керованих схемах.
 */
export function boundaryViolations(
  actions: readonly EngineAction[],
  scope: EngineScope
): string[] {
  const managed = new Set(scope.schemas)
  const provider = new Set(SUPABASE_SCHEMAS)
  const out: string[] = []
  for (const action of actions) {
    const own = [...action.produces, ...action.destroys]
    for (const encoded of [...own, ...action.consumes]) {
      const schema = schemaOf(parseId(encoded))
      if (schema !== undefined && !managed.has(schema) && !provider.has(schema))
        out.push(`${encoded} in unmanaged schema: ${action.sql}`)
    }
    for (const encoded of own) {
      const id = parseId(encoded)
      const schema = schemaOf(id)
      if (
        schema !== undefined &&
        !managed.has(schema) &&
        !FOREIGN_APP_KINDS.has(subjectKind(id))
      )
        out.push(`${encoded} is a provider internal: ${action.sql}`)
    }
    if (own.length === 0)
      for (const encoded of action.consumes) {
        const schema = schemaOf(parseId(encoded))
        if (schema !== undefined && !managed.has(schema))
          out.push(
            `${encoded} is acted on outside managed schemas: ${action.sql}`
          )
      }
  }
  return out
}
