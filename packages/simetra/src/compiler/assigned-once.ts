import { ASSIGNED_ONCE, type AssignedOnceField } from "simetra/model"
import { diagnostic, sortDiagnostics, type Diagnostic } from "./diagnostics"
import {
  elementsAt,
  namedElementsOf,
  parseJson,
  readObjectFiles,
  type Json,
} from "./object-files"
import { PROJECT_FILE } from "./stages/files"

type Context = Parameters<NonNullable<AssignedOnceField["effective"]>>[1]

/** Носій полів, призначених раз: об'єкт чи іменований елемент у своєму файлі. */
interface Holder {
  file: string
  pointer: string
  element: Json
  ctx: Context
}

type Holders = Record<AssignedOnceField["on"], Map<string, Holder>>

const REMOVED = "(removed)"

/**
 * Носії за `id` в межах усього проєкту: елемент може переїхати в інший файл
 * (перейменування об'єкта), а ідентичність — це id, а не шлях. Повторний id
 * — помилка стадії 2, тож тут береться перший.
 */
function holdersOf(files: ReadonlyMap<string, string>): Holders {
  const project = files.has(PROJECT_FILE)
    ? parseJson(files.get(PROJECT_FILE)!)
    : undefined
  const defaultSchema =
    typeof project?.defaultSchema === "string"
      ? project.defaultSchema
      : "public"
  const holders: Holders = { object: new Map(), element: new Map() }
  const add = (on: AssignedOnceField["on"], holder: Holder) => {
    const id = holder.element.id
    if (typeof id === "string" && !holders[on].has(id)) {
      holders[on].set(id, holder)
    }
  }
  for (const file of readObjectFiles(files)) {
    const ctx = {
      defaultSchema,
      materializes: file.def.materializes !== "none",
    }
    add("object", { file: file.path, pointer: "", element: file.raw, ctx })
    // Корінь файлу — сам об'єкт: його поля тримають записи `on: "object"`.
    for (const at of namedElementsOf(file).filter((a) => a.pointer !== "")) {
      add("element", { file: file.path, ...at, ctx })
    }
  }
  if (project !== undefined) {
    // Вид скоупу матеріалізується колонкою в таблицях, що його несуть.
    const ctx = { defaultSchema, materializes: true }
    for (const at of elementsAt(project, "scopeKinds")) {
      add("element", { file: PROJECT_FILE, ...at, ctx })
    }
  }
  return holders
}

/** Ефективне значення — з `effective` запису, без розгалуження за полем. */
function valueOf(
  record: AssignedOnceField,
  holder: Holder
): string | undefined {
  const value =
    record.effective === undefined
      ? holder.element[record.field]
      : record.effective(holder.element, holder.ctx)
  return typeof value === "string" ? value : undefined
}

/**
 * Куди вказує зміна. Значення, якого немає в самому елементі, прийшло з
 * контексту — успадковане від проєкту, тож правити треба `defaultSchema`.
 */
function locationOf(
  record: AssignedOnceField,
  holder: Holder,
  after: string | undefined
): { file: string; pointer: string } {
  const inherited =
    after !== undefined && typeof holder.element[record.field] !== "string"
  return inherited
    ? { file: PROJECT_FILE, pointer: "/defaultSchema" }
    : { file: holder.file, pointer: `${holder.pointer}/${record.field}` }
}

/**
 * Поля, призначені раз (спека П2 §3, «Призначене раз — правило
 * компілятора»), проти базового стану. Перелік полів — лише `ASSIGNED_ONCE`
 * T0. Відсутність → значення не зміна: призначати — справа `fix`; значення →
 * відсутність — зміна, бо стерте ім'я `fix` дав би інше. Зламаний файл
 * пропускається: про нього звітує стадія 1.
 */
export function assignedOnceDiagnostics(
  baseline: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>
): Diagnostic[] {
  const before = holdersOf(baseline)
  const after = holdersOf(current)
  const result: Diagnostic[] = []
  for (const record of ASSIGNED_ONCE) {
    for (const [id, now] of after[record.on]) {
      const was = before[record.on].get(id)
      if (was === undefined) continue
      const old = valueOf(record, was)
      const value = valueOf(record, now)
      if (old === undefined || old === value) continue
      const at = locationOf(record, now, value)
      result.push(
        diagnostic("identity.assigned-once-changed", at.file, at.pointer, {
          field: record.field,
          before: old,
          after: value ?? REMOVED,
        })
      )
    }
  }
  return sortDiagnostics(result)
}
