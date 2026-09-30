import type { DiagnosticParams, RuleCode } from "./diagnostics"

export interface MessageEntry {
  message: (params: DiagnosticParams) => string
  hint?: string
}

const FIX_IDS = "Run simetra fix to assign ids."
const FIX_PHYSICAL_NAMES = "Run simetra fix to assign physical names."

/**
 * Каталог англійських текстів за кодом правила (спека П2 §8.4). Тип
 * `Record<RuleCode, …>` робить каталог вичерпним: нове правило без тексту не
 * пройде typecheck. Українські тексти додасть каталог UI.
 */
export const MESSAGES: Readonly<Record<RuleCode, MessageEntry>> = {
  // --- Перевірки схем T0 (issue з `params.rule`) ---
  "type.length-required": { message: () => "String type requires length" },
  "type.length-not-allowed": {
    message: () => "Only String type accepts length",
  },
  "type.precision-not-allowed": {
    message: () => "Only Numeric type accepts precision",
  },
  "type.scale-requires-precision": {
    message: () => "Scale requires precision",
  },
  "type.ref-target-required": {
    message: () => "Ref type requires either ref or allowedTypes",
  },
  "type.ref-exclusive": {
    message: () => "ref and allowedTypes are mutually exclusive",
  },
  "type.ref-not-allowed": {
    message: (p) => `Only Ref type accepts ${p.field}`,
  },
  "register.resource-type": {
    message: () => "Accumulation register resources must be Integer or Numeric",
  },
  "customTable.column-type": {
    message: (p) =>
      `Field "${p.field}" does not fit the column type form (logical type, PgEnum or Raw)`,
  },
  "customTable.identity-type": {
    message: () => "identity requires SmallInt, Integer or BigInt type",
  },
  "pgEnum.value-duplicate": {
    message: () => "Enum label is already declared earlier in values",
  },

  // --- Стадія 1: файли ---
  "project.missing": {
    message: () => "project.meta.json is missing",
    hint: "Create project.meta.json at the root of metadata/.",
  },
  "file.unknown-path": {
    message: () => "File is not part of the metadata layout",
    hint: "Objects live in <kind folder>/<Name>/<Name>.meta.json with optional <Name>.module.ts and <Name>.sql; shared SQL lives in sql/<schema>/<file>.sql.",
  },
  "file.orphan": {
    message: (p) => `No ${p.expected} next to this file`,
  },
  "file.invalid-json": {
    message: (p) => `Invalid JSON: ${p.detail}`,
  },
  "file.schema": { message: (p) => String(p.detail) },
  "file.kind-mismatch": {
    message: (p) =>
      `Folder ${p.dir}/ holds ${p.expected} objects, but kind is ${p.actual}`,
  },
  "file.name-mismatch": {
    message: (p) =>
      `Folder and file name must equal the logical name "${p.name}"`,
  },

  // --- Стадія 2: ідентичність, імена, посилання ---
  "identity.id-missing": { message: () => "id is missing", hint: FIX_IDS },
  "identity.id-duplicate": {
    message: (p) => `id ${p.id} is already used in ${p.firstFile}`,
    hint: "Ids are never reused; assign a new id to one of the elements.",
  },
  "identity.physical-name-missing": {
    message: () => "physicalName is missing",
    hint: FIX_PHYSICAL_NAMES,
  },
  "identity.name-duplicate": {
    message: (p) => `Name "${p.name}" is already declared in ${p.scope}`,
  },
  "identity.name-case": {
    message: (p) =>
      `Name "${p.name}" does not follow the project naming style ${p.style}`,
  },
  "identity.name-reserved": {
    message: (p) =>
      `Name "${p.name}" is taken by a standard attribute of ${p.kind}`,
  },
  "reference.unresolved": {
    message: (p) => `${p.kind} "${p.name}" does not exist`,
  },
}
