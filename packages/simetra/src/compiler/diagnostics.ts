import type { SchemaRule } from "simetra/model"
import { MESSAGES } from "./messages"

export type Severity = "error" | "warning"

/** Коди правил самого компілятора; коди перевірок схем T0 — `SCHEMA_RULES`. */
export const COMPILER_RULES = [
  "project.missing",
  "file.unknown-path",
  "file.orphan",
  "file.invalid-json",
  "file.schema",
  "file.kind-mismatch",
  "file.name-mismatch",
  "identity.id-missing",
  "identity.id-duplicate",
  "identity.physical-name-missing",
  "identity.name-duplicate",
  "identity.name-case",
  "identity.name-reserved",
  "reference.unresolved",
  "scope.declaration-missing",
  "scope.unknown-kind",
  "scope.attribute-name-collision",
  "scope.root-key",
  "scope.root-declaration",
  "scope.root-self-reference",
  "scope.global-to-scoped",
  "scope.cross-kind",
  "scope.recorder-mismatch",
  "scope.custom-table-column",
  "scope.cross-scope-redundant",
  "reference.not-referenceable",
  "reference.custom-table-key",
  "reference.polymorphic-target-kind",
  "catalog.owner-kind",
  "physical.table-duplicate",
  "physical.column-duplicate",
  "physical.discriminator-duplicate",
  "physical.reserved-word",
  "physical.name-too-long",
  "physical.constraint-name-required",
  "customTable.column-unknown",
  "customTable.foreign-key-arity",
] as const

export type CompilerRule = (typeof COMPILER_RULES)[number]

export type RuleCode = SchemaRule | CompilerRule

export type DiagnosticParams = Record<string, string | number>

interface Position {
  line: number
  character: number
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
  /** Позицію в тексті дає відображення pointer → рядок і колонка. */
  range?: { start: Position; end: Position }
}

/**
 * Правила-попередження: прогін лишається успішним. Зарезервоване слово в
 * `physicalName` не ламає SQL, бо рендер квотує імена, а прийняте ім'я
 * лишається як є (спека П2 §3). Зайвий `crossScope` теж не ламає FK — він
 * лише вводить в оману читача.
 */
const WARNING_RULES: ReadonlySet<RuleCode> = new Set<RuleCode>([
  "physical.reserved-word",
  "scope.cross-scope-redundant",
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
    message: entry.message(params),
    ...(entry.hint !== undefined ? { hint: entry.hint } : {}),
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
