import { compile, type CompiledModel } from "../compile"
import { diagnostic, sortDiagnostics, type Diagnostic } from "../diagnostics"
import { changesBetween } from "./changes"
import type { OperationResult } from "./types"

/** Відмова операції: нічого не змінено, обгортці писати нічого. */
export function refused(diagnostics: Diagnostic[]): OperationResult {
  return { ok: false, changes: [], diagnostics: sortDiagnostics(diagnostics) }
}

/**
 * Мутація вимагає чистої компіляції входу (рішення плану 2): адресація й
 * каскади спираються на індекс чистої моделі, а напівмоделі компілятор не
 * віддає. Відмова несе діагностику входу — вона й пояснює, що лагодити.
 */
export async function compileInput(
  files: ReadonlyMap<string, string>
): Promise<
  { ok: true; model: CompiledModel } | { ok: false; result: OperationResult }
> {
  const compiled = await compile(files)
  if (compiled.ok && compiled.model !== undefined) {
    return { ok: true, model: compiled.model }
  }
  return {
    ok: false,
    result: refused([
      diagnostic("operation.input-invalid", "", ""),
      ...compiled.diagnostics,
    ]),
  }
}

/**
 * Хвіст мутації без доповнення: компіляція результату й перелік змін
 * відносно входу. `ok` — результат без помилок; лише тоді обгортка пише.
 */
export async function compileResult(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>
): Promise<OperationResult> {
  const compiled = await compile(after)
  return {
    ok: compiled.ok,
    changes: changesBetween(before, after),
    diagnostics: sortDiagnostics(compiled.diagnostics),
  }
}
