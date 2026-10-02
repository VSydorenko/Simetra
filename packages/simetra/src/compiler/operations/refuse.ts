import { compile, type CompiledModel } from "../compile"
import {
  diagnostic,
  sortDiagnostics,
  toPointer,
  type Diagnostic,
} from "../diagnostics"
import { withRanges } from "../locate"
import { changesBetween } from "./changes"
import type { OperationResult } from "./types"

/**
 * Відмова операції: нічого не змінено, обгортці писати нічого. Діапазони
 * рахуються по вхідних файлах, як для діагностик компілятора: без них
 * кожне місце відмови (наприклад, кожне посилання, що блокує видалення)
 * друкувалося б як початок файлу. Діагностика без файлу лишається без
 * діапазону — позиції в неї немає.
 */
export function refused(
  files: ReadonlyMap<string, string>,
  diagnostics: Diagnostic[]
): OperationResult {
  return {
    ok: false,
    changes: [],
    diagnostics: sortDiagnostics(withRanges(diagnostics, files)),
  }
}

/**
 * Відмова, якщо вхідні дані нового об'єкта чи елемента несуть `id` на будь-якій
 * глибині. Id видає лише `newId` операції: переданий ззовні id видаленого
 * елемента компіляція не відрізнила б від нового, і правило «id ніколи не
 * перевикористовується» (Р4) тихо порушилось би. Кожен ключ `id` у схемах
 * метаданих — ідентичність, тож інших значень у цього ключа немає.
 */
export function refuseSuppliedId(
  files: ReadonlyMap<string, string>,
  value: unknown,
  root: string
): OperationResult | undefined {
  const path = findId(value, [root])
  return path === undefined
    ? undefined
    : refused(files, [
        diagnostic("operation.input-invalid", "", "", { at: toPointer(path) }),
      ])
}

function findId(value: unknown, path: string[]): string[] | undefined {
  if (typeof value !== "object" || value === null) return undefined
  for (const [key, item] of Object.entries(value)) {
    if (key === "id" && !Array.isArray(value)) return [...path, key]
    const found = findId(item, [...path, key])
    if (found !== undefined) return found
  }
  return undefined
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
    result: refused(files, [
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
