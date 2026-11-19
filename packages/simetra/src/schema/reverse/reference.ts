import type { CatalogModel } from "simetra/model"
import { desiredForApply } from "../apply/desired"
import type { ApplyDatabase } from "../apply/port"
import { readShadowEnvironment } from "../apply/shadow-environment"
import type { EngineDiagnostic, SchemaEngine, ShadowOptions } from "../engine"
import { keptModel } from "./generate"

export interface FolderReference {
  /** Каталог тіні з бажаним станом теки; `undefined` — теки немає чи тінь не вдалася. */
  catalog: CatalogModel | undefined
  /** Відмова середовища чи збій тіні: без них тиша сховала б, чому еталона немає. */
  diagnostics: EngineDiagnostic[]
}

/**
 * Еталон наявної теки для `reverseGenerate` (`reference`) у формі каталогу:
 * бажаний стан теки, що компілюється, — той самий, що в `diff` і
 * застосування, — завантажується в одну тінь поруч із ціллю, і тінь
 * читається тим самим extract у межі теки. Тож згенеровані одиниці теки
 * порівнюються з каталогом цілі каталогом, без другого словника форм.
 * Середовище тіні (функції зовнішніх тригерів провайдера) читається з цілі,
 * як у `diff`. Тека без файлів поза генератором чи така, що не
 * компілюється, еталона не дає й тіні не будує.
 */
export async function folderReference(
  engine: SchemaEngine,
  reader: ApplyDatabase,
  o: Omit<ShadowOptions, "environment">,
  existing: ReadonlyMap<string, string>
): Promise<FolderReference> {
  const kept = await keptModel(existing)
  if (kept === undefined) return { catalog: undefined, diagnostics: [] }
  const desired = await desiredForApply(kept)
  const seeds = await reader.transaction(o.target, "rollback", (tx) =>
    readShadowEnvironment(tx, desired.scope)
  )
  if (!seeds.ok) return { catalog: undefined, diagnostics: seeds.diagnostics }
  const outcome = await engine.withDesiredShadow(
    { ...o, environment: seeds.statements },
    desired.sql,
    desired.scope,
    (shadow) => engine.extract(shadow, desired.scope)
  )
  if (outcome.status === "shadow-failed")
    return { catalog: undefined, diagnostics: outcome.diagnostics }
  return { catalog: outcome.value.model, diagnostics: [] }
}
