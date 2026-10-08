import {
  ASSIGNED_ONCE,
  projectSchema,
  type AssignedOnceField,
} from "simetra/model"
import { diagnostic, type Diagnostic } from "./diagnostics"
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
  /**
   * Немає — проєкт мапи відсутній чи невалідний: `defaultSchema` невідома, і
   * ефективне значення, що від неї залежить, не обчислюється.
   */
  ctx?: Context
}

interface State {
  holders: Record<AssignedOnceField["on"], Map<string, Holder>>
  project?: Json
}

const REMOVED = "(removed)"

/**
 * Носії за `id` в межах усього проєкту: елемент може переїхати в інший файл
 * (перейменування об'єкта), а ідентичність — це id, а не шлях. Повторний id
 * — помилка стадії 2, тож тут береться перший.
 */
function stateOf(files: ReadonlyMap<string, string>): State {
  const project = files.has(PROJECT_FILE)
    ? parseJson(files.get(PROJECT_FILE)!)
    : undefined
  // Зламаний проєкт називає стадія 1; підставити "public" замість його
  // `defaultSchema` дало б хибну зміну схеми кожному об'єкту, що її успадковує.
  const parsed =
    project === undefined ? undefined : projectSchema.safeParse(project)
  const defaultSchema = parsed?.success ? parsed.data.defaultSchema : undefined
  const contextOf = (materializes: boolean): Context | undefined =>
    defaultSchema === undefined ? undefined : { defaultSchema, materializes }
  const holders: State["holders"] = { object: new Map(), element: new Map() }
  const add = (on: AssignedOnceField["on"], holder: Holder) => {
    const id = holder.element.id
    if (typeof id === "string" && !holders[on].has(id)) {
      holders[on].set(id, holder)
    }
  }
  for (const file of readObjectFiles(files)) {
    const ctx = contextOf(file.def.materializes !== "none")
    add("object", { file: file.path, pointer: "", element: file.raw, ctx })
    // Корінь файлу — сам об'єкт: його поля тримають записи `on: "object"`.
    for (const at of namedElementsOf(file).filter((a) => a.pointer !== "")) {
      add("element", { file: file.path, ...at, ctx })
    }
  }
  if (project !== undefined) {
    // Вид скоупу матеріалізується колонкою в таблицях, що його несуть.
    const ctx = contextOf(true)
    for (const at of elementsAt(project, "scopeKinds")) {
      add("element", { file: PROJECT_FILE, ...at, ctx })
    }
  }
  return { holders, ...(project === undefined ? {} : { project }) }
}

/**
 * Ефективне значення — з `effective` запису, без розгалуження за полем.
 * `null` — невідоме: запис читає контекст, а проєкт мапи зламаний.
 */
function valueOf(
  record: AssignedOnceField,
  holder: Holder
): string | undefined | null {
  if (record.effective !== undefined && holder.ctx === undefined) return null
  const value =
    record.effective === undefined
      ? holder.element[record.field]
      : record.effective(holder.element, holder.ctx!)
  return typeof value === "string" ? value : undefined
}

const explicit = (record: AssignedOnceField, holder: Holder) =>
  typeof holder.element[record.field] === "string"

/**
 * Діагностика стоїть там, чиє значення змінилося. Поле явне хоча б з одного
 * боку — правка в самому елементі. Успадковане з обох боків — зсунувся
 * проєкт: pointer на `defaultSchema`, якщо ключ є (інакше — корінь файлу,
 * не на неіснуючий ключ), і `objectFile` називає, чий об'єкт зсунуто, бо
 * таких діагностик на одному місці може бути кілька.
 */
function changed(
  record: AssignedOnceField,
  was: Holder,
  now: Holder,
  current: State,
  params: { field: string; before: string; after: string }
): Diagnostic {
  const code = "identity.assigned-once-changed"
  if (explicit(record, was) || explicit(record, now)) {
    return diagnostic(code, now.file, `${now.pointer}/${record.field}`, params)
  }
  const pointer =
    current.project !== undefined &&
    Object.hasOwn(current.project, "defaultSchema")
      ? "/defaultSchema"
      : ""
  return diagnostic(code, PROJECT_FILE, pointer, {
    ...params,
    objectFile: now.file,
  })
}

/**
 * Поля, призначені раз (спека П2 §3, «Призначене раз — правило
 * компілятора»), проти базового стану. Перелік полів — лише `ASSIGNED_ONCE`
 * T0. Відсутність → значення не зміна: призначати — справа `fix`; значення →
 * відсутність — зміна, бо стерте ім'я `fix` дав би інше. Зламаний файл
 * пропускається: про нього звітує стадія 1. Порядок — справа `compile`, що
 * сортує всі діагностики разом.
 */
export function assignedOnceDiagnostics(
  baseline: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>
): Diagnostic[] {
  const before = stateOf(baseline)
  const after = stateOf(current)
  const result: Diagnostic[] = []
  for (const record of ASSIGNED_ONCE) {
    for (const [id, now] of after.holders[record.on]) {
      const was = before.holders[record.on].get(id)
      if (was === undefined) continue
      const old = valueOf(record, was)
      const value = valueOf(record, now)
      if (old === null || value === null) continue
      if (old === undefined || old === value) continue
      result.push(
        changed(record, was, now, after, {
          field: record.field,
          before: old,
          after: value ?? REMOVED,
        })
      )
    }
  }
  return result
}
