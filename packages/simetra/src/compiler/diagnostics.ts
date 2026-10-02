import type { SchemaRule } from "simetra/model"
import { MESSAGES } from "./messages"

export type Severity = "error" | "warning"

/** Коди правил самого компілятора; коди перевірок схем T0 — `SCHEMA_RULES`. */
export const COMPILER_RULES = [
  "project.missing",
  "project.timezone-unknown",
  "file.unknown-path",
  "file.orphan",
  "file.invalid-json",
  "file.schema",
  "file.unknown-key",
  "file.kind-mismatch",
  "file.name-mismatch",
  "file.movements-block",
  "file.movements-marker-indented",
  "sql.parse",
  "sql.statement-not-allowed",
  "sql.unit-duplicate",
  "sql.namespace-conflict",
  "sql.dependency-cycle",
  "identity.id-missing",
  "identity.id-duplicate",
  "identity.physical-name-missing",
  "identity.name-duplicate",
  "identity.name-case",
  "identity.name-reserved",
  "reference.unresolved",
  "reference.ambiguous",
  "customTable.column-unknown",
  "register.balance-control-resource",
  "register.balance-control-duplicate",
  "posting.field-unknown",
  "posting.register-field-unknown",
  "posting.tabular-section-unknown",
  "scope.declaration-missing",
  "scope.unknown-kind",
  "scope.attribute-name-collision",
  "scope.root-duplicate",
  "scope.root-key",
  "scope.root-hierarchy",
  "scope.root-declaration",
  "scope.root-self-reference",
  "scope.global-to-scoped",
  "scope.cross-kind",
  "scope.recorder-mismatch",
  "scope.custom-table-column",
  "scope.cross-scope-redundant",
  "scope.set-function-missing",
  "scope.set-function-signature",
  "reference.not-referenceable",
  "reference.custom-table-key",
  "reference.custom-table-deferrable-key",
  "reference.default-to-table",
  "reference.default-unknown-value",
  "reference.polymorphic-target-kind",
  "catalog.owner-kind",
  "register.recorder-kind",
  "posting.register-kind",
  "posting.register-independent",
  "posting.register-undeclared",
  "posting.source-missing",
  "posting.source-ambiguous",
  "posting.query-not-select",
  "posting.query-order-missing",
  "posting.recorder-not-allowed",
  "posting.fields-incomplete",
  "posting.row-in-document-source",
  "posting.aggregate-in-section-source",
  "posting.movement-type",
  "posting.period-not-allowed",
  "posting.type-mismatch",
  "physical.table-duplicate",
  "physical.relation-duplicate",
  "physical.column-duplicate",
  "physical.discriminator-duplicate",
  "physical.function-duplicate",
  "physical.reserved-word",
  "physical.name-too-long",
  "physical.constraint-name-required",
  "customTable.foreign-key-arity",
  "customTable.foreign-key-deferrable-target",
  "customTable.generated-conflict",
  "customTable.key-column-nullable",
  "presentation.unknown-standard-attribute",
  "operation.physical-name-too-long",
  "operation.input-invalid",
  "operation.target-not-found",
  "operation.object-exists",
  "operation.collection-unknown",
  "operation.delete-referenced",
  "engine.diagnostic",
  "engine.unmodeled-drift",
  "engine.shadow-load-failed",
  "engine.desired-rejected",
  "engine.unrepresentable",
  "engine.unmodeled-class",
  "engine.matview-unpopulated",
] as const

export type CompilerRule = (typeof COMPILER_RULES)[number]

export type RuleCode = SchemaRule | CompilerRule

export type DiagnosticParams = Record<string, string | number>

/** Позиція LSP: 0-базні рядок і колонка в кодових одиницях UTF-16. */
export interface Position {
  line: number
  character: number
}

export interface Range {
  start: Position
  end: Position
}

/**
 * Підмножина форми діагностики LSP (спека П2 §8.4): редактор, агент і CI
 * вказують на одне місце файлу за JSON Pointer, а текст береться з каталогу
 * за кодом правила, щоб споживачі розпізнавали порушення за кодом.
 */
export interface Diagnostic {
  code: RuleCode
  severity: Severity
  /** Шлях відносно кореня `metadata/`, розділювач `/`. */
  file: string
  /** JSON Pointer (RFC 6901); `""` — весь файл. */
  pointer: string
  message: string
  hint?: string
  params?: DiagnosticParams
  /** Заповнює `locate` для файлів, що є в мапі; відображення pointer → рядок і колонка. */
  range?: Range
}

/**
 * Правила-попередження: прогін лишається успішним. Зарезервоване слово в
 * `physicalName` не ламає SQL, бо рендер квотує імена, а прийняте ім'я
 * лишається як є (спека П2 §3). Зайвий `crossScope` теж не ламає FK — він
 * лише вводить в оману читача. Маркер з відступом не відкриває блок, тож
 * запит мовчки не потрапив би в рухи — але файл від цього не ламається.
 * Запит рухів без ORDER BY дає рухи в недетермінованому порядку, але лишається
 * чинним. Ім'я, яке `fix` не призначив через ліміт довжини, — пояснення до
 * помилки `identity.physical-name-missing`, а не друга помилка.
 */
const WARNING_RULES: ReadonlySet<RuleCode> = new Set<RuleCode>([
  "physical.reserved-word",
  "scope.cross-scope-redundant",
  "file.movements-marker-indented",
  "posting.query-order-missing",
  "operation.physical-name-too-long",
])

/** Діагностика з каталогу повідомлень; серйозність — властивість правила. */
export function diagnostic(
  code: RuleCode,
  file: string,
  pointer: string,
  params: DiagnosticParams = {}
): Diagnostic {
  const entry = MESSAGES[code]
  return {
    code,
    severity: WARNING_RULES.has(code) ? "warning" : "error",
    file,
    pointer,
    message: entry.en(params),
    ...(entry.hint !== undefined
      ? {
          hint:
            typeof entry.hint.en === "string"
              ? entry.hint.en
              : entry.hint.en(params),
        }
      : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
  }
}

/** RFC 6901: `~` і `/` у сегменті екрануються, щоб pointer лишався однозначним. */
export function toPointer(path: readonly PropertyKey[]): string {
  return path
    .map(
      (segment) =>
        `/${String(segment).replace(/~/g, "~0").replace(/\//g, "~1")}`
    )
    .join("")
}

/** Значення за JSON Pointer; `""` — сам корінь. */
export function valueAt(data: unknown, pointer: string): unknown {
  let current = data
  for (const segment of pointer.split("/").slice(1)) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Порівняння за кодовими одиницями, а не за локаллю: порядок не залежить від середовища. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Стабільний порядок (файл, pointer, код): той самий вхід дає той самий
 * список, хоч би в якому порядку стадії їх знайшли.
 */
export function sortDiagnostics(
  diagnostics: readonly Diagnostic[]
): Diagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      compareStrings(a.file, b.file) ||
      compareStrings(a.pointer, b.pointer) ||
      compareStrings(a.code, b.code)
  )
}
