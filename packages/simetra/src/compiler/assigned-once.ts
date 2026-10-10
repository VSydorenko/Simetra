import {
  ASSIGNED_ONCE,
  projectSchema,
  type AssignedOnceField,
  type KindDefinition,
  type ReferenceRole,
  type StandardColumnDef,
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
  /** Вид файлу-носія; немає — носій лежить у `project.meta.json`. */
  def?: KindDefinition
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
    add("object", {
      file: file.path,
      pointer: "",
      element: file.raw,
      def: file.def,
      ctx,
    })
    // Корінь файлу — сам об'єкт: його поля тримають записи `on: "object"`.
    for (const at of namedElementsOf(file).filter((a) => a.pointer !== "")) {
      add("element", { file: file.path, ...at, def: file.def, ctx })
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

/** Прийнята таблиця: вид, що описує фізику сам і матеріалізується таблицею. */
const isAcceptedTable = (holder: Holder) =>
  holder.def !== undefined &&
  holder.def.declared &&
  holder.def.materializes === "table"

/**
 * Ролі, у яких `Ref` завжди будує поліморфну пару `_type`/`_id`: перелік
 * цілей (`allowedTypes`) реквізиту, константи чи колонки прийнятої таблиці.
 */
const ALLOWED_TYPE_ROLES: ReadonlySet<ReferenceRole> = new Set<ReferenceRole>([
  "attribute.allowedType",
  "constant.allowedType",
])

/**
 * Ролі цілей стандартної колонки-пари виду (власники довідника, реєстратори):
 * чи є пара, каже сама стандартна колонка (`polymorphic`) — одного власника
 * пари немає, а реєстратор її має завжди.
 */
const STANDARD_PAIR_ROLES: Readonly<
  Record<NonNullable<StandardColumnDef["ref"]>, ReferenceRole | undefined>
> = {
  self: undefined,
  owningObject: undefined,
  users: undefined,
  owners: "catalog.owner",
  recorders: "register.recorder",
}

/**
 * Об'єкти (`"<Вид>:<Ім'я>"`), що є ціллю поліморфної пари хоча б в одному
 * файлі: їхня мітка виду лежить у даних пар, тож зникнути не може. Те саме
 * правило — гейт промоції в регістр відомостей (`promote.label-target`).
 */
export function polymorphicTargets(
  files: ReadonlyMap<string, string>
): ReadonlySet<string> {
  const targets = new Set<string>()
  for (const file of readObjectFiles(files)) {
    if (file.data === undefined) continue
    const pairRoles = new Set(
      file.def
        .standardColumns(file.data)
        .flatMap((column) =>
          column.polymorphic !== undefined && column.ref !== undefined
            ? [STANDARD_PAIR_ROLES[column.ref]]
            : []
        )
    )
    for (const { ref, role } of file.def.references(file.data)) {
      if (ALLOWED_TYPE_ROLES.has(role) || pairRoles.has(role)) {
        targets.add(`${ref.kind}:${ref.name}`)
      }
    }
  }
  return targets
}

/**
 * Вид 1С, що матеріалізується таблицею: не прийнята таблиця й не службовий
 * тип (`PgEnum` теж `declared`, але таблиці не дає) — ціль промоції.
 */
const isTableKind = (holder: Holder) =>
  holder.def !== undefined &&
  !holder.def.declared &&
  holder.def.materializes === "table"

/**
 * Промоція (спека промоції Пр18, §9.11): об'єкт, що в базовому стані був
 * прийнятою таблицею, а в поточному має вид 1С з тим самим `id`. Розпізнається
 * з ідентичності, окремої декларації немає; звільняє рівно те, що канонізація
 * переназначає. Решта змін `physicalName`, `kindLabel`, `schema` — як завжди.
 */
interface Promotion {
  /** `id` промотованих об'єктів і вид, у який кожен перейшов. */
  objects: ReadonlyMap<string, KindDefinition>
  /**
   * Файли базового стану, чиї елементи канонізація перейменовує: файл самого
   * промотованого об'єкта й файл прийнятої таблиці, що стала його табличною
   * частиною.
   */
  releasedFiles: ReadonlySet<string>
  /** Файли поточного стану промотованих об'єктів: тут живуть їхні елементи. */
  files: ReadonlySet<string>
}

function promotionOf(before: State, after: State): Promotion {
  const objects = new Map<string, KindDefinition>()
  const promotedFiles = new Set<string>()
  const releasedFiles = new Set<string>()
  for (const [id, was] of before.holders.object) {
    const now = after.holders.object.get(id)
    if (now?.def === undefined || !isAcceptedTable(was) || !isTableKind(now)) {
      continue
    }
    objects.set(id, now.def)
    promotedFiles.add(now.file)
    releasedFiles.add(was.file)
  }
  // Таблиця ТЧ — окрема прийнята таблиця в базі, а тепер елемент (ТЧ)
  // промотованого об'єкта з тим самим id.
  for (const [id, now] of after.holders.element) {
    const was = before.holders.object.get(id)
    if (
      was !== undefined &&
      isAcceptedTable(was) &&
      promotedFiles.has(now.file)
    ) {
      releasedFiles.add(was.file)
    }
  }
  return { objects, releasedFiles, files: promotedFiles }
}

/** Одна зміна поля, призначеного раз, яку розглядає промоція. */
interface Change {
  record: AssignedOnceField
  id: string
  was: Holder
  now: Holder
  /** Нове ефективне значення; немає — поле зникло. */
  value: string | undefined
}

/**
 * Зміна, яку промоція дозволяє: `physicalName` об'єкта й елементів, що були у
 * звільненому файлі й тепер живуть у промотованому об'єкті, а також зникнення
 * мітки виду.
 */
function releasedByPromotion(
  promotion: Promotion,
  { record, id, was, now, value }: Change,
  polymorphic: () => ReadonlySet<string>
): boolean {
  if (record.field === "physicalName") {
    return record.on === "object"
      ? promotion.objects.has(id)
      : promotion.releasedFiles.has(was.file) && promotion.files.has(now.file)
  }
  const kind = promotion.objects.get(id)
  if (record.on !== "object" || record.field !== "kindLabel") return false
  if (kind === undefined || value !== undefined) return false
  // Мітку виду не відновити, тож вона зникає лише там, де нового виду її не
  // очікує, і лише якщо жодна поліморфна пара не веде на об'єкт: значення
  // може лежати в даних; повторне вживання — борг П3.
  return (
    kind.kindLabel !== true &&
    !polymorphic().has(`${now.def?.kind}:${String(now.element.name)}`)
  )
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
  const promotion = promotionOf(before, after)
  let polymorphic: ReadonlySet<string> | undefined
  const polymorphicOf = () => (polymorphic ??= polymorphicTargets(current))
  const result: Diagnostic[] = []
  for (const record of ASSIGNED_ONCE) {
    for (const [id, now] of after.holders[record.on]) {
      const was = before.holders[record.on].get(id)
      if (was === undefined) continue
      const old = valueOf(record, was)
      const value = valueOf(record, now)
      if (old === null || value === null) continue
      if (old === undefined || old === value) continue
      if (
        releasedByPromotion(
          promotion,
          { record, id, was, now, value },
          polymorphicOf
        )
      ) {
        continue
      }
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
