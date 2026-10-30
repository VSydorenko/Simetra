import type { CompiledModel } from "simetra/compiler"
import { PLATFORM_SCHEMA } from "simetra/model"
import { engineScope, type EngineDiagnostic, type EngineScope } from "../engine"
import { renderDesiredState } from "../render"
import { renderApplyState } from "./state"

/** Бажаний стан застосування: SQL, межа й діагностики межі. */
export interface ApplyDesired {
  sql: string
  scope: EngineScope
  diagnostics: EngineDiagnostic[]
}

/**
 * Бажаний стан, який бачать і звірка, і застосування (спека користувачів §3):
 * рендер моделі плюс стан застосування, а схема `simetra` — у межі завжди.
 * Одна функція на обох, щоб `diff` і `apply` не розійшлися в тому, що
 * вважають бажаним.
 */
export async function desiredForApply(
  model: CompiledModel
): Promise<ApplyDesired> {
  const { scope, diagnostics } = await engineScope(model)
  return {
    sql: `${renderDesiredState(model).sql}\n\n${renderApplyState(model)}`,
    scope: {
      ...scope,
      schemas: [...new Set([...scope.schemas, PLATFORM_SCHEMA])].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0
      ),
    },
    diagnostics,
  }
}
