import {
  COMMAND_CORE_ERRORS,
  type CommandError,
  type ObjectOperation,
  type RuntimeAttribute,
  type RuntimeCatalog,
  type RuntimeConstraint,
  type RuntimeObject,
} from "simetra/model"
import type { DatabaseError } from "./port"
import { INTEGER_TEXT } from "./values"

/**
 * The rejection of `run` and `read`: `message` is the error code, no
 * `cause` — текст Postgres не має виходити назовні навіть через ланцюжок
 * причин (Р-A3-8).
 */
export class CommandFailure extends Error {
  readonly error: CommandError

  constructor(error: CommandError) {
    super(error.code)
    this.name = "CommandFailure"
    this.error = error
  }
}

type Phase = {
  object: RuntimeObject
  /** Читання — фаза без операції. */
  operation?: ObjectOperation
}

/** Значення причин запису T0: усе, крім `errcode` і `message`. */
const valuesOf = (entry: Record<string, string>): readonly string[] =>
  Object.entries(entry)
    .filter(([key]) => key !== "errcode" && key !== "message")
    .map(([, value]) => value)

const E = COMMAND_CORE_ERRORS
const FORBIDDEN_REASONS = valuesOf(E.forbidden)
const CONFLICT_REASONS = valuesOf(E.conflict)
const CONTEXT_DETAILS = valuesOf(E.context)
// Аргументи й гілки ядра, які `DETAIL` `22023` називає замість колонки.
const INVALID_REASONS = [
  "create",
  "p_item",
  "tabular",
  "p_expected_version",
  "p_mark",
  "predefined",
]
const INTERNAL: CommandError = { code: "command.internal" }

/** Таблиця каталогу: основна об'єкта чи ТЧ (тоді шляхи — `<ТЧ>.<реквізит>`). */
interface Table {
  object: RuntimeObject
  name: string
  key: string
  keyName: string
  attributes: readonly RuntimeAttribute[]
  constraints: readonly RuntimeConstraint[]
  prefix: string
}

function tablesOf(object: RuntimeObject): Table[] {
  return [
    {
      object,
      name: object.table.name,
      key: object.key,
      keyName: object.keyName,
      attributes: object.attributes,
      constraints: object.constraints,
      prefix: "",
    },
    ...object.tabularSections.map((s) => ({
      object,
      name: s.table.name,
      key: s.key,
      keyName: s.keyName,
      attributes: s.attributes,
      constraints: s.constraints,
      prefix: `${s.name}.`,
    })),
  ]
}

/**
 * Таблиця за `TABLE` помилки (Postgres дає ім'я без схеми): спершу серед
 * таблиць об'єкта фази, інакше — однозначний збіг у каталозі (Р-A3-19).
 */
function tableOf(
  catalog: RuntimeCatalog,
  phase: Phase | undefined,
  name: string | undefined
): Table | undefined {
  if (name === undefined) return undefined
  const own = phase === undefined ? [] : tablesOf(phase.object)
  const found = own.find((t) => t.name === name)
  if (found !== undefined) return found
  const all = catalog.objects.flatMap(tablesOf).filter((t) => t.name === name)
  return all.length === 1 ? all[0] : undefined
}

/** Логічний шлях фізичної колонки таблиці; пара — за обома колонками. */
function pathOf(table: Table, column: string): string | undefined {
  if (column === table.key) return `${table.prefix}${table.keyName}`
  const attribute = table.attributes.find(
    (a) => a.column === column || a.pair?.typeColumn === column
  )
  return attribute === undefined
    ? undefined
    : `${table.prefix}${attribute.name}`
}

/** Шлях за `DETAIL` `22023` ядра (таблиця брифу Задачі 7). */
function invalidOf(object: RuntimeObject, detail: string): CommandError {
  const [main, ...sections] = tablesOf(object)
  const column = pathOf(main, detail)
  if (column !== undefined) return { code: "command.invalid", path: column }
  for (const section of sections) {
    const head = `tabular.${section.name}`
    if (detail === head) {
      return { code: "command.invalid", path: section.prefix.slice(0, -1) }
    }
    if (detail.startsWith(`${head}.`)) {
      const path = pathOf(section, detail.slice(head.length + 1))
      return path === undefined
        ? { code: "command.invalid", reason: "unknown" }
        : { code: "command.invalid", path }
    }
  }
  return {
    code: "command.invalid",
    reason: INVALID_REASONS.includes(detail) ? detail : "unknown",
  }
}

/** Логічні реквізити колонок без дублів (пара — дві колонки, один реквізит). */
function attributesOf(table: Table, columns: readonly string[]): string[] {
  const names = columns.flatMap((c) => {
    const path = c === table.key ? undefined : pathOf(table, c)
    return path === undefined ? [] : [path]
  })
  return [...new Set(names)]
}

const isSafeInteger = (text: string) =>
  INTEGER_TEXT.test(text) && Number.isSafeInteger(Number(text))

/**
 * Maps a database error to the error the outside sees (P4 spec §6.10).
 * `DETAIL` і `HINT` ідуть назовні лише як значення з переліку T0, колонка
 * каталогу чи безпечне ціле: SQL-обробник застосунку може кинути той самий
 * `MESSAGE` з даними рядка (Р-A3-8). Решта — `command.internal` без тексту;
 * повну помилку логує викликач.
 */
export function mapDatabaseError(
  error: DatabaseError,
  catalog: RuntimeCatalog,
  phase: Phase | undefined
): CommandError {
  if (error.connectionLost) return { code: "command.unavailable" }
  const { code, message, detail } = error
  switch (code) {
    case E.forbidden.errcode:
      if (message === E.context.message) {
        return detail !== undefined && CONTEXT_DETAILS.includes(detail)
          ? { code: "command.context", detail }
          : INTERNAL
      }
      if (message === E.forbidden.message) {
        return detail !== undefined && FORBIDDEN_REASONS.includes(detail)
          ? { code: "command.forbidden", reason: detail }
          : INTERNAL
      }
      return rlsOf(catalog, phase, error.table)
    case E.conflict.errcode: {
      if (message !== E.conflict.message) return INTERNAL
      if (detail === undefined || !CONFLICT_REASONS.includes(detail)) {
        return INTERNAL
      }
      if (error.hint === undefined) {
        return { code: "command.conflict", reason: detail }
      }
      return isSafeInteger(error.hint)
        ? {
            code: "command.conflict",
            reason: detail,
            currentVersion: Number(error.hint),
          }
        : INTERNAL
    }
    case E.invalid.errcode:
      return message === E.invalid.message &&
        detail !== undefined &&
        phase !== undefined
        ? invalidOf(phase.object, detail)
        : INTERNAL
    case "22P02":
      // Читання передає значення `where` зв'язаними параметрами з приведенням:
      // невірний текст типу — вхід клієнта. У записі значення вже перевірене.
      return phase !== undefined && phase.operation === undefined
        ? { code: "command.invalid" }
        : INTERNAL
    case "23503": {
      // Postgres не заповнює `column` для FK — реквізит за ім'ям обмеження (Р-A3-13).
      const table = tableOf(catalog, phase, error.table)
      const fk = table?.constraints.find(
        (c) => c.name === error.constraint && c.kind === "foreignKey"
      )
      const [path] =
        table === undefined || fk === undefined
          ? []
          : attributesOf(table, fk.columns)
      return path === undefined ? INTERNAL : { code: "command.invalid", path }
    }
    case "23502": {
      const table = tableOf(catalog, phase, error.table)
      const path =
        table === undefined || error.column === undefined
          ? undefined
          : pathOf(table, error.column)
      return path === undefined
        ? INTERNAL
        : { code: "command.constraint", kind: "notNull", attributes: [path] }
    }
    case "23505":
    case "23514": {
      const kind = code === "23505" ? "unique" : "check"
      const table = tableOf(catalog, phase, error.table)
      const constraint = table?.constraints.find(
        (c) => c.name === error.constraint && c.kind === kind
      )
      const attributes =
        table === undefined || constraint === undefined
          ? []
          : attributesOf(table, constraint.columns)
      return attributes.length === 0
        ? INTERNAL
        : { code: "command.constraint", kind, attributes }
    }
    default:
      // `0A000` `hierarchy.isolation` і все непередбачене.
      return INTERNAL
  }
}

/**
 * Відмова RLS на записі (Р-A3-19): таблицю Postgres називає лише в тексті,
 * тож об'єкт — з фази, а на `COMMIT` — з однозначного `TABLE`.
 */
function rlsOf(
  catalog: RuntimeCatalog,
  phase: Phase | undefined,
  tableName: string | undefined
): CommandError {
  const object = phase?.object ?? tableOf(catalog, undefined, tableName)?.object
  return {
    code: "command.forbidden",
    reason: "rls",
    ...(object === undefined
      ? {}
      : { object: { kind: object.kind, name: object.name } }),
    ...(phase?.operation === undefined ? {} : { operation: phase.operation }),
  }
}
