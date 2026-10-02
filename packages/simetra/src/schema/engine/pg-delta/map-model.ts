import {
  encodeId,
  type Fact,
  type FactBase,
  type StableId,
} from "@supabase/pg-delta"
import type { SqlParser } from "simetra/compiler"
import type {
  CatalogEnumType,
  CatalogModel,
  CatalogTable,
  CatalogUnit,
} from "simetra/model"
import { mapEnumType, mapTable, type MappingIssue } from "./map-tables"
import {
  classifyUnit,
  revokedDefaultStatements,
  unitStatements,
  type AclDefaults,
  type ProducedBy,
} from "./map-units"

/** Що мапер бере поза видом двигуна. */
export interface MapContext {
  produced: ProducedBy
  parse: SqlParser
  defaults: AclDefaults
  /** Коментар control-файлу встановленого розширення (`extension-comments`). */
  extensionComments: ReadonlyMap<string, string>
}

/** Дочірні факти таблиці, які мапить сама таблиця (`mapTable`). */
const TABLE_PARTS = new Set(["column", "default", "constraint", "index"])

/**
 * Класи фактів, текст яких модель тримає дослівно: кожен дає SQL-одиницю
 * (план E2a, рішення 6).
 */
const UNIT_KINDS = new Set([
  "acl",
  "defaultPrivilege",
  "function",
  "procedure",
  "aggregate",
  "trigger",
  "policy",
  "view",
  "materializedView",
  "sequence",
  "domain",
  "extension",
  "publicationRel",
  "publicationSchema",
])

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Модель каталогу з керованого виду двигуна: кожен керований факт стає полем
 * моделі, SQL-одиницею або діагностикою `engine.unrepresentable` — за
 * таблицею властивостей спайку E2a. Факти «лише для посилань» (об'єкти
 * провайдера) моделі не належать.
 */
export function mapModel(
  view: FactBase,
  ctx: MapContext
): { model: CatalogModel; issues: MappingIssue[] } {
  const { produced, parse, defaults } = ctx
  const issues: MappingIssue[] = []
  const tables: CatalogTable[] = []
  const enumTypes: CatalogEnumType[] = []
  const units: CatalogUnit[] = []
  const sources = new Map<string, StableId>()
  const managed = (id: StableId) =>
    view.get(id) !== undefined && !view.isReferenceOnly(id)
  const modelTable = (schema: string, name: string) =>
    managed({ kind: "table", schema, name })
  const unit = (fact: Fact, statements: string[]) => {
    for (const sql of statements) {
      if (sql === "") continue
      const mapped = classifyUnit(fact.id, sql, parse, issues)
      if (mapped === undefined) continue
      // Дві пари з однією ідентичністю порівняння за ключем мовчки злило б
      const earlier = sources.get(mapped.identity)
      if (earlier !== undefined)
        issues.push({
          object: fact.id,
          property: "identity",
          detail: `${encodeId(earlier)} maps to the same unit ${mapped.identity}`,
        })
      sources.set(mapped.identity, fact.id)
      units.push(mapped)
    }
  }
  const statements = (fact: Fact) => [
    ...unitStatements(view, fact, produced, defaults, issues),
    ...revokedDefaultStatements(view, fact, defaults),
  ]
  for (const fact of view.facts()) {
    const id = fact.id
    if (view.isReferenceOnly(id)) continue
    // Власник — ребро, а не payload; типового власника проєкція двигуна
    // прибирає, тож ребро, що лишилось, — інший власник, якого модель не має
    for (const edge of view.outgoingEdges(id))
      if (edge.kind === "owner")
        issues.push({
          object: id,
          property: "owner",
          detail: `owner ${encodeId(edge.to)} is not the default owner`,
        })
    if (id.kind === "table") {
      tables.push(mapTable(view, fact, parse, issues))
      unit(fact, statements(fact))
    } else if (TABLE_PARTS.has(id.kind)) {
      tablePart(fact)
    } else if (id.kind === "type") {
      const enumType = mapEnumType(fact, issues)
      if (enumType !== undefined) enumTypes.push(enumType)
      unit(fact, revokedDefaultStatements(view, fact, defaults))
    } else if (id.kind === "typeAttribute" || id.kind === "schema") {
      // Атрибут складеного типу вже названо діагностикою самого типу; схема
      // в моделі неявна — її створює рендер зі схем об'єктів
    } else if (id.kind === "comment") {
      if (!implicitComment(id.target, fact)) unit(fact, statements(fact))
    } else if (UNIT_KINDS.has(id.kind)) {
      unit(fact, statements(fact))
    } else {
      issues.push({
        object: id,
        property: "kind",
        detail: `${id.kind} has no field or unit class in the catalog model`,
      })
    }
  }
  tables.sort((a, b) => compare(a.schema, b.schema) || compare(a.name, b.name))
  enumTypes.sort(
    (a, b) => compare(a.schema, b.schema) || compare(a.name, b.name)
  )
  units.sort((a, b) => compare(a.identity, b.identity))
  return { model: { tables, enumTypes, units }, issues }

  /**
   * Частина таблиці моделі мапиться разом із таблицею; обмеження домену —
   * частина одиниці домену, але лише перевірене: NOT VALID двигун створює
   * окремою дією `ALTER DOMAIN`, якої одиниця домену не містить.
   */
  function tablePart(fact: Fact): void {
    const id = fact.id
    const parent = fact.parent
    if (id.kind === "constraint" && parent?.kind === "domain") {
      const [action] = produced.get(encodeId(id)) ?? []
      const inDomain =
        action !== undefined &&
        action.produces.some((p) => encodeId(p) === encodeId(parent))
      if (fact.payload.validated !== true || !inDomain)
        issues.push({
          object: id,
          property: fact.payload.validated !== true ? "validated" : "sql",
          detail:
            fact.payload.validated !== true
              ? "domain constraint is NOT VALID"
              : "domain constraint is not created by the domain statement",
        })
      return
    }
    const ofTable =
      parent !== undefined &&
      (parent.kind === "table"
        ? managed(parent)
        : parent.kind === "column" && modelTable(parent.schema, parent.table))
    if (!ofTable)
      issues.push({
        object: id,
        property: "parent",
        detail: `${id.kind} of ${parent === undefined ? "nothing" : encodeId(parent)} is not part of a model table`,
      })
  }

  /**
   * Коментар таблиці чи колонки моделі — її поле; коментар розширення, рівний
   * коментарю його control-файлу, ставить сам `CREATE EXTENSION`.
   */
  function implicitComment(target: StableId, fact: Fact): boolean {
    if (target.kind === "table") return managed(target)
    if (target.kind === "column") return modelTable(target.schema, target.table)
    if (target.kind === "extension")
      return ctx.extensionComments.get(target.name) === fact.payload.text
    return false
  }
}
