import type {
  AccessPriv,
  FunctionParameter,
  Node,
  ObjectWithArgs,
  RangeVar,
  RoleSpec,
  TypeName,
} from "libpg-query"
import { compareStrings, diagnostic, type Diagnostic } from "../diagnostics"
import { extractMovementBlocks } from "../movement-blocks"
import type { SqlParser } from "./parse"

export type SqlUnitClass =
  | "function"
  | "procedure"
  | "aggregate"
  | "trigger"
  | "policy"
  | "view"
  | "materializedView"
  | "grant"
  | "defaultPrivileges"
  | "comment"
  | "extension"
  | "sequence"
  | "sequenceOwnedBy"
  | "domain"
  | "publication"
  | "replicaIdentity"
  | "functionSettings"
  | "movementQuery"

/**
 * SQL-одиниця скомпільованої моделі (спека П2 §8.3): оператор верхнього рівня
 * дослівного `.sql` або згенерована обгортка запиту рухів. Обидва джерела —
 * один масив з одним простором ідентичностей, тож користувацька функція не
 * може мовчки перекрити обгортку.
 */
export interface SqlUnit {
  class: SqlUnitClass
  /** Канонічний ключ, напр. `function:public.f(uuid,text)`, `trigger:public.orders.trg_x`. */
  identity: string
  /**
   * Об'єкт одиниці. Оператори без власного об'єкта в схемі (грант, типові
   * привілеї, коментар, розширення, publication) мають порожню схему.
   */
  schema: string
  name: string
  /** Немає — згенерована одиниця (запит рухів). */
  file?: string
  /**
   * 1-базний рядок першого токена оператора у `file` — для діагностик;
   * у згенерованої одиниці немає.
   */
  line?: number
  /** `.sql` об'єкта; для рухів — документ. */
  ownerObjectId?: string
  module: string
  /** Текст оператора як є — для рендера. */
  sql: string
  /** Дерево розбору без позицій — для хешу: форматування його не міняє. */
  tree: unknown
  /** Лише `movementQuery`. */
  registerId?: string
  documentId?: string
  source?: "query" | "constructor"
}

/** Обгортка запиту рухів: поля рухів обов'язкові. */
export interface MovementQueryUnit extends SqlUnit {
  class: "movementQuery"
  ownerObjectId: string
  registerId: string
  documentId: string
  source: "query" | "constructor"
}

export function isMovementQuery(unit: SqlUnit): unit is MovementQueryUnit {
  return unit.class === "movementQuery"
}

/** Дослівна одиниця з місцем у файлі; власника-об'єкт резолвить компілятор. */
export interface VerbatimUnit {
  class: SqlUnitClass
  identity: string
  schema: string
  name: string
  file: string
  /** 1-базний рядок першого токена оператора. */
  line: number
  ownerFile?: string
  sql: string
  tree: unknown
}

/** `.sql` для розбору; `schema` — схема некваліфікованих імен. */
export interface SqlSource {
  file: string
  text: string
  schema: string
  ownerFile?: string
}

/** Класи, що живуть у просторі імен функцій Postgres (`pg_proc`). */
export const FUNCTION_CLASSES: ReadonlySet<SqlUnitClass> = new Set([
  "function",
  "procedure",
  "aggregate",
  "movementQuery",
])

/**
 * Розбирає дослівні `.sql` на одиниці (платформна спека §6.3): гейт дозволених
 * операторів, ідентичність за класом і дублікати між файлами. Блоки запиту
 * рухів вирізано заздалегідь — це не оператори бажаного стану.
 */
export function readSqlUnits(
  sources: readonly SqlSource[],
  parse: SqlParser
): { units: VerbatimUnit[]; diagnostics: Diagnostic[] } {
  const units: VerbatimUnit[] = []
  const diagnostics: Diagnostic[] = []
  // Порядок файлів — за шляхом: «перша» з дублікатів не залежить від мапи.
  const ordered = [...sources].sort((a, b) => compareStrings(a.file, b.file))
  for (const source of ordered) {
    const text = extractMovementBlocks(source.text).masked
    const parsed = parse(text)
    if (!parsed.ok) {
      const { line, column } = position(text, parsed.offset)
      diagnostics.push(
        diagnostic("sql.parse", source.file, "", {
          line,
          column,
          detail: parsed.message,
        })
      )
      continue
    }
    for (const statement of parsed.statements) {
      const start = firstToken(text, statement.start, statement.end)
      const line = position(text, start).line
      const classified = classify(statement.stmt, source.schema)
      if ("notAllowed" in classified) {
        diagnostics.push(
          diagnostic("sql.statement-not-allowed", source.file, "", {
            statement: classified.notAllowed,
            line,
            ...(classified.detail === undefined
              ? {}
              : { detail: classified.detail }),
            ...(classified.feature === undefined
              ? {}
              : { feature: classified.feature }),
          })
        )
        continue
      }
      units.push({
        ...classified,
        file: source.file,
        line,
        ...(source.ownerFile === undefined
          ? {}
          : { ownerFile: source.ownerFile }),
        sql: text.slice(start, statement.end).trimEnd(),
        tree: withoutLocations(statement.stmt),
      })
    }
  }
  const first = new Map<string, VerbatimUnit>()
  for (const unit of units) {
    const earlier = first.get(unit.identity)
    if (earlier === undefined) {
      first.set(unit.identity, unit)
    } else {
      diagnostics.push(duplicate(unit, `${earlier.file}:${earlier.line}`))
    }
  }
  return { units, diagnostics }
}

/**
 * Дослівні одиниці, що збігаються з обгорткою запиту рухів: обгортку породжує
 * модель, тож помилкою названо одиницю файлу.
 */
export function generatedDuplicates(
  units: readonly VerbatimUnit[],
  generated: ReadonlyMap<string, string>
): Diagnostic[] {
  return units.flatMap((unit) => {
    const description = generated.get(unit.identity)
    return description === undefined ? [] : [duplicate(unit, description)]
  })
}

function duplicate(unit: VerbatimUnit, first: string): Diagnostic {
  return diagnostic("sql.unit-duplicate", unit.file, "", {
    identity: unit.identity,
    line: unit.line,
    first,
  })
}

const LOCATION_KEYS = new Set(["location", "stmt_location", "stmt_len"])

/** Дерево без позицій: однаковий зміст з іншим форматуванням дає те саме дерево. */
export function withoutLocations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutLocations)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !LOCATION_KEYS.has(key))
      .map(([key, child]) => [key, withoutLocations(child)])
  )
}

/** Ідентичність обгортки — той самий простір, що й у функцій користувача. */
export function functionIdentity(
  schema: string,
  name: string,
  argTypes: readonly string[]
): string {
  return `function:${schema}.${name}(${argTypes.join(",")})`
}

type Classified =
  | { class: SqlUnitClass; identity: string; schema: string; name: string }
  | { notAllowed: string; detail?: string; feature?: "rowLevelSecurity" }

const ROW_SECURITY: ReadonlySet<string> = new Set([
  "AT_EnableRowSecurity",
  "AT_DisableRowSecurity",
  "AT_ForceRowSecurity",
  "AT_NoForceRowSecurity",
])

/**
 * Гейт дозволених класів (спека П2 §8.3): лише об'єкти, якими модель не
 * володіє. Таблиці, індекси, енам-типи — модель; `DROP` і DML — не бажаний
 * стан; RLS таблиці — поле таблиці в метаданих.
 */
function classify(stmt: Node, schema: string): Classified {
  const statement = Object.keys(stmt)[0] ?? "unknown"
  const unit = (
    cls: SqlUnitClass,
    qualified: { schema: string; name: string },
    key: string
  ): Classified => ({ class: cls, identity: `${cls}:${key}`, ...qualified })

  if ("CreateFunctionStmt" in stmt) {
    const node = stmt.CreateFunctionStmt
    const fn = qualify(strings(node.funcname), schema)
    const args = (node.parameters ?? [])
      .map((p) => ("FunctionParameter" in p ? p.FunctionParameter : {}))
      .filter(isInputParameter)
      .map((p) => typeName(p.argType))
    const cls = node.is_procedure === true ? "procedure" : "function"
    return unit(cls, fn, `${fn.schema}.${fn.name}(${args.join(",")})`)
  }
  if ("DefineStmt" in stmt && stmt.DefineStmt.kind === "OBJECT_AGGREGATE") {
    const node = stmt.DefineStmt
    const fn = qualify(strings(node.defnames), schema)
    const list = node.args?.[0]
    const args =
      list !== undefined && "List" in list
        ? (list.List.items ?? [])
            .map((p) => ("FunctionParameter" in p ? p.FunctionParameter : {}))
            .map((p) => typeName(p.argType))
            .join(",")
        : "*"
    return unit("aggregate", fn, `${fn.schema}.${fn.name}(${args})`)
  }
  if ("CreateTrigStmt" in stmt) {
    const node = stmt.CreateTrigStmt
    const table = relation(node.relation, schema)
    const name = node.trigname ?? ""
    return unit(
      "trigger",
      { schema: table.schema, name },
      `${table.schema}.${table.name}.${name}`
    )
  }
  if ("CreatePolicyStmt" in stmt) {
    const node = stmt.CreatePolicyStmt
    const table = relation(node.table, schema)
    const name = node.policy_name ?? ""
    return unit(
      "policy",
      { schema: table.schema, name },
      `${table.schema}.${table.name}.${name}`
    )
  }
  if ("ViewStmt" in stmt) {
    const view = relation(stmt.ViewStmt.view, schema)
    return unit("view", view, `${view.schema}.${view.name}`)
  }
  if (
    "CreateTableAsStmt" in stmt &&
    stmt.CreateTableAsStmt.objtype === "OBJECT_MATVIEW"
  ) {
    const view = relation(stmt.CreateTableAsStmt.into?.rel, schema)
    return unit("materializedView", view, `${view.schema}.${view.name}`)
  }
  if ("GrantStmt" in stmt) {
    const node = stmt.GrantStmt
    const allInSchema = node.targtype === "ACL_TARGET_ALL_IN_SCHEMA"
    const objects = sorted(
      (node.objects ?? []).map((o) => objectName(o, schema))
    ).join(",")
    return unit(
      "grant",
      { schema: "", name: objects },
      [
        node.is_grant === true ? "grant" : "revoke",
        `${allInSchema ? "allInSchema." : ""}${objectType(node.objtype)}`,
        objects,
        roles(node.grantees),
        privileges(node.privileges),
      ].join(":")
    )
  }
  if ("AlterDefaultPrivilegesStmt" in stmt) {
    const node = stmt.AlterDefaultPrivilegesStmt
    const option = (name: string) =>
      (node.options ?? []).flatMap((o) =>
        "DefElem" in o && o.DefElem.defname === name && o.DefElem.arg
          ? listItems(o.DefElem.arg)
          : []
      )
    const role = sorted(option("roles").map((r) => nodeText(r, schema))).join(
      ","
    )
    const action = node.action ?? {}
    return unit(
      "defaultPrivileges",
      { schema: "", name: role },
      [
        role,
        sorted(option("schemas").map((s) => nodeText(s, schema))).join(","),
        objectType(action.objtype),
        action.is_grant === true ? "grant" : "revoke",
        roles(action.grantees),
        privileges(action.privileges),
      ].join(":")
    )
  }
  if ("CommentStmt" in stmt) {
    const node = stmt.CommentStmt
    const name =
      node.object === undefined
        ? ""
        : commentTarget(node.object, node.objtype, schema)
    return unit(
      "comment",
      { schema: "", name },
      `${objectType(node.objtype)}:${name}`
    )
  }
  if ("CreateExtensionStmt" in stmt) {
    const name = stmt.CreateExtensionStmt.extname ?? ""
    return unit("extension", { schema: "", name }, name)
  }
  if ("CreateSeqStmt" in stmt) {
    const seq = relation(stmt.CreateSeqStmt.sequence, schema)
    return unit("sequence", seq, `${seq.schema}.${seq.name}`)
  }
  if ("AlterSeqStmt" in stmt) {
    const node = stmt.AlterSeqStmt
    const options = node.options ?? []
    const ownedBy =
      options.length > 0 &&
      options.every((o) => "DefElem" in o && o.DefElem.defname === "owned_by")
    if (!ownedBy) {
      return { notAllowed: statement, detail: "only OWNED BY is allowed" }
    }
    const seq = relation(node.sequence, schema)
    return unit("sequenceOwnedBy", seq, `${seq.schema}.${seq.name}`)
  }
  if ("CreateDomainStmt" in stmt) {
    const domain = qualify(strings(stmt.CreateDomainStmt.domainname), schema)
    return unit("domain", domain, `${domain.schema}.${domain.name}`)
  }
  if ("AlterPublicationStmt" in stmt) {
    const node = stmt.AlterPublicationStmt
    const name = node.pubname ?? ""
    const action =
      node.action === "AP_DropObjects"
        ? "drop"
        : node.action === "AP_SetObjects"
          ? "set"
          : "add"
    const tables = sorted(
      (node.pubobjects ?? []).map((o) => {
        if (!("PublicationObjSpec" in o)) return ""
        const spec = o.PublicationObjSpec
        if (spec.pubtable !== undefined) {
          const table = relation(spec.pubtable.relation, schema)
          return `${table.schema}.${table.name}`
        }
        return `schema ${spec.name ?? schema}`
      })
    ).join(",")
    return unit(
      "publication",
      { schema: "", name },
      `${name}:${action}:${tables}`
    )
  }
  if ("AlterTableStmt" in stmt) {
    const node = stmt.AlterTableStmt
    const subtypes = (node.cmds ?? []).map((c) =>
      "AlterTableCmd" in c ? (c.AlterTableCmd.subtype ?? "") : ""
    )
    if (
      node.objtype !== "OBJECT_TABLE" ||
      subtypes.length === 0 ||
      subtypes.some((s) => s !== "AT_ReplicaIdentity")
    ) {
      return {
        notAllowed: statement,
        detail: "only REPLICA IDENTITY is allowed",
        // RLS — поле таблиці в метаданих; ознака йде окремим параметром, щоб
        // підказка не розбирала текст і не показувала внутрішні імена вузлів.
        ...(subtypes.some((s) => ROW_SECURITY.has(s))
          ? { feature: "rowLevelSecurity" }
          : {}),
      }
    }
    const table = relation(node.relation, schema)
    return unit("replicaIdentity", table, `${table.schema}.${table.name}`)
  }
  if ("AlterFunctionStmt" in stmt) {
    const fn = stmt.AlterFunctionStmt.func ?? {}
    return unit(
      "functionSettings",
      qualify(strings(fn.objname), schema),
      functionObject(fn, schema)
    )
  }
  return { notAllowed: statement }
}

function isInputParameter(parameter: FunctionParameter): boolean {
  // Ідентичність функції в Postgres — лише вхідні аргументи.
  return (
    parameter.mode !== "FUNC_PARAM_OUT" && parameter.mode !== "FUNC_PARAM_TABLE"
  )
}

function strings(nodes: readonly Node[] | undefined): string[] {
  return (nodes ?? []).map((n) => ("String" in n ? (n.String.sval ?? "") : ""))
}

function listItems(node: Node): Node[] {
  return "List" in node ? (node.List.items ?? []) : [node]
}

/** Останні дві частини імені; без схеми — схема файлу. */
function qualify(
  names: readonly string[],
  schema: string
): { schema: string; name: string } {
  const name = names.at(-1) ?? ""
  return { schema: names.length > 1 ? names.at(-2)! : schema, name }
}

function relation(
  rv: RangeVar | undefined,
  schema: string
): { schema: string; name: string } {
  return { schema: rv?.schemaname ?? schema, name: rv?.relname ?? "" }
}

/** Тип як у дереві розбору: частини імені через `.`, масив — `[]`. */
function typeName(type: TypeName | undefined): string {
  if (type === undefined) return ""
  return (
    strings(type.names).join(".") +
    (type.pct_type === true ? "%type" : "") +
    "[]".repeat(type.arrayBounds?.length ?? 0)
  )
}

function functionObject(fn: ObjectWithArgs, schema: string): string {
  const { schema: s, name } = qualify(strings(fn.objname), schema)
  if (fn.args_unspecified === true) return `${s}.${name}`
  const args = (fn.objargs ?? []).map((a) =>
    "TypeName" in a ? typeName(a.TypeName) : ""
  )
  return `${s}.${name}(${args.join(",")})`
}

/** Об'єкт гранту: відношення й функції кваліфіковано, решта — як у дереві. */
function objectName(node: Node, schema: string): string {
  if ("RangeVar" in node) {
    const { schema: s, name } = relation(node.RangeVar, schema)
    return `${s}.${name}`
  }
  if ("ObjectWithArgs" in node)
    return functionObject(node.ObjectWithArgs, schema)
  return nodeText(node, schema)
}

function nodeText(node: Node, schema: string): string {
  if ("String" in node) return node.String.sval ?? ""
  if ("RoleSpec" in node) return role(node.RoleSpec)
  if ("TypeName" in node) return typeName(node.TypeName)
  if ("List" in node) return strings(node.List.items).join(".")
  if ("ObjectWithArgs" in node)
    return functionObject(node.ObjectWithArgs, schema)
  return ""
}

/** Скільки частин має повне ім'я об'єкта коментаря: бракує — додається схема. */
const COMMENT_PARTS: Readonly<Record<string, number>> = {
  OBJECT_TABLE: 2,
  OBJECT_VIEW: 2,
  OBJECT_MATVIEW: 2,
  OBJECT_SEQUENCE: 2,
  OBJECT_FOREIGN_TABLE: 2,
  OBJECT_INDEX: 2,
  OBJECT_TYPE: 2,
  OBJECT_DOMAIN: 2,
  OBJECT_COLUMN: 3,
  OBJECT_TRIGGER: 3,
  OBJECT_POLICY: 3,
  OBJECT_RULE: 3,
  OBJECT_TABCONSTRAINT: 3,
}

function commentTarget(
  node: Node,
  objtype: string | undefined,
  schema: string
): string {
  if ("ObjectWithArgs" in node)
    return functionObject(node.ObjectWithArgs, schema)
  const parts =
    "List" in node
      ? strings(node.List.items)
      : "TypeName" in node
        ? strings(node.TypeName.names)
        : [nodeText(node, schema)]
  const expected = COMMENT_PARTS[objtype ?? ""]
  return (
    expected !== undefined && parts.length === expected - 1
      ? [schema, ...parts]
      : parts
  ).join(".")
}

function objectType(objtype: string | undefined): string {
  return (objtype ?? "").replace(/^OBJECT_/, "").toLowerCase()
}

function role(spec: RoleSpec): string {
  return (
    spec.rolename ??
    (spec.roletype ?? "").replace(/^ROLESPEC_/, "").toLowerCase()
  )
}

function roles(nodes: readonly Node[] | undefined): string {
  return sorted(
    (nodes ?? []).map((n) => ("RoleSpec" in n ? role(n.RoleSpec) : ""))
  ).join(",")
}

/** Без списку привілеїв — `ALL`. */
function privileges(nodes: readonly Node[] | undefined): string {
  if (nodes === undefined || nodes.length === 0) return "all"
  return sorted(
    nodes.map((n) => {
      const priv: AccessPriv = "AccessPriv" in n ? n.AccessPriv : {}
      const cols = sorted(strings(priv.cols))
      return `${priv.priv_name ?? "all"}${cols.length > 0 ? `(${cols.join(",")})` : ""}`
    })
  ).join(",")
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort(compareStrings)
}

/**
 * Початок першого токена оператора: `stmt_location` указує одразу за
 * попереднім `;`, тож пробіли й коментарі між операторами — не текст одиниці.
 */
function firstToken(text: string, start: number, end: number): number {
  let i = start
  while (i < end) {
    if (/\s/.test(text[i]!)) {
      i++
    } else if (text.startsWith("--", i)) {
      const newline = text.indexOf("\n", i)
      i = newline === -1 ? end : newline + 1
    } else if (text.startsWith("/*", i)) {
      // Блокові коментарі Postgres вкладені.
      let depth = 0
      do {
        if (text.startsWith("/*", i)) {
          depth++
          i += 2
        } else if (text.startsWith("*/", i)) {
          depth--
          i += 2
        } else {
          i++
        }
      } while (depth > 0 && i < end)
    } else {
      break
    }
  }
  return Math.min(i, end)
}

/** 1-базні рядок і колонка (у символах UTF-16) за індексом у тексті. */
function position(
  text: string,
  index: number
): { line: number; column: number } {
  const before = text.slice(0, index)
  const lineStart = before.lastIndexOf("\n") + 1
  return {
    line: before.split("\n").length,
    column: index - lineStart + 1,
  }
}
