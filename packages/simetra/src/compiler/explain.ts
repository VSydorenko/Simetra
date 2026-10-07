import type { MetadataKind, ReferenceRole } from "simetra/model"
import type { CompiledModel } from "./compile"

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
    part?: "main" | "tabularSection" | "totals" | "turnoversMonth"
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
  }[]
  /** Одиниці `movementQuery`, власник яких — цей об'єкт. */
  movementQueries: { identity: string; sql: string }[]
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
    .filter((t) => t.origin.objectId === object.id)
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
