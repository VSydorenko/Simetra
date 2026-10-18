import {
  KIND_REGISTRY,
  standardLogicalName,
  type AttributeCase,
  type PhysicalSnapshot,
  type PhysicalTable,
  type Project,
  type ReferenceRole,
  type RightsCarrier,
} from "simetra/model"
import { mainTableOf, type CarrierContract } from "../contracts"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import { standardElementId, type ResolvedReference } from "../stages/identity"

/**
 * Чи носій прав «в межах скоупу» (Р1a-10): фізичний FK поля є складеним, тобто
 * несе скоуп-колонку першою парою, а в проєкті без видів скоупу межі немає й
 * підходить будь-який одиночний `Ref`.
 *
 * `foreignKey` — FK поля виду в знімку (`undefined`, коли поле FK не має), як
 * його знаходить `fieldForeignKey`. Лише для полів виду: поле виду дає
 * одноколонковий FK лише простим посиланням, тож більше однієї колонки
 * однозначно означає складений; FK прийнятої таблиці описує файл, і там цей
 * висновок не тримається.
 */
export function inScopeTarget(
  foreignKey: Pick<PhysicalTable["foreignKeys"][number], "columns"> | undefined,
  project: Pick<Project, "scopeKinds">
): boolean {
  if (project.scopeKinds.length === 0) return true
  return foreignKey !== undefined && foreignKey.columns.length > 1
}

/**
 * FK колонки поля: той, що містить саме цю колонку, а решта його колонок —
 * скоуп-колонки таблиці. Так складений FK поля не сплутати з FK іншого поля,
 * що теж несе скоуп-колонку.
 */
export function fieldForeignKey(
  table: PhysicalTable,
  column: string
): PhysicalTable["foreignKeys"][number] | undefined {
  const scopeColumns = new Set(
    table.columns
      .filter((c) => c.origin.scopeKindId !== undefined)
      .map((c) => c.name)
  )
  return table.foreignKeys.find(
    (fk) =>
      fk.columns.includes(column) &&
      fk.columns.every((c) => c === column || scopeColumns.has(c))
  )
}

/** Вхід резолву носія: індекс посилань і фізичний знімок стадії 3. */
export interface CarrierContext {
  references: readonly ResolvedReference[]
  physical: PhysicalSnapshot
  project: Pick<Project, "scopeKinds" | "naming">
  byId: ReadonlyMap<string, ParsedObject>
}

/** Кінцеве поле носія: колонка в таблиці свого об'єкта і що вона означає. */
export interface CarrierField {
  /** Логічне ім'я у файлі. */
  name: string
  /** Фізична колонка в основній таблиці об'єкта поля. */
  column: string
  /** Ключ (`ref`) об'єкта поля: значення — сам рядок, а не посилання. */
  key: boolean
  /** Ціль одиночного `Ref`; у ключа немає. */
  target?: ParsedObject
  /** FK поля в межах скоупу (`inScopeTarget`); у ключа — `true`. */
  inScope: boolean
}

export type CarrierResolution =
  | {
      ok: true
      terminal: { object: ParsedObject; field: CarrierField }
      contract: CarrierContract
    }
  | { ok: false; diagnostic: Diagnostic }

/**
 * Резолв носія прав (Р1a-10, Рх21) у колонку таблиці об'єкта: рядок — власне
 * поле; шлях — перший крок мусить бути одиночним неполіморфним `Ref` у межах
 * скоупу, бо інакше з'єднання в політиці вийшло б за тенант, а другий —
 * реквізит його цілі. Кінцеве поле — `Ref` або ключ; що саме воно має
 * означати, вирішує правило поля (власність, прив'язка, вимір).
 *
 * `at.pointer` — вказівник носія у файлі, `at.field` — ім'я поля для
 * діагностики невідомого реквізиту.
 */
export function resolveCarrier(
  object: ParsedObject,
  carrier: RightsCarrier,
  at: { pointer: string; field: string },
  ctx: CarrierContext
): CarrierResolution {
  if (typeof carrier === "string") {
    const step = resolveStep(object, object, carrier, at, "rights.carrier", ctx)
    if (!step.ok) return step
    return {
      ok: true,
      terminal: { object, field: step.field },
      contract: { column: step.field.column },
    }
  }
  const [first, second] = carrier
  const head = resolveStep(
    object,
    object,
    first,
    { pointer: `${at.pointer}/0`, field: at.field },
    "rights.carrier",
    ctx
  )
  if (!head.ok) return head
  const firstPointer = `${at.pointer}/0`
  if (head.field.target === undefined) {
    return fail("rights.carrier-not-ref", object, firstPointer, first)
  }
  if (!head.field.inScope) {
    return fail("rights.carrier-cross-tenant", object, firstPointer, first)
  }
  const target = head.field.target
  const tail = resolveStep(
    object,
    target,
    second,
    { pointer: `${at.pointer}/1`, field: at.field },
    "rights.carrierPath",
    ctx
  )
  if (!tail.ok) return tail
  const table = must(mainTableOf(ctx.physical, must(target.id)))
  return {
    ok: true,
    terminal: { object: target, field: tail.field },
    contract: {
      column: head.field.column,
      via: {
        objectId: must(target.id),
        table: { schema: table.schema, name: table.name },
        column: tail.field.column,
      },
    },
  }
}

type StepResult =
  { ok: true; field: CarrierField } | { ok: false; diagnostic: Diagnostic }

/**
 * Один крок: ім'я резолвить індекс посилань (роль кроку на його вказівнику),
 * а що це за поле — каже фізичний знімок: одна колонка з FK — одиночний
 * `Ref` (і реквізит, і стандартний, як `createdBy`), ключ — колонка
 * первинного ключа без FK. Поліморфна пара FK не має й двох колонок.
 */
function resolveStep(
  owner: ParsedObject,
  object: ParsedObject,
  name: string,
  at: { pointer: string; field: string },
  role: ReferenceRole,
  ctx: CarrierContext
): StepResult {
  const reference = ctx.references.find(
    (r) =>
      r.from.file === owner.file &&
      r.from.pointer === at.pointer &&
      r.role === role
  )
  if (reference === undefined || object.id === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "rights.attribute-unknown",
        owner.file,
        at.pointer,
        {
          attribute: name,
          field: at.field,
        }
      ),
    }
  }
  const table = must(mainTableOf(ctx.physical, object.id))
  const columns =
    elementColumns(object, table, ctx.project.naming.attributeCase).get(
      reference.to.id
    ) ?? []
  const notRef = fail("rights.carrier-not-ref", owner, at.pointer, name)
  if (columns.length !== 1) return notRef
  const column = columns[0]!
  if (
    table.primaryKey?.columns.length === 1 &&
    table.primaryKey.columns[0] === column
  ) {
    return { ok: true, field: { name, column, key: true, inScope: true } }
  }
  const foreignKey = fieldForeignKey(table, column)
  const target =
    foreignKey === undefined
      ? undefined
      : objectOfTable(foreignKey.references, ctx)
  if (target === undefined) return notRef
  return {
    ok: true,
    field: {
      name,
      column,
      key: false,
      target,
      inScope: inScopeTarget(foreignKey, ctx.project),
    },
  }
}

/** Об'єкт, чия основна таблиця — ціль FK. */
function objectOfTable(
  references: { schema: string; table: string },
  ctx: CarrierContext
): ParsedObject | undefined {
  const table = ctx.physical.tables.find(
    (t) =>
      t.schema === references.schema &&
      t.name === references.table &&
      t.origin.tabularSectionId === undefined &&
      t.origin.part === undefined
  )
  return table === undefined ? undefined : ctx.byId.get(table.origin.objectId)
}

function fail(
  code: "rights.carrier-not-ref" | "rights.carrier-cross-tenant",
  object: ParsedObject,
  pointer: string,
  attribute: string
): { ok: false; diagnostic: Diagnostic } {
  return {
    ok: false,
    diagnostic: diagnostic(code, object.file, pointer, { attribute }),
  }
}

/**
 * Фізичні колонки основної таблиці за id елемента: реквізит — за своїм UUID,
 * стандартний реквізит — за синтетичним id з канонічним ім'ям (той самий, що
 * дає індекс посилань), тож ефекти реєстру й посилання файлу читаються
 * однаково. Поліморфна пара дає обидві колонки.
 */
export function elementColumns(
  object: ParsedObject,
  table: PhysicalTable,
  style: AttributeCase
): Map<string, string[]> {
  const objectId = must(object.id)
  const byStandard = new Map(
    KIND_REGISTRY[object.kind]
      .standardColumns(object.data)
      .map((c) => [
        standardLogicalName(c, style),
        standardElementId(objectId, c),
      ])
  )
  const result = new Map<string, string[]>()
  for (const column of table.columns) {
    const id =
      column.origin.elementId ??
      (column.origin.standard === undefined
        ? undefined
        : byStandard.get(column.origin.standard))
    if (id === undefined) continue
    result.set(id, [...(result.get(id) ?? []), column.name])
  }
  return result
}

/** Модель після стадії 3 гарантує наявність; відсутність — дефект компілятора. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("internal: missing carrier input")
  return value
}
