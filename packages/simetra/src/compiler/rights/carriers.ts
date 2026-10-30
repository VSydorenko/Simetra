import {
  KIND_REGISTRY,
  type PhysicalSnapshot,
  type PhysicalTable,
  type Project,
  type ReferenceRole,
  type RightsCarrier,
} from "simetra/model"
import { mainTableOf, type CarrierContract } from "../contracts"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import type { ResolvedReference } from "../stages/identity"
import {
  carrierCopyName,
  elementColumns,
  fieldForeignKey,
} from "../stages/model"
import { scopeKindOf } from "./facts"
import { must } from "./references"

/**
 * Чи носій прав «в межах скоупу» (спека прав §4.2): фізичний FK поля є складеним, тобто
 * несе скоуп-колонку першою парою, а в проєкті без видів скоупу межі немає й
 * підходить будь-який одиночний `Ref`.
 *
 * `foreignKey` — FK поля виду в знімку (`undefined`, коли поле FK не має), як
 * його знаходить `fieldForeignKey`. Лише для полів виду: поле виду дає
 * одноколонковий FK лише простим посиланням, тож більше однієї колонки
 * однозначно означає складений; FK прийнятої таблиці описує файл, і там цей
 * висновок не тримається. Для прийнятої таблиці (`declared`) правило
 * закрите за побудовою: її колонки не мають `origin.scopeKindId`, тож
 * `fieldForeignKey` знаходить лише одноколонковий FK (у проєкті з видами
 * скоупу — не в межах), а складений не знаходить зовсім (не `Ref`).
 */
export function inScopeTarget(
  foreignKey: Pick<PhysicalTable["foreignKeys"][number], "columns"> | undefined,
  project: Pick<Project, "scopeKinds">
): boolean {
  if (project.scopeKinds.length === 0) return true
  return foreignKey !== undefined && foreignKey.columns.length > 1
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

/** Об'єкт, на який вказує кінцеве поле носія: сам власник ключа чи ціль `Ref`. */
export function carrierTarget(terminal: {
  object: ParsedObject
  field: CarrierField
}): ParsedObject {
  return terminal.field.key ? terminal.object : terminal.field.target!
}

/**
 * Резолв носія прав (спека прав §4.2, Рх21) у колонку таблиці об'єкта: рядок — власне
 * поле; шлях — перший крок мусить бути одиночним неполіморфним `Ref` у межах
 * скоупу, бо інакше з'єднання в політиці вийшло б за тенант, а другий —
 * реквізит його цілі. Кінцеве поле — `Ref` або ключ; що саме воно має
 * означати, вирішує правило поля (власність, прив'язка, вимір).
 *
 * `at.pointer` — вказівник носія у файлі, `at.field` — ім'я поля для
 * діагностики невідомого реквізиту, `at.role` — роль першого кроку в індексі
 * (типово `rights.carrier`; мапінг `access` має власну).
 */
export function resolveCarrier(
  object: ParsedObject,
  carrier: RightsCarrier,
  at: { pointer: string; field: string; role?: ReferenceRole },
  ctx: CarrierContext
): CarrierResolution {
  const headRole = at.role ?? "rights.carrier"
  if (typeof carrier === "string") {
    const step = resolveStep(object, object, carrier, at, headRole, ctx)
    if (!step.ok) return step
    return {
      ok: true,
      terminal: { object, field: step.field },
      contract: { column: step.field.column, value: step.field.column },
    }
  }
  const [first, second] = carrier
  const head = resolveStep(
    object,
    object,
    first,
    { pointer: `${at.pointer}/0`, field: at.field },
    headRole,
    ctx
  )
  if (!head.ok) return head
  const firstPointer = `${at.pointer}/0`
  if (head.field.target === undefined) {
    return fail("rights.carrier-not-ref", object, firstPointer, first)
  }
  // Ціль кроку — об'єкт виду (Рх21): копію шляху поширює тригер на
  // таблиці цілі, а прийнята таблиця платформних тригерів не несе.
  if (KIND_REGISTRY[head.field.target.kind].declared) {
    return fail("rights.carrier-path-adopted", object, firstPointer, first)
  }
  if (!head.field.inScope) {
    return {
      ok: false,
      diagnostic: crossTenant(object, firstPointer, first, ctx.references),
    }
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
      value: carrierCopyName(head.field.column, tail.field.column),
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
          // Другий крок шляху називає реквізит цілі, тож і текст — про неї.
          ...(object === owner ? {} : { target: object.name }),
        }
      ),
    }
  }
  const field = elementField(object, reference.to.id, name, ctx)
  return field === undefined
    ? fail("rights.carrier-not-ref", owner, at.pointer, name)
    : { ok: true, field }
}

/**
 * Що за поле — елемент `elementId` в основній таблиці об'єкта, за фізичним
 * знімком: одна колонка з FK — одиночний `Ref` (і реквізит, і стандартний, як
 * `createdBy`), ключ — колонка первинного ключа без FK. Поліморфна пара FK не
 * має й двох колонок, тож, як і не-посилання, дає `undefined`.
 *
 * `inScope` виводиться лише для полів виду (`inScopeTarget`): на прийнятій
 * таблиці складений FK з файлу не розпізнається, і поле лишається поза
 * межею скоупу чи не-`Ref` — відмова, а не хибний дозвіл.
 */
export function elementField(
  object: ParsedObject,
  elementId: string,
  name: string,
  ctx: CarrierContext
): CarrierField | undefined {
  const table = must(mainTableOf(ctx.physical, must(object.id)))
  const columns =
    elementColumns(object, table, ctx.project.naming.attributeCase).get(
      elementId
    ) ?? []
  if (columns.length !== 1) return undefined
  const column = columns[0]!
  if (
    table.primaryKey?.columns.length === 1 &&
    table.primaryKey.columns[0] === column
  ) {
    return { name, column, key: true, inScope: true }
  }
  const foreignKey = fieldForeignKey(table, column)
  const target =
    foreignKey === undefined
      ? undefined
      : objectOfTable(foreignKey.references, ctx)
  if (target === undefined) return undefined
  return {
    name,
    column,
    key: false,
    target,
    inScope: inScopeTarget(foreignKey, ctx.project),
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

/**
 * Носій виходить за межі скоупу. Нескоуплений об'єкт тенанта не має, тож
 * текст тоді називає не «вихід за тенант», а те, що посилання не тримається
 * межі скоупу: виправлення інше — скоупити об'єкт.
 */
export function crossTenant(
  object: ParsedObject,
  pointer: string,
  attribute: string,
  references: readonly ResolvedReference[]
): Diagnostic {
  return diagnostic("rights.carrier-cross-tenant", object.file, pointer, {
    attribute,
    ...(scopeKindOf(object, references) === undefined
      ? { host: "unscoped" }
      : {}),
  })
}

function fail(
  code: "rights.carrier-not-ref" | "rights.carrier-path-adopted",
  object: ParsedObject,
  pointer: string,
  attribute: string
): { ok: false; diagnostic: Diagnostic } {
  return {
    ok: false,
    diagnostic: diagnostic(code, object.file, pointer, { attribute }),
  }
}
