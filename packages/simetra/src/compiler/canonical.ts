import {
  METADATA_KINDS,
  parseExpression,
  type MetadataKind,
} from "simetra/model"
import type { CompiledModel } from "./compile"
import { compareStrings, toPointer } from "./diagnostics"
import type { ResolvedReference } from "./stages/identity"

/**
 * Канонічна JSON-форма за RFC 8785 (JCS). Власна реалізація (рішення плану
 * п. 3): примітиви серіалізує `JSON.stringify` — це саме ES Number::toString
 * та екранування рядків, яких вимагає RFC; лишається сортування ключів і
 * відмова від значень поза I-JSON. Хеш моделі мусить збігатися між
 * середовищами, тож усе, що JSON.stringify мовчки перетворив би (NaN → null,
 * undefined у масиві → null, самотній сурогат → \udXXX), — помилка.
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

function serializeString(value: string): string {
  if (LONE_SURROGATE.test(value)) {
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

/**
 * Знімок моделі для хешу (спека П2 §8.3): усе, що визначає БД і контракти
 * наступних шарів, і нічого, що залежить від розкладки файлів чи
 * форматування. Поза знімком: шляхи файлів (`file`, `moduleFiles`),
 * діагностики, сирий текст і рядки SQL-одиниць (дерево вже без позицій),
 * індекс посилань (його зміст уже в `data` як id). Імена посилань у `data`
 * замінено на id — ціль визначає її id, а ім'я цілі й так у знімку з її
 * власним об'єктом.
 */
export function canonicalSnapshot(model: Omit<CompiledModel, "hash">): unknown {
  const refsByFile = new Map<string, Map<string, ResolvedReference>>()
  for (const reference of model.references) {
    // Лише посилання на об'єкти метаданих — це і є MetadataRef у файлі;
    // елементи (реквізит, ТЧ, поле виразу) вказують на рядок чи вираз.
    if (!METADATA_KIND_SET.has(reference.to.kind)) continue
    let byPointer = refsByFile.get(reference.from.file)
    if (byPointer === undefined) {
      byPointer = new Map()
      refsByFile.set(reference.from.file, byPointer)
    }
    byPointer.set(reference.from.pointer, reference)
  }

  return {
    project: model.project,
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
        refsByFile.get(object.file) ?? new Map(),
        expressionPointers(object.data)
      ),
    })),
    scopeKinds: model.scopeKinds,
    physical: model.physical,
    sqlUnits: model.sqlUnits.map((unit) => ({
      class: unit.class,
      identity: unit.identity,
      module: unit.module,
      tree: unit.tree,
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

/**
 * Pointer-и виразів конструктора рухів. Без перевірки виду: поле `posting`
 * читає так само стадія ідентичності; `Receipt`/`Expense` — літерал виду
 * руху, а не вираз (схема документа).
 */
function expressionPointers(data: unknown): Set<string> {
  const pointers = new Set<string>()
  const movements = (
    data as {
      posting?: {
        movements: {
          condition?: string
          movementType?: string
          period?: string
          fields: Record<string, string>
        }[]
      }
    }
  ).posting?.movements
  movements?.forEach((movement, index) => {
    const at = (...path: string[]) =>
      pointers.add(toPointer(["posting", "movements", index, ...path]))
    if (movement.condition !== undefined) at("condition")
    if (
      movement.movementType !== undefined &&
      movement.movementType !== "Receipt" &&
      movement.movementType !== "Expense"
    ) {
      at("movementType")
    }
    if (movement.period !== undefined) at("period")
    for (const name of Object.keys(movement.fields)) at("fields", name)
  })
  return pointers
}

/**
 * Копія `data`: MetadataRef → `{ kind, id }` за індексом посилань, вираз
 * конструктора → AST без позицій. Позиції — зміщення в рядку виразу, тож
 * пробіли у виразі змінили б хеш, хоча модель та сама.
 */
function canonicalData(
  data: unknown,
  refs: ReadonlyMap<string, ResolvedReference>,
  expressions: ReadonlySet<string>
): unknown {
  const walk = (
    value: unknown,
    path: readonly (string | number)[]
  ): unknown => {
    const pointer = toPointer(path)
    if (typeof value === "string" && expressions.has(pointer)) {
      const parsed = parseExpression(value)
      // Модель існує лише без помилок, тож вираз уже розібрано стадією 1.
      if (!parsed.ok) {
        throw new Error(
          `canonicalSnapshot: unparsable expression at ${pointer}`
        )
      }
      return withoutPositions(parsed.expr)
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, [...path, index]))
    }
    if (typeof value !== "object" || value === null) return value
    const reference = refs.get(pointer)
    if (reference !== undefined && "name" in value) {
      return { kind: reference.to.kind as MetadataKind, id: reference.to.id }
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        walk(child, [...path, key]),
      ])
    )
  }
  return walk(data, [])
}

function withoutPositions(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "start" && key !== "end")
      .map(([key, child]) => [key, withoutPositions(child)])
  )
}
