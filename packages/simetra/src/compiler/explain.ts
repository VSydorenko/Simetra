import {
  DATABASE_PROVIDERS,
  type GrantPurpose,
  isObjectTable,
  type DatabaseProvider,
  type MetadataKind,
  type ObjectOrigin,
  type ObjectTable,
  type ReferenceRole,
} from "simetra/model"
import type { CompileResult, CompiledModel } from "./compile"
import type { PlatformForm } from "./sql/declarations"
import { grantRole } from "./sql/execute-grants"

export interface Explanation {
  object: {
    id: string
    kind: MetadataKind
    name: string
    file: string
    scopeKind?: string
  }
  tables: {
    schema: string
    name: string
    part?: "main" | "tabularSection" | ObjectOrigin["part"]
    columns: {
      name: string
      type: string
      notNull: boolean
      /** Логічне ім'я реквізиту за `origin.elementId`. */
      logical?: string
      /** Ім'я стандартного реквізиту. */
      standard?: string
      /** Колонка несе значення скоупу (`origin.scopeKindId`). */
      scope?: boolean
    }[]
    primaryKey?: string[]
    uniques: string[][]
    foreignKeys: { columns: string[]; references: string }[]
    /** CHECK таблиці: похідний від виду чи правило рядка модуля. */
    checks: { name: string; expression: string; origin: "kind" | "rowRule" }[]
  }[]
  /** Одиниці `movementQuery`, власник яких — цей об'єкт. */
  movementQueries: { identity: string; sql: string }[]
  /**
   * Інші згенеровані одиниці об'єкта: функції членства довідника учасників,
   * платформний шар довідника «Користувачі».
   */
  generatedUnits: { identity: string; sql: string }[]
  /** Блоки `contracts` цього об'єкта як є. */
  contracts: unknown[]
  /** Посилання з інших об'єктів на цей об'єкт чи його вкладені елементи. */
  referencedBy: { file: string; pointer: string; role: ReferenceRole }[]
}

/** Усі вкладені `{ id, name }` даних виду: реквізити, ТЧ, значення, поля. */
function collectElements(data: unknown, into: Map<string, string>): void {
  if (Array.isArray(data)) {
    for (const item of data) collectElements(item, into)
  } else if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>
    if (typeof record.id === "string" && typeof record.name === "string") {
      into.set(record.id, record.name)
    }
    for (const value of Object.values(record)) collectElements(value, into)
  }
}

/**
 * Лише перегрупування даних моделі: нічого не обчислюється наново, тож
 * пояснення не може розійтися з тим, що побачить рендер чи П3.
 */
export function explainObject(
  model: CompiledModel,
  target: { kind: MetadataKind; name: string }
): Explanation | undefined {
  const object = model.objects.find(
    (o) => o.kind === target.kind && o.name === target.name
  )
  if (object === undefined) return undefined

  const elements = new Map<string, string>()
  collectElements(object.data, elements)

  const scopeKind =
    object.scopeKindId === undefined
      ? undefined
      : model.scopeKinds.find((k) => k.id === object.scopeKindId)?.name

  const tables = model.physical.tables
    .filter(
      (t): t is ObjectTable =>
        isObjectTable(t) && t.origin.objectId === object.id
    )
    .map((t) => {
      const part: Explanation["tables"][number]["part"] =
        t.origin.part ??
        (t.origin.tabularSectionId === undefined ? "main" : "tabularSection")
      return {
        schema: t.schema,
        name: t.name,
        part,
        columns: t.columns.map((c) => {
          const logical =
            c.origin.elementId === undefined
              ? undefined
              : elements.get(c.origin.elementId)
          return {
            name: c.name,
            type: c.type,
            notNull: c.notNull,
            ...(logical === undefined ? {} : { logical }),
            ...(c.origin.standard === undefined
              ? {}
              : { standard: c.origin.standard }),
            ...(c.origin.scopeKindId === undefined ? {} : { scope: true }),
          }
        }),
        ...(t.primaryKey === undefined
          ? {}
          : { primaryKey: [...t.primaryKey.columns] }),
        uniques: t.uniques.map((u) => [...u.columns]),
        foreignKeys: t.foreignKeys.map((f) => ({
          columns: [...f.columns],
          references: `${f.references.schema}.${f.references.table}(${f.references.columns.join(", ")})`,
        })),
        checks: t.checks.map((c) => ({
          name: c.name,
          expression: c.expression,
          origin:
            c.origin === undefined ? ("kind" as const) : ("rowRule" as const),
        })),
      }
    })

  const { contracts } = model
  const blocks: unknown[] = [
    ...contracts.posting.filter((c) => c.documentId === object.id),
    ...contracts.registers.filter((c) => c.registerId === object.id),
    ...contracts.predefined.filter((c) => c.objectId === object.id),
    ...contracts.numbering.filter((c) => c.objectId === object.id),
    ...contracts.eventSubscriptions.filter(
      (c) => c.subscriptionId === object.id
    ),
    ...(contracts.users?.objectId === object.id ? [contracts.users] : []),
    ...contracts.membership.filter((c) => c.objectId === object.id),
    ...contracts.rights.filter((c) => c.objectId === object.id),
    ...contracts.roles.filter((c) => c.roleId === object.id),
    // Рядки проєкції — і ролі (що вона дає), і об'єкта (хто й що на ньому
    // може): одне джерело для обох поглядів, без повторного розгортання.
    ...contracts.rightsProjection.filter(
      (r) => r.roleId === object.id || r.objectId === object.id
    ),
  ]

  const ownIds = new Set([object.id, ...elements.keys()])
  return {
    object: {
      id: object.id,
      kind: object.kind,
      name: object.name,
      file: object.file,
      ...(scopeKind === undefined ? {} : { scopeKind }),
    },
    tables,
    movementQueries: model.sqlUnits
      .filter(
        (u) => u.class === "movementQuery" && u.ownerObjectId === object.id
      )
      .map((u) => ({ identity: u.identity, sql: u.sql })),
    generatedUnits: model.sqlUnits
      .filter(
        (u) =>
          u.file === undefined &&
          u.class !== "movementQuery" &&
          u.ownerObjectId === object.id
      )
      .map((u) => ({ identity: u.identity, sql: u.sql })),
    contracts: blocks,
    // Самопосилання об'єкта (його ж реквізит на його ТЧ) — не «використання».
    referencedBy: model.references
      .filter((r) => ownIds.has(r.to.id) && r.from.objectId !== object.id)
      .map((r) => ({
        file: r.from.file,
        pointer: r.from.pointer,
        role: r.role,
      })),
  }
}

/** Explanation of one SQL function; see `explainFunction`. */
export interface FunctionExplanation {
  function: { schema: string; name: string }
  /** Declared callers; absent when the function is not declared (verbatim grants are not guessed). */
  callers?: string[]
  /** Profile roles that get the derived EXECUTE, per provider (a platform form wins over the declared callers). */
  roles?: Record<DatabaseProvider, { caller: string; role: string }[]>
  /** The declared check in words. */
  check?: string
  /** Whether the body applies the declared check; `none` when no check is declared; a platform form names its form. */
  state:
    | "applied"
    | `not-applied (${string})`
    | `platform-form (${PlatformForm})`
    | "none"
}

/**
 * Explains a function by `schema.name` from the compile result (not the
 * model: it holds no declarations). `undefined` when the folder has no such
 * function.
 */
export function explainFunction(
  compiled: Pick<
    CompileResult,
    "model" | "declaredFunctions" | "functionExecute"
  >,
  target: { schema: string; name: string }
): FunctionExplanation | undefined {
  const { model, declaredFunctions, functionExecute } = compiled
  const declared = declaredFunctions?.find(
    (f) => f.schema === target.schema && f.name === target.name
  )
  // Same groups as the EXECUTE generator: a platform form wins over a
  // declaration, and an undeclared non-form function has no derived roles
  // (verbatim grants are not guessed).
  const entries = (functionExecute ?? []).filter(
    (e) => e.schema === target.schema && e.name === target.name
  )
  const entry = entries.find((e) => e.form !== undefined)
  const exists =
    declared !== undefined ||
    entry !== undefined ||
    model?.sqlUnits.some(
      (u) =>
        u.class === "function" &&
        u.schema === target.schema &&
        u.name === target.name
    ) === true
  if (!exists) return undefined
  const fn = { schema: target.schema, name: target.name }
  const rolesOf = (purposes: readonly string[]) =>
    Object.fromEntries(
      DATABASE_PROVIDERS.map((provider) => [
        provider,
        purposes.flatMap((caller) => {
          const role = grantRole(caller as GrantPurpose, provider)
          return role === null ? [] : [{ caller, role }]
        }),
      ])
    ) as FunctionExplanation["roles"]
  if (entry?.form !== undefined) {
    return {
      function: fn,
      ...(declared === undefined ? {} : { callers: [...declared.callers] }),
      roles: rolesOf(entry.purposes),
      state: `platform-form (${entry.form})`,
    }
  }
  if (declared === undefined) return { function: fn, state: "none" }
  const { check } = declared
  const where =
    check?.row !== undefined
      ? ` on row \`${check.row}\``
      : check?.scope !== undefined
        ? ` on scope \`${check.scope}\``
        : ""
  return {
    function: fn,
    callers: [...declared.callers],
    roles: rolesOf(declared.purposes),
    ...(check === undefined
      ? {}
      : {
          check: `action \`${check.action}\` of ${check.object.kind} \`${check.object.name}\`${where}`,
        }),
    state:
      declared.state === "not-applied"
        ? `not-applied (${declared.reason})`
        : declared.state,
  }
}
