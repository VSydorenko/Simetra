import type { DiagnosticParams, RuleCode } from "./diagnostics"

export interface MessageEntry {
  message: (params: DiagnosticParams) => string
  /** Функція, коли підказка залежить від параметрів (наприклад, від ролі посилання). */
  hint?: string | ((params: DiagnosticParams) => string)
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
  "register.balance-control-type": {
    message: () => "balanceControl is allowed only on a Balance register",
    hint: "A Turnover register keeps no balances to control.",
  },
  "customTable.column-type": {
    message: (p) =>
      `Field "${p.field}" does not fit the column type form (logical type, PgEnum or Raw)`,
  },
  "customTable.cross-scope-not-allowed": {
    message: () => "crossScope is not allowed on a custom table column",
    hint: "Foreign keys of a custom table are explicit; remove crossScope.",
  },
  "customTable.identity-type": {
    message: () => "identity requires SmallInt, Integer or BigInt type",
  },
  "posting.parse": {
    message: (p) => `Invalid expression: ${p.detail ?? "syntax error"}`,
  },
  "pgEnum.value-duplicate": {
    message: () => "Enum label is already declared earlier in values",
  },
  "scope.name-reserved": {
    message: () => 'Scope kind name "none" is reserved',
  },
  "scope.not-allowed": {
    message: () => 'Enumeration scope can only be "none"',
  },
  "type.cross-scope-not-allowed": {
    message: () => "Only Ref type accepts crossScope",
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
  "register.balance-control-resource": {
    message: (p) => `Register has no resource "${p.name}"`,
    hint: "balanceControl lists logical names of the register's resources.",
  },
  "posting.field-unknown": {
    message: (p) => `${p.scope} has no field "${p.name}"`,
    hint: "Standard attributes are written by their logical name in the project naming style.",
  },
  "posting.register-field-unknown": {
    message: (p) =>
      `Register has no dimension, resource or attribute "${p.name}"`,
    hint: "Keys of a movement's fields are logical names of the register's own fields.",
  },
  "posting.tabular-section-unknown": {
    message: (p) => `Document has no tabular section "${p.name}"`,
  },
  "scope.declaration-missing": {
    message: (p) => `${p.kind} "${p.name}" does not declare its scope`,
    hint: 'Once the project declares a scope kind, every scoped object sets "scope" to a kind name or "none".',
  },
  "scope.unknown-kind": {
    message: (p) => `Scope kind "${p.name}" is not declared in the project`,
    hint: 'Scope kinds are declared in project.meta.json under "scopeKinds"; "none" opts the object out of scope.',
  },
  "scope.attribute-name-collision": {
    message: (p) =>
      `Name "${p.name}" collides with the scope column of this ${p.kind}`,
    hint: "The scope column takes the scope kind's logical name in the object's table.",
  },
  "scope.root-duplicate": {
    message: () => "Another scope kind already uses this root",
    hint: "Every scope kind has its own root.",
  },
  "scope.root-hierarchy": {
    message: (p) =>
      `Root ${p.kind} "${p.name}" of scope kind "${p.scope}" cannot be hierarchical`,
    hint: 'Scope hierarchy is not supported; set hierarchyType to "None" and express a holding with an attribute that sets "crossScope".',
  },
  "scope.root-key": {
    message: (p) =>
      `Root of scope kind "${p.scope}" (${p.kind} "${p.name}") has no single-column uuid key`,
    hint: "A scope root is a table object with a single-column uuid primary key; its key is the scope value.",
  },
  "scope.root-declaration": {
    message: (p) =>
      `${p.kind} "${p.name}" is the root of scope kind "${p.scope}" but does not declare it`,
    hint: 'Set "scope" of the root to its own scope kind.',
  },
  "scope.root-self-reference": {
    message: (p) =>
      `Reference to ${p.kind} "${p.name}", the root of the same scope kind "${p.scope}"`,
    hint: (p) =>
      p.via === "owner"
        ? "An owner cannot be the root of its own scope kind; a cross-scope owner is not supported."
        : 'The root key is already the scope value of the object; drop the reference, or set "crossScope" if it deliberately points to another tenant.',
  },
  "scope.global-to-scoped": {
    message: (p) =>
      `Unscoped object references ${p.kind} "${p.name}" of scope kind "${p.scope}"`,
    hint: (p) =>
      p.via === "owner"
        ? "An owner must share the scope kind; a cross-scope owner is not supported."
        : 'Set "crossScope": true on the Ref if the link is intentional.',
  },
  "scope.cross-kind": {
    message: (p) =>
      `Object of scope kind "${p.from}" references ${p.kind} "${p.name}" of scope kind "${p.scope}"`,
    hint: (p) =>
      p.via === "owner"
        ? "An owner must share the scope kind; a cross-scope owner is not supported."
        : 'Set "crossScope": true on the Ref if the link is intentional.',
  },
  "scope.recorder-mismatch": {
    message: (p) =>
      `Register scope "${p.scope}" differs from the scope "${p.recorderScope}" of recorder ${p.kind} "${p.name}"`,
    hint: "A register and all of its recorders share one scope kind.",
  },
  "scope.custom-table-column": {
    message: (p) =>
      p.column === undefined
        ? "Scoped CustomTable must name its scope column in scopeColumn"
        : p.unscoped !== undefined
          ? `scopeColumn "${p.column}" is set, but the table has no scope kind`
          : `scopeColumn "${p.column}" must be a uuid column`,
  },
  "scope.cross-scope-redundant": {
    message: () =>
      "crossScope has no effect: the reference is allowed without it",
    hint: "Remove crossScope.",
  },

  // --- Стадія 4: цілісність ---
  "reference.not-referenceable": {
    message: (p) => `${p.kind} "${p.name}" cannot be referenced here`,
    hint: "The kind registry decides which kinds a Ref may target; a PgEnum is referenced only by a CustomTable column, and a foreign key needs a target that has a table.",
  },
  "reference.custom-table-key": {
    message: (p) =>
      `${p.kind} "${p.name}" has no single-column uuid primary key to reference`,
    hint: "A Ref to a CustomTable, single or polymorphic, stores the value of its single uuid primary key column.",
  },
  "reference.polymorphic-target-kind": {
    message: (p) =>
      `${p.kind} "${p.name}" cannot be a target of a polymorphic reference`,
    hint: "The pair stores a uuid key, so only a Catalog, a Document or a CustomTable with a single uuid primary key fits. Enumeration values are text labels and cannot share the uuid column of a polymorphic pair; use a separate attribute.",
  },
  "catalog.owner-kind": {
    message: (p) => `${p.kind} "${p.name}" cannot own a catalog`,
    hint: "The owner of a catalog must be a catalog.",
  },
  "register.recorder-kind": {
    message: (p) => `${p.kind} "${p.name}" cannot be a recorder`,
    hint: "Movements are written by posting, so a recorder must be a document.",
  },
  "posting.register-kind": {
    message: (p) => `${p.kind} "${p.name}" is not a register`,
    hint: "registerMovements and movements of a document target only accumulation and information registers.",
  },
  "posting.register-undeclared": {
    message: (p) =>
      `Register "${p.name}" is not listed in the document's registerMovements`,
    hint: "Add the register to registerMovements.",
  },
  "posting.recorder-not-allowed": {
    message: (p) =>
      `Register "${p.name}" does not list document "${p.document}" in its recorderTypes`,
    hint: "Add the document to the register's recorderTypes; an Independent information register takes no movements from documents.",
  },
  "posting.fields-incomplete": {
    message: (p) => `Movement does not set register fields: ${p.missing}`,
    hint: "An accumulation register movement sets every dimension and resource; an information register movement sets every dimension and required resource.",
  },
  "posting.row-in-document-source": {
    message: () => "row. fields need a tabular section source",
    hint: 'With source "document" the movement reads the document header: use doc. fields or sum()/count().',
  },
  "posting.aggregate-in-section-source": {
    message: () =>
      "sum() and count() are allowed only with the document source",
    hint: "A tabular section source gives one movement per row; aggregate with the document source.",
  },
  "posting.movement-type": {
    message: (p) =>
      p.problem === "missing"
        ? `Balance register "${p.register}" needs movementType`
        : p.problem === "forbidden"
          ? `Register "${p.register}" has no movement type`
          : p.problem === "value"
            ? `movementType '${p.value}' is neither 'Receipt' nor 'Expense'`
            : `movementType expression gives ${p.actual}, not text`,
    hint: 'Use the literal "Receipt" or "Expense", or an expression that gives one of them.',
  },
  "posting.period-not-allowed": {
    message: (p) =>
      `Register "${p.register}" is not periodic and has no period`,
    hint: "Remove period from the movement, or make the register periodic.",
  },
  "posting.type-mismatch": {
    message: (p) =>
      `Expression gives ${p.actual}, but ${p.expected} is expected`,
    hint: "An integer field does not take a fractional number, a reference field takes only its own targets, and null goes only into a column that may be empty.",
  },
  "physical.table-duplicate": {
    message: (p) =>
      `Physical name ${p.name} is already used by a table or enum type in ${p.firstFile}`,
  },
  "physical.column-duplicate": {
    message: (p) => `Column ${p.name} is already declared in table ${p.table}`,
    hint: "Standard columns of the kind and polymorphic <name>_type/<name>_id pairs take column names too.",
  },
  "physical.discriminator-duplicate": {
    message: (p) =>
      `Another target of this polymorphic reference has physical name ${p.name}`,
    hint: "The type column stores the target's physicalName, so targets must differ by it regardless of schema.",
  },
  "physical.reserved-word": {
    message: (p) => `Physical name ${p.name} is an SQL reserved word`,
    hint: "It works when quoted, but new elements should not take reserved words.",
  },
  "physical.constraint-name-required": {
    message: () =>
      "Postgres names this constraint or index from its expression, so the name cannot be derived",
    hint: "Give the index/constraint an explicit name; the reverse generator always writes names.",
  },
  "customTable.column-unknown": {
    message: (p) => `${p.table} has no column "${p.column}"`,
    hint: "Constraints, indexes and foreign keys refer to columns by logical name.",
  },
  "customTable.foreign-key-arity": {
    message: (p) =>
      `Foreign key has ${p.local} column(s) but references ${p.referenced}`,
  },
  "physical.name-too-long": {
    message: (p) =>
      `Physical name ${p.name} is longer than 63 bytes and would be truncated by Postgres`,
  },
}
