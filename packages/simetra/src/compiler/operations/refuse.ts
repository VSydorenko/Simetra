import { compile, type CompiledModel, type CompileResult } from "../compile"
import {
  diagnostic,
  newRepairErrors,
  repairKeys,
  sortDiagnostics,
  toPointer,
  type Diagnostic,
  type RepairKey,
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
  root: string | readonly string[]
): OperationResult | undefined {
  // Корінь-шлях — для значення глибоко у вході (`columns/<колонка>/element`):
  // ключ запису там — ім'я колонки, і колонка `id` не є id.
  const path = findId(value, typeof root === "string" ? [root] : [...root])
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
 * Мутація вимагає чистої компіляції входу: адресація й
 * каскади спираються на індекс чистої моделі, а напівмоделі компілятор не
 * віддає. Відмова несе діагностику входу — вона й пояснює, що лагодити.
 * З `repair` вхід з помилками лише класу ремонту приймається (спека
 * декларацій функцій §5.1); `accepted` — їхні ключі, з якими хвіст мутації
 * звіряє результат (`acceptsRepair`). Чистий вхід дає порожні `accepted`.
 */
export async function compileInput(
  files: ReadonlyMap<string, string>,
  options: { repair?: true } = {}
): Promise<
  | { ok: true; model: CompiledModel; accepted: RepairKey[] }
  | { ok: false; result: OperationResult }
> {
  const compiled = await compile(files, options)
  if (compiled.model !== undefined) {
    return {
      ok: true,
      model: compiled.model,
      accepted: repairKeys(compiled.diagnostics),
    }
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
 * Правило прийому мутації в режимі `repair` (§5.1): результат пишеться, якщо
 * модель є (поза класом помилок немає) і жодна помилка класу не нова відносно
 * входу — за кортежем ключа, а не за кількістю. `allow` — єдиний виняток
 * операції (`declare-function`: перехід самої цілі в `check-not-applied` з
 * причиною, яку `fix` гарантовано виправить): нова помилка, яку він
 * прийняв, не відмовляє.
 */
export function acceptsRepair(
  accepted: readonly RepairKey[],
  compiled: CompileResult,
  allow: (d: Diagnostic) => boolean = () => false
): boolean {
  return (
    compiled.model !== undefined &&
    newRepairErrors(accepted, compiled.diagnostics).every(allow)
  )
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
