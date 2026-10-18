import type { SchemaRule } from "simetra/model"
import { MESSAGES } from "./messages"

export type Severity = "error" | "warning"

/** Коди правил самого компілятора; коди перевірок схем T0 — `SCHEMA_RULES`. */
export const COMPILER_RULES = [
  "project.missing",
  "project.timezone-unknown",
  "project.database-required",
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
  "sql.generated-grant",
  "sql.dependency-cycle",
  "sql.closed-shell",
  "sql.function-overload",
  "sql.row-rule-grammar",
  "sql.row-rule-foreign-table",
  "sql.row-rule-outside-module",
  "sql.row-rule-name-taken",
  "sql.bare-current-user",
  "sql.debt-grows",
  "sql.debt-stale",
  "rewrite.ambiguous-name",
  "rewrite.unqualified-table",
  "rewrite.unsupported",
  "rewrite.trigger-binding",
  "rewrite.label-literal",
  "rewrite.dynamic-sql",
  "rewrite.unresolved-type",
  "rewrite.body-quoting",
  "rewrite.verification-failed",
  "rewrite.contract-change",
  "rewrite.dynamic-sql-unscoped",
  "identity.id-missing",
  "identity.id-duplicate",
  "identity.physical-name-missing",
  "identity.kind-label-missing",
  "identity.kind-label-retained",
  "identity.kind-label-duplicate",
  "identity.assigned-once-changed",
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
  "scope.custom-table-cross-tenant",
  "scope.set-function-missing",
  "scope.set-function-signature",
  "scope.membership-missing",
  "storage.bucket-duplicate",
  "storage.scope-kind-unknown",
  "subscription.source-not-table",
  "subscription.provider-table-unknown",
  "subscription.when-changed-unknown",
  "subscription.when-changed-duplicate",
  "subscription.source-duplicate",
  "subscription.name-duplicate",
  "subscription.when-changed-on-delete",
  "subscription.handler-missing",
  "subscription.handler-signature",
  "subscription.handler-not-closed",
  "subscription.handler-assigns-mechanics",
  "subscription.trigger-name-taken",
  "subscription.when-changed-mechanics",
  "users.catalog-duplicate",
  "users.scope-not-none",
  "users.description-required",
  "users.provision-unsafe",
  "users.catalog-missing",
  "membership.not-scoped",
  "membership.user-not-users-ref",
  "membership.duplicate",
  "rights.action-unknown",
  "rights.custom-action-reserved",
  "rights.requires-cycle",
  "rights.attribute-unknown",
  "reference.not-referenceable",
  "reference.custom-table-key",
  "reference.custom-table-deferrable-key",
  "reference.default-to-table",
  "reference.default-unknown-value",
  "reference.polymorphic-target-kind",
  "attribute.unique-within-place",
  "index.attribute-unknown",
  "index.attribute-duplicate",
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
  "promote.column-unplaced",
  "promote.mapping-unknown",
  "promote.unit-unsupported",
  "promote.reference-not-promoted",
  "promote.retired-referenced",
  "promote.unclassified",
  "promote.write-path",
  "promote.provider-user-reference",
  "promote.enum-labels",
  "promote.type-unsupported",
  "promote.default-unplaced",
  "promote.fill-missing",
  "promote.expression-invalid",
  "promote.debt-text-reference",
  "promote.text-conflict",
  "promote.property-not-equivalent",
  "engine.diagnostic",
  "engine.unmodeled-drift",
  "engine.shadow-load-failed",
  "engine.desired-rejected",
  "engine.clone-failed",
  "engine.preamble-unknown",
  "engine.unrepresentable",
  "engine.unmodeled-class",
  "engine.census-mismatch",
  "engine.unmodeled-property",
  "engine.out-of-scope",
  "engine.owner-not-member",
  "apply.state-format",
  "apply.ledger-without-marker",
  "apply.cascade",
  "apply.non-transactional",
  "apply.commit-boundary",
  "apply.permission-required",
  "apply.permission-unknown",
  "apply.first-apply",
  "apply.drift",
  "apply.drift-partial",
  "apply.versions-changed",
  "apply.plan-versions",
  "apply.plan-format",
  "apply.plan-hash",
  "apply.plan-stale",
  "apply.busy",
  "apply.api-role",
  "apply.server-unsupported",
  "apply.role-mismatch",
  "apply.chain",
  "apply.target-changed",
  "apply.verify-failed",
  "apply.step-failed",
  "apply.lock-timeout",
  "apply.lock-privilege",
  "apply.lock-footprint-exceeded",
  "apply.connection-lost",
  "apply.type-narrowing",
  "apply.type-guard-failed",
  "apply.preservation-failed",
  "apply.preservation-measure-failed",
  "apply.function-check-failed",
  "apply.function-check-blind",
  "apply.deferred-constraint-failed",
  "apply.constraint-invalid",
  "apply.rehearsal-proof-failed",
  "apply.rehearsal-required",
  "apply.rehearsal-stale",
  "apply.rehearsal-copy-empty",
  "apply.rehearsal-fewer-rows",
  "apply.rehearsal-timeout-unbounded",
  "apply.temp-name-taken",
  "apply.plpgsql-check-unavailable",
  "apply.replication-role",
  "apply.data-step-failed",
  "apply.data-step-narrowing",
  "apply.data-write-mismatch",
  "plan.unparsable-step",
  "plan.clone-mismatch",
  "plan.proof-not-empty",
  "plan.fingerprint-disagrees",
  "plan.schema-only-proof",
  "plan.owner-mismatch",
  "plan.type-guard-unsupported",
  "plan.type-change-dependent",
  "plan.promotion-record-missing",
  "plan.promotion-record-invalid",
  "plan.promotion-base",
  "plan.promotion-record-mismatch",
  "plan.promotion-record-stale",
  "plan.promotion-needs-marker",
  "plan.promotion-multiple",
  "plan.promotion-unsupported",
  "plan.promotion-applied",
  "plan.promotion-not-applicable",
  "plan.rename-not-realized",
  "plan.removal-unclassified",
  "plan.platform-replacement-missing",
  "plan.property-not-reproduced",
  "plan.write-path",
  "plan.service-role-access-lost",
  "plan.update-of-narrowed",
  "plan.foreign-exclusive-lock",
  "plan.plpgsql-check-unavailable",
  "plan.temp-name-taken",
  "plan.data-step-volatile",
  "plan.data-step-function-changed",
  "plan.temp-privilege",
  "plan.replication-role",
  "plan.preservation-type",
  "plan.provider-trigger-taken",
  "plan.numbering-not-generated",
  "database.failed",
  "introspect.unrepresentable",
  "introspect.identity-conflict",
  "introspect.project-mismatch",
  "introspect.path-collision",
] as const

export type CompilerRule = (typeof COMPILER_RULES)[number]

export type RuleCode = SchemaRule | CompilerRule

export type DiagnosticParams = Record<string, string | number>

/** Причина, з якої вираз `fill` не стає кроком даних (рішення 12). */
export type FillProblem =
  | "noKey"
  | "syntax"
  | "subquery"
  | "aggregate"
  | "foreignTable"
  | "multipleTargets"
  | "multipleStatements"
  | "setReturning"
  | "volatile"
  | "unknownFunction"
  | "unqualifiedFunction"
  | "castToTime"
  | "specialTimeLiteral"
  | "nondeterministicWindow"
  | "unknownColumn"

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
 * помилки `identity.physical-name-missing`, а не друга помилка. Мітка
 * прийнятої таблиці, що втратила uuid-ключ, — зарезервоване значення: вона
 * могла лягти в збережені поліморфні пари й права, тож лишається, а ціллю
 * поліморфних посилань таблицю не робить. Зміна контракту функції після
 * промоції (`*`, ціле значення рядка, сигнатура) переписана коректно, але
 * змінює форму результату для викликачів — це рішення скіла конверсії, а не
 * помилка переписування. Динамічний SQL поза кандидатами промоції статично
 * не видно: попередження називає межу, а не порушення.
 */
const WARNING_RULES: ReadonlySet<RuleCode> = new Set<RuleCode>([
  "physical.reserved-word",
  "scope.cross-scope-redundant",
  "scope.custom-table-cross-tenant",
  "file.movements-marker-indented",
  "posting.query-order-missing",
  "operation.physical-name-too-long",
  "identity.kind-label-retained",
  "rewrite.contract-change",
  "rewrite.dynamic-sql-unscoped",
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
