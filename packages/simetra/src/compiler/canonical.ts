import {
  METADATA_KINDS,
  parseExpression,
  type Expr,
  type MetadataKind,
  type ReferenceRole,
  type Span,
} from "simetra/model"
import type { CompiledModel } from "./compile"
import { compareStrings, toPointer } from "./diagnostics"
import { isMovementQuery } from "./sql/units"
import { COLUMN_NAME_ROLES, type ResolvedReference } from "./stages/identity"

/**
 * Канонічна JSON-форма за RFC 8785 (JCS). Власна реалізація: примітиви
 * серіалізує `JSON.stringify` — це саме ES Number::toString та екранування
 * рядків, яких вимагає RFC; лишається сортування ключів і відмова від
 * значень поза I-JSON. Хеш моделі мусить збігатися між середовищами, тож усе,
 * що JSON.stringify мовчки перетворив би (NaN → null, undefined у масиві →
 * null, самотній сурогат → \udXXX), — помилка.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null"
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false"
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalize: ${value} is not a JSON number`)
      }
      return JSON.stringify(value)
    case "string":
      return serializeString(value)
    case "object":
      return Array.isArray(value)
        ? serializeArray(value)
        : serializeObject(value as Record<string, unknown>)
    default:
      throw new TypeError(`canonicalize: ${typeof value} is not JSON`)
  }
}

// Самотній сурогат — старший без молодшого або молодший без старшого.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Рядок не є коректним UTF-16 (RFC 7493 I-JSON): стадія 1 відхиляє такий
 * вхід діагностикою, щоб інваріант канонізації нижче на даних автора не впав.
 */
export function hasLoneSurrogate(value: string): boolean {
  return LONE_SURROGATE.test(value)
}

function serializeString(value: string): string {
  if (hasLoneSurrogate(value)) {
    throw new TypeError("canonicalize: string contains a lone surrogate")
  }
  return JSON.stringify(value)
}

function serializeArray(value: readonly unknown[]): string {
  const items: string[] = []
  // Звичайний цикл, а не map: map пропускає дірки розрідженого масиву.
  for (let i = 0; i < value.length; i++) {
    if (value[i] === undefined) {
      throw new TypeError(`canonicalize: undefined at array index ${i}`)
    }
    items.push(canonicalize(value[i]))
  }
  return `[${items.join(",")}]`
}

function serializeObject(value: Record<string, unknown>): string {
  // Map, Set, Date серіалізувалися б як `{}` чи рядок — мовчазна втрата даних.
  const proto = Object.getPrototypeOf(value) as unknown
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("canonicalize: only plain objects are JSON")
  }
  // compareStrings — кодові одиниці UTF-16, як вимагає RFC 8785 §3.2.3, а не
  // localeCompare, чий порядок залежить від середовища.
  const members = Object.keys(value)
    // Властивість зі значенням undefined відсутня, як у JSON.
    .filter((key) => value[key] !== undefined)
    .sort(compareStrings)
    .map((key) => `${serializeString(key)}:${canonicalize(value[key])}`)
  return `{${members.join(",")}}`
}

const METADATA_KIND_SET: ReadonlySet<string> = new Set(METADATA_KINDS)

/** Індекс посилань одного файлу: pointer → посилання з нього. */
type FileReferences = ReadonlyMap<string, readonly ResolvedReference[]>

/**
 * Знімок моделі для хешу (спека П2 §8.3): усе, що визначає БД і контракти
 * наступних шарів, і нічого, що залежить від розкладки файлів чи
 * форматування. Поза знімком: шляхи файлів (`file`, `moduleFiles`, `$schema`),
 * діагностики, сирий текст і рядки SQL-одиниць (хешується дерево розбору без
 * позицій; межу хешу див. `withoutLocations`),
 * індекс посилань (його зміст уже в `data` як id). Посилання — і MetadataRef,
 * і імена у виразах конструктора — замінено на id: ціль визначає її id, а ім'я
 * цілі й так у знімку з її власним об'єктом.
 */
export function canonicalSnapshot(model: Omit<CompiledModel, "hash">): unknown {
  const refsByFile = new Map<string, Map<string, ResolvedReference[]>>()
  for (const reference of model.references) {
    let byPointer = refsByFile.get(reference.from.file)
    if (byPointer === undefined) {
      byPointer = new Map()
      refsByFile.set(reference.from.file, byPointer)
    }
    const list = byPointer.get(reference.from.pointer) ?? []
    list.push(reference)
    byPointer.set(reference.from.pointer, list)
  }
  const kindById = new Map(model.objects.map((o) => [o.id, o.kind]))
  const titleById = new Map(
    model.project.scopeKinds.map((kind) => [kind.id, kind.title])
  )
  // Види скоупу — лише резолвленою формою: у файлі проєкту корінь названо
  // іменем, а `$schema` — шлях для редактора. Бакети теж називають вид іменем;
  // їхня резолвлена форма — `contracts.storageBuckets`.
  const project = Object.fromEntries(
    Object.entries(model.project).filter(
      ([key]) =>
        key !== "$schema" && key !== "scopeKinds" && key !== "storageBuckets"
    )
  )

  return {
    project,
    objects: model.objects.map((object) => ({
      id: object.id,
      kind: object.kind,
      name: object.name,
      module: object.module,
      ...(object.scopeKindId === undefined
        ? {}
        : { scopeKindId: object.scopeKindId }),
      data: canonicalData(
        object.data,
        refsByFile.get(object.file) ?? new Map()
      ),
    })),
    scopeKinds: model.scopeKinds.map((kind) => {
      const title = titleById.get(kind.id)
      return {
        id: kind.id,
        name: kind.name,
        physicalName: kind.physicalName,
        ...(title === undefined ? {} : { title }),
        root:
          "objectId" in kind.root
            ? {
                kind: must(
                  kindById.get(kind.root.objectId),
                  kind.root.objectId
                ),
                id: kind.root.objectId,
              }
            : kind.root,
        setFunction: kind.setFunction,
        onRootDelete: kind.onRootDelete,
      }
    }),
    physical: model.physical,
    sqlUnits: model.sqlUnits.map((unit) => ({
      class: unit.class,
      identity: unit.identity,
      module: unit.module,
      // Запит рухів — дерево самого запиту: обгортка тримає його рядком у
      // долар-лапках, і форматування блоку змінило б хеш.
      tree: isMovementQuery(unit) ? unit.queryTree : unit.tree,
    })),
    creationOrder: model.creationOrder,
    contracts: model.contracts,
    actions: model.actions,
    presentation: model.presentation,
    modules: model.modules,
  }
}

/**
 * Hex SHA-256 канонічного знімка. Web Crypto, а не `node:crypto`: T1 не
 * залежить від Node API і має працювати в браузері студії.
 */
export async function modelHash(
  model: Omit<CompiledModel, "hash">
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(canonicalSnapshot(model)))
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

interface MovementSource {
  source: "document" | { tabularSection: string }
  condition?: string
  movementType?: string
  period?: string
  fields: Record<string, string>
}

/**
 * Копія `data`: MetadataRef → `{ kind, id }` за індексом посилань, ім'я
 * колонки в ключах, індексах і FK прийнятої таблиці — id елемента; рухи
 * конструктора — з id замість імен (див. `canonicalMovement`). Без перевірки
 * виду: поле `posting` так само читає стадія ідентичності.
 */
function canonicalData(data: unknown, refs: FileReferences): unknown {
  const walk = (
    value: unknown,
    path: readonly (string | number)[]
  ): unknown => {
    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, [...path, index]))
    }
    if (typeof value === "string") {
      const column = refs
        .get(toPointer(path))
        ?.find((r) => COLUMN_NAME_ROLES.has(r.role))
      return column === undefined ? value : column.to.id
    }
    if (typeof value !== "object" || value === null) return value
    const pointer = toPointer(path)
    const reference = refs
      .get(pointer)
      ?.find((r) => METADATA_KIND_SET.has(r.to.kind))
    if (reference !== undefined) {
      return { kind: reference.to.kind as MetadataKind, id: reference.to.id }
    }
    const entries = Object.entries(value)
    // Пропущене посилання тихо лишило б ім'я в хеші: пропуск у `references()`
    // реєстру видів має падати тут, а не зсувати хеш при перейменуванні.
    const kind = (value as { kind?: unknown }).kind
    if (
      entries.length === 2 &&
      "name" in value &&
      typeof kind === "string" &&
      METADATA_KIND_SET.has(kind)
    ) {
      throw new Error(`canonicalSnapshot: unresolved reference at ${pointer}`)
    }
    return Object.fromEntries(
      entries
        // `$schema` — шлях до JSON Schema для редактора, не модель.
        .filter(([key]) => path.length > 0 || key !== "$schema")
        .map(([key, child]) => [key, walk(child, [...path, key])])
    )
  }
  const result = walk(data, []) as Record<string, unknown>
  const movements = (data as { posting?: { movements: MovementSource[] } })
    .posting?.movements
  if (movements === undefined) return result
  const posting = result.posting as { movements: Record<string, unknown>[] }
  return {
    ...result,
    posting: {
      ...posting,
      movements: movements.map((movement, index) =>
        canonicalMovement(movement, posting.movements[index]!, index, refs)
      ),
    },
  }
}

/**
 * Рух конструктора з id замість імен: ТЧ-джерело — `tabularSectionId`, ключі
 * `fields` — id полів регістра, вирази — AST, де поле, ТЧ і агрегат несуть id
 * з індексу посилань (стандартний реквізит — синтетичний
 * `<власник>#<канонічне ім'я>`, тож стиль імен проєкту форму не міняє).
 * Позиції відкинуто: це зміщення в рядку виразу, і пробіли змінили б хеш.
 */
function canonicalMovement(
  movement: MovementSource,
  walked: Record<string, unknown>,
  index: number,
  refs: FileReferences
): Record<string, unknown> {
  const at = (...path: (string | number)[]) =>
    toPointer(["posting", "movements", index, ...path])
  const target = (pointer: string, role: ReferenceRole, span?: Span) =>
    must(
      refs
        .get(pointer)
        ?.find(
          (r) =>
            r.role === role &&
            r.span?.start === span?.start &&
            r.span?.end === span?.end
        )?.to.id,
      `${role} at ${pointer}`
    )
  const expression = (text: string, pointer: string) => {
    const parsed = parseExpression(text)
    // Модель існує лише без помилок, тож вираз уже розібрано стадією 1.
    if (!parsed.ok) throw new Error(`unparsable expression at ${pointer}`)
    return canonicalExpr(parsed.expr, (role, token) =>
      target(pointer, role, token)
    )
  }
  const { condition, movementType, period } = movement
  return {
    ...walked,
    source:
      movement.source === "document"
        ? "document"
        : {
            tabularSectionId: target(
              at("source", "tabularSection"),
              "posting.tabularSection"
            ),
          },
    ...(condition === undefined
      ? {}
      : { condition: expression(condition, at("condition")) }),
    ...(movementType === undefined
      ? {}
      : {
          movementType:
            // `Receipt`/`Expense` — літерал виду руху, а не вираз (схема документа).
            movementType === "Receipt" || movementType === "Expense"
              ? movementType
              : expression(movementType, at("movementType")),
        }),
    ...(period === undefined
      ? {}
      : { period: expression(period, at("period")) }),
    fields: Object.fromEntries(
      Object.entries(movement.fields).map(([name, text]) => {
        const pointer = at("fields", name)
        return [
          target(pointer, "posting.registerField"),
          expression(text, pointer),
        ]
      })
    ),
  }
}

/** Запис індексу — за роллю й токеном імені, як його поклала стадія 2. */
type Resolve = (role: ReferenceRole, token: Span) => string

function canonicalExpr(expr: Expr, resolve: Resolve): unknown {
  switch (expr.type) {
    case "field":
      return {
        type: "field",
        source: expr.base,
        elementId: resolve(
          expr.base === "row" ? "posting.rowField" : "posting.docField",
          expr.fieldSpan
        ),
      }
    case "sum":
      return {
        type: "sum",
        tabularSectionId: resolve("posting.tabularSection", expr.sectionSpan),
        elementId: resolve("posting.rowField", expr.fieldSpan),
      }
    case "count":
      return {
        type: "count",
        tabularSectionId: resolve("posting.tabularSection", expr.sectionSpan),
      }
    case "unary":
      return {
        type: "unary",
        op: expr.op,
        operand: canonicalExpr(expr.operand, resolve),
      }
    case "binary":
      return {
        type: "binary",
        op: expr.op,
        left: canonicalExpr(expr.left, resolve),
        right: canonicalExpr(expr.right, resolve),
      }
    default:
      // Літерали: усе, крім позицій.
      return Object.fromEntries(
        Object.entries(expr).filter(([key]) => key !== "start" && key !== "end")
      )
  }
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`canonicalSnapshot: unresolved ${what}`)
  }
  return value
}
