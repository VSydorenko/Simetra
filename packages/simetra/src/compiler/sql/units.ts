import type {
  AccessPriv,
  CreateFunctionStmt,
  FunctionParameter,
  Node,
  ObjectWithArgs,
  RangeVar,
  RoleSpec,
  TypeName,
} from "libpg-query"
import {
  PLATFORM_SCHEMA,
  type PhysicalSnapshot,
  type PhysicalTable,
  type SqlUnitClass,
} from "simetra/model"
import { compareStrings, diagnostic, type Diagnostic } from "../diagnostics"
import { extractMovementBlocks } from "../movement-blocks"
import type { CreationNode } from "./dependencies"
import type { ParsedStatement, SqlParser } from "./parse"
import { statementTargets } from "./unit-target"

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
  /** Немає — згенерована одиниця (запит рухів, членство, платформний шар). */
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
  /**
   * Дерево розбору без позицій — для залежностей і хешу: форматування його не
   * міняє, межу хешу див. `withoutLocations`. У запиту рухів хеш бере
   * `queryTree`: тут тіло обгортки — рядок.
   */
  tree: unknown
  /** Лише `movementQuery`: дерева операторів самого запиту без позицій. */
  queryTree?: unknown
  /** Лише `movementQuery`. */
  registerId?: string
  documentId?: string
  source?: "query" | "constructor"
  /**
   * Лише згенерована одиниця: її генератор. Файлу й рядка вона не має, тож
   * діагностика про збіг з дослівною одиницею називає її за походженням.
   */
  generator?: UnitGenerator
  /**
   * Лише згенерована одиниця: вузли, яких вимагає її тіло plpgsql. Граф
   * порядку тіл plpgsql не читає (Postgres не перевіряє їх при створенні),
   * тож ці ребра називає генератор, що знає тіло (спека П2 §8.3).
   */
  requires?: readonly CreationNode[]
}

/** Хто згенерував одиницю. */
export type UnitGenerator = "movementQuery" | "membership" | "platformLayer"

/** Обгортка запиту рухів: поля рухів обов'язкові. */
export interface MovementQueryUnit extends SqlUnit {
  class: "movementQuery"
  generator: "movementQuery"
  ownerObjectId: string
  queryTree: unknown
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

/**
 * Правило рядка модуля виду (спека промоції §9.4) до перевірки граматики:
 * `ALTER TABLE … ADD CONSTRAINT <ім'я> CHECK (…)`. Не SQL-одиниця — після
 * перевірки воно стає CHECK таблиці у фізичному знімку, тож класу одиниці не
 * має і в простір ідентичностей одиниць не входить.
 */
export interface RowRule {
  schema: string
  table: string
  name: string
  /** Вираз CHECK з дерева розбору (з позиціями) — для граматики й тексту знімка. */
  expr: Node
  file: string
  /** 1-базний рядок першого токена оператора. */
  line: number
  ownerFile?: string
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
  parse: SqlParser,
  known: readonly { schema: string; name: string }[]
): {
  units: VerbatimUnit[]
  rowRules: RowRule[]
  diagnostics: Diagnostic[]
} {
  const units: VerbatimUnit[] = []
  const rowRules: RowRule[] = []
  const diagnostics: Diagnostic[] = []
  // Порядок файлів — за шляхом: «перша» з дублікатів не залежить від мапи.
  const ordered = [...sources].sort((a, b) => compareStrings(a.file, b.file))
  const files: {
    source: SqlSource
    text: string
    statements: ParsedStatement[]
  }[] = []
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
    files.push({ source, text, statements: parsed.statements })
  }
  // Некваліфікований тип аргументу резолвиться в типи моделі, тож домени і
  // типи рядків в'юх усіх файлів зібрано до ідентичностей.
  const declared = files.flatMap(({ source, statements }) =>
    statements.flatMap(({ stmt }) => {
      if ("CreateDomainStmt" in stmt) {
        return [
          qualify(strings(stmt.CreateDomainStmt.domainname), source.schema),
        ]
      }
      if ("ViewStmt" in stmt)
        return [relation(stmt.ViewStmt.view, source.schema)]
      if (
        "CreateTableAsStmt" in stmt &&
        stmt.CreateTableAsStmt.objtype === "OBJECT_MATVIEW"
      ) {
        return [relation(stmt.CreateTableAsStmt.into?.rel, source.schema)]
      }
      return []
    })
  )
  const types = modelTypes([...known, ...declared])
  for (const { source, text, statements } of files) {
    for (const statement of statements) {
      const start = firstToken(text, statement.start, statement.end)
      const line = position(text, start).line
      const classified = classify(statement.stmt, {
        schema: source.schema,
        types,
      })
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
      // Схема платформи зайнята системним шаром незалежно від теки файлу:
      // кваліфіковане ім'я в спільному чи об'єктному `.sql` поклало б об'єкт
      // застосунку туди ж. Виклик функції платформи в тілі — не ціль, його
      // дерево розбору тут не читається.
      if (reservesPlatformSchema(classified, statement.stmt, source.schema)) {
        diagnostics.push(
          diagnostic("schema.reserved", source.file, "", { line })
        )
        continue
      }
      if ("rowRule" in classified) {
        rowRules.push({
          ...classified.rowRule,
          file: source.file,
          line,
          ...(source.ownerFile === undefined
            ? {}
            : { ownerFile: source.ownerFile }),
        })
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
  return { units, rowRules, diagnostics }
}

/**
 * Згенерована одиниця з тексту одного оператора: клас, ідентичність і дерево
 * дає той самий `classify`, що й дослівним одиницям, тож простір
 * ідентичностей у них спільний і дослівна копія не перекриє згенеровану
 * мовчки. Текст будує компілятор, тож збій розбору чи недозволений оператор —
 * дефект генератора, а не метаданих. Типи аргументів — лише вбудовані.
 */
export function generatedUnit(
  sql: string,
  schema: string,
  parse: SqlParser
): Pick<SqlUnit, "class" | "identity" | "schema" | "name" | "sql" | "tree"> {
  const parsed = parse(sql)
  const statement =
    parsed.ok && parsed.statements.length === 1
      ? parsed.statements[0]!.stmt
      : undefined
  const classified =
    statement === undefined
      ? undefined
      : classify(statement, { schema, types: new Map() })
  if (
    statement === undefined ||
    classified === undefined ||
    !("class" in classified)
  ) {
    throw new Error(`internal: generated SQL does not form a unit: ${sql}`)
  }
  return {
    class: classified.class,
    identity: classified.identity,
    schema: classified.schema,
    name: classified.name,
    sql,
    tree: withoutLocations(statement),
  }
}

/** Простір імен каталогу Postgres: `pg_proc`, `pg_class`, `pg_type`. */
export type PgSpace = "proc" | "rel" | "type"

/**
 * Ім'я, яке об'єкт займає в просторі `space`: `schema` і `name` — для
 * посилань (порядок створення), `key` — для конфліктів; у `pg_proc` ключ
 * несе канонічні типи аргументів.
 */
export interface PgName {
  space: PgSpace
  schema: string
  name: string
  key: string
}

/** Об'єкт моделі чи SQL-одиниця, що створює імена в каталозі Postgres. */
export type PgObject =
  | {
      type: "unit"
      unit: Pick<SqlUnit, "class" | "identity" | "schema" | "name">
    }
  | { type: "table"; table: PhysicalTable }
  | { type: "enumType"; schema: string; name: string }

/**
 * Імена об'єкта в просторах Postgres (спека П2 §8.3) — одне джерело для
 * конфліктів і для посилань порядку створення. Таблиця й в'юха — ще й
 * складений тип; індекси таблиці (разом з індексами первинного ключа й
 * UNIQUE) і послідовності її identity-колонок ділять із нею `pg_class`.
 * Решта класів одиниць імен у цих просторах не створює.
 */
export function pgNamespaceKeys(object: PgObject): PgName[] {
  const at = (space: PgSpace, schema: string, name: string): PgName => ({
    space,
    schema,
    name,
    key: `${schema}.${name}`,
  })
  if (object.type === "enumType") {
    return [at("type", object.schema, object.name)]
  }
  if (object.type === "table") {
    const { schema, name, columns, indexes, primaryKey, uniques } = object.table
    return [
      at("rel", schema, name),
      at("type", schema, name),
      ...[
        ...indexes.map((index) => index.name),
        ...(primaryKey === undefined ? [] : [primaryKey.name]),
        ...uniques.map((unique) => unique.name),
        ...columns.flatMap((column) =>
          column.identity === undefined ? [] : [column.identity.sequence]
        ),
      ].map((relation) => at("rel", schema, relation)),
    ]
  }
  const { unit } = object
  const { schema, name } = unit
  if (FUNCTION_CLASSES.has(unit.class)) {
    // Ключ — сигнатура з ідентичності: канонізація типів аргументів одна.
    // Агрегат `(*)` у `pg_proc` — без аргументів.
    const signature = unit.identity.slice(unit.identity.indexOf(":") + 1)
    return [
      {
        space: "proc",
        schema,
        name,
        key: signature.endsWith("(*)")
          ? `${signature.slice(0, -3)}()`
          : signature,
      },
    ]
  }
  if (unit.class === "view" || unit.class === "materializedView") {
    return [at("rel", schema, name), at("type", schema, name)]
  }
  if (unit.class === "sequence") return [at("rel", schema, name)]
  if (unit.class === "domain") return [at("type", schema, name)]
  return []
}

/**
 * Конфлікти імен у просторах Postgres (спека П2 §8.3) над таблицями й
 * енам-типами моделі, згенерованими й дослівними одиницями. Тотожна
 * ідентичність будь-якого класу — `sql.unit-duplicate`, різні класи з одним
 * ключем — `sql.namespace-conflict`. Першим вважається об'єкт моделі чи
 * згенерована одиниця (їх породжує модель), далі одиниці за файлом і рядком; помилку отримує
 * дослівна одиниця. Збіги лише між об'єктами моделі тут не звітуються: до
 * цієї перевірки їх уже відсіяла стадія 4 (`physical.table-duplicate` для
 * таблиць і енам-типів, `physical.relation-duplicate` для явних імен
 * індексів і ключів, `physical.function-duplicate` для обгорток), а похідні
 * імена обходять зайняті (`assignNames`). `describe` — опис згенерованої
 * одиниці для `sql.unit-duplicate`.
 */
export function namespaceConflicts(
  physical: Pick<PhysicalSnapshot, "tables" | "enumTypes">,
  units: readonly SqlUnit[],
  describe: (unit: SqlUnit) => string
): Diagnostic[] {
  interface Holder {
    label: string
    unit?: SqlUnit
    names: PgName[]
  }
  const generated: Holder[] = [
    ...physical.enumTypes.map((type) => ({
      label: `enumType:${type.schema}.${type.name}`,
      names: pgNamespaceKeys({ type: "enumType", ...type }),
    })),
    ...physical.tables.map((table) => ({
      label: `table:${table.schema}.${table.name}`,
      names: pgNamespaceKeys({ type: "table", table }),
    })),
    ...units
      .filter((unit) => unit.file === undefined)
      .map((unit) => ({
        label: unit.identity,
        unit,
        names: pgNamespaceKeys({ type: "unit", unit }),
      })),
  ].sort((a, b) => compareStrings(a.label, b.label))
  const verbatim: Holder[] = units
    .filter((unit) => unit.file !== undefined)
    .sort(
      (a, b) =>
        compareStrings(a.file!, b.file!) ||
        (a.line ?? 0) - (b.line ?? 0) ||
        compareStrings(a.identity, b.identity)
    )
    .map((unit) => ({
      label: unit.identity,
      unit,
      names: pgNamespaceKeys({ type: "unit", unit }),
    }))

  const first = new Map<string, Holder>()
  const diagnostics: Diagnostic[] = []
  for (const holder of [...generated, ...verbatim]) {
    const reported = new Set<Holder>()
    // Тотожна ідентичність — дублікат і для класів без простору імен
    // (тригер, грант, політика): інакше дослівна копія згенерованої одиниці
    // мовчки стала б другим вузлом з тим самим ключем.
    const slots = [
      ...holder.names.map((name) => ({
        slot: `${name.space}\0${name.key}`,
        name,
      })),
      ...(holder.unit === undefined
        ? []
        : [{ slot: `unit\0${holder.unit.identity}`, name: undefined }]),
    ]
    for (const { slot, name } of slots) {
      const earlier = first.get(slot)
      if (earlier === undefined) {
        first.set(slot, holder)
        continue
      }
      const unit = holder.unit
      if (unit?.file === undefined || earlier === holder) continue
      if (reported.has(earlier)) continue
      reported.add(earlier)
      if (earlier.unit?.identity === unit.identity) {
        diagnostics.push(
          diagnostic("sql.unit-duplicate", unit.file, "", {
            identity: unit.identity,
            line: unit.line ?? 0,
            first:
              earlier.unit.file === undefined
                ? describe(earlier.unit)
                : `${earlier.unit.file}:${earlier.unit.line ?? 0}`,
          })
        )
      } else if (name !== undefined) {
        // Слот ідентичності збігається лише за тотожної ідентичності, тож
        // різні класи в одному просторі — завжди слот імені.
        diagnostics.push(
          diagnostic("sql.namespace-conflict", unit.file, "", {
            identity: unit.identity,
            line: unit.line ?? 0,
            space: name.space,
            key: name.key,
            other: earlier.label,
          })
        )
      }
    }
  }
  return diagnostics
}

function duplicate(unit: VerbatimUnit, first: string): Diagnostic {
  return diagnostic("sql.unit-duplicate", unit.file, "", {
    identity: unit.identity,
    line: unit.line,
    first,
  })
}

const LOCATION_KEYS = new Set(["location", "stmt_location", "stmt_len"])

/**
 * Дерево без позицій: однаковий зміст з іншим форматуванням дає те саме
 * дерево. Межа хешу: відкидає лише позиції; вміст рядкових літералів,
 * зокрема тіло `$$…$$`, лишається дослівно — спека §8.3.
 */
export function withoutLocations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutLocations)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !LOCATION_KEYS.has(key))
      .map(([key, child]) => [key, withoutLocations(child)])
  )
}

/**
 * Ідентичність обгортки — той самий простір, що й у функцій користувача.
 * Аргументи обгортки — типи каталогу, тож типи моделі їй не потрібні.
 */
export function functionIdentity(
  schema: string,
  name: string,
  argTypes: readonly (TypeName | undefined)[]
): string {
  return `function:${signature(name, argTypes, { schema, types: new Map() })}`
}

/** Типи вхідних аргументів `CREATE FUNCTION`/`PROCEDURE` — те, що входить в ідентичність. */
export function inputArgumentTypes(
  node: CreateFunctionStmt
): (TypeName | undefined)[] {
  return (node.parameters ?? [])
    .map((p) => ("FunctionParameter" in p ? p.FunctionParameter : {}))
    .filter(isInputParameter)
    .map((p) => p.argType)
}

/**
 * `schema.name(типи)` — типи аргументів у канонічній формі (спека П2 §8.3);
 * `scope.schema` — схема функції й некваліфікованих імен.
 */
function signature(
  name: string,
  argTypes: readonly (TypeName | undefined)[],
  scope: TypeScope
): string {
  const types = argTypes.map((t) => typeName(t, scope)).join(",")
  return `${scope.schema}.${name}(${types})`
}

/** Типи, які знає модель (енам-типи й таблиці знімка, домени й в'юхи `.sql`): ім'я → схеми. */
type ModelTypes = ReadonlyMap<string, readonly string[]>

/** Де читається некваліфікований тип: схема одиниці й типи моделі. */
interface TypeScope {
  schema: string
  types: ModelTypes
}

function modelTypes(
  types: readonly { schema: string; name: string }[]
): ModelTypes {
  const schemas = new Map<string, string[]>()
  for (const { schema, name } of types) {
    const list = schemas.get(name) ?? []
    if (!list.includes(schema)) list.push(schema)
    schemas.set(name, list)
  }
  for (const list of schemas.values()) list.sort(compareStrings)
  return schemas
}

type Classified =
  | { class: SqlUnitClass; identity: string; schema: string; name: string }
  | { rowRule: Pick<RowRule, "schema" | "table" | "name" | "expr"> }
  | {
      notAllowed: string
      detail?: string
      feature?: "rowLevelSecurity" | "publication"
    }

/**
 * Одиниця чи правило рядка діє в схемі платформи: її власний об'єкт (функція,
 * в'юха, тригер чи політика на таблиці, `ALTER` таблиці чи функції) або ціль
 * гранту, коментаря, publication, типових привілеїв лежить у `simetra`.
 */
function reservesPlatformSchema(
  classified: Exclude<Classified, { notAllowed: string }>,
  stmt: Node,
  schema: string
): boolean {
  const own = "rowRule" in classified ? classified.rowRule : classified
  return (
    own.schema === PLATFORM_SCHEMA ||
    statementTargets(stmt, schema).some((t) => t.schema === PLATFORM_SCHEMA)
  )
}

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
function classify(stmt: Node, scope: TypeScope): Classified {
  const { schema } = scope
  const statement = Object.keys(stmt)[0] ?? "unknown"
  const unit = (
    cls: SqlUnitClass,
    qualified: { schema: string; name: string },
    key: string
  ): Classified => ({ class: cls, identity: `${cls}:${key}`, ...qualified })

  if ("CreateFunctionStmt" in stmt) {
    const node = stmt.CreateFunctionStmt
    const fn = qualify(strings(node.funcname), schema)
    const cls = node.is_procedure === true ? "procedure" : "function"
    return unit(
      cls,
      fn,
      signature(fn.name, inputArgumentTypes(node), {
        ...scope,
        schema: fn.schema,
      })
    )
  }
  if ("DefineStmt" in stmt && stmt.DefineStmt.kind === "OBJECT_AGGREGATE") {
    const node = stmt.DefineStmt
    const fn = qualify(strings(node.defnames), schema)
    const list = node.args?.[0]
    // Без списку аргументів — агрегат `(*)`.
    const key =
      list !== undefined && "List" in list
        ? signature(
            fn.name,
            (list.List.items ?? []).map((p) =>
              "FunctionParameter" in p ? p.FunctionParameter.argType : undefined
            ),
            { ...scope, schema: fn.schema }
          )
        : `${fn.schema}.${fn.name}(*)`
    return unit("aggregate", fn, key)
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
    // `ALL … IN SCHEMA` — разова дія над наявними об'єктами, а не стан
    // каталогу: каталог тримає гранти поштучно, зворотна генерація такої
    // форми не пише.
    if (node.targtype === "ACL_TARGET_ALL_IN_SCHEMA") {
      return { notAllowed: statement, detail: "allInSchema" }
    }
    const objects = sorted(
      (node.objects ?? []).map((o) => targetName(o, node.objtype, scope))
    ).join(",")
    return unit(
      "grant",
      { schema: "", name: objects },
      [
        node.is_grant === true ? "grant" : "revoke",
        objectType(node.objtype),
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
    const role = sorted(option("roles").map((r) => nodeText(r))).join(",")
    const action = node.action ?? {}
    return unit(
      "defaultPrivileges",
      { schema: "", name: role },
      [
        role,
        sorted(option("schemas").map((s) => nodeText(s))).join(","),
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
        : targetName(node.object, node.objtype, scope)
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
  if ("CreatePublicationStmt" in stmt) {
    // Саму публікацію створює провайдер; `.sql` лише керує членством у ній.
    return { notAllowed: statement, feature: "publication" }
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
    const rule = rowRuleOf(node)
    if (rule !== undefined) {
      if (rule.name === undefined) {
        return { notAllowed: statement, detail: "rowRuleName" }
      }
      const table = relation(node.relation, schema)
      return {
        rowRule: {
          schema: table.schema,
          table: table.name,
          name: rule.name,
          expr: rule.expr,
        },
      }
    }
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
      functionObject(fn, scope)
    )
  }
  return { notAllowed: statement }
}

/**
 * Рівно одна підкоманда `ADD CONSTRAINT … CHECK` — форма правила рядка; інші
 * підкоманди поруч зробили б оператор сумішшю правила й дослівної зміни
 * таблиці. `NOT VALID` і `NO INHERIT` не входять: знімок тримає перевірені
 * обмеження без успадкування, тож такий оператор лишається забороненим.
 */
function rowRuleOf(node: {
  objtype?: string
  cmds?: Node[]
}): { name: string | undefined; expr: Node } | undefined {
  const cmds = node.cmds ?? []
  if (node.objtype !== "OBJECT_TABLE" || cmds.length !== 1) return undefined
  const cmd = "AlterTableCmd" in cmds[0]! ? cmds[0].AlterTableCmd : undefined
  const def = cmd?.def
  if (cmd?.subtype !== "AT_AddConstraint" || def === undefined) return undefined
  if (!("Constraint" in def)) return undefined
  const constraint = def.Constraint
  if (
    constraint.contype !== "CONSTR_CHECK" ||
    constraint.raw_expr === undefined ||
    constraint.skip_validation === true ||
    constraint.is_no_inherit === true
  ) {
    return undefined
  }
  return { name: constraint.conname, expr: constraint.raw_expr }
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

/**
 * Вбудовані типи Postgres 17 (`pg_catalog`), які пишуть без схеми. Лише за
 * ними `_x` читається як масив `x[]`: ім'я `_item` користувача — просто ім'я
 * (масив його типу Postgres перейменовує на `__item`, коли `_item` зайняте);
 * і лише вони не резолвляться в однойменний тип моделі — `pg_catalog`
 * неявно першим у `search_path`.
 */
const CATALOG_TYPES: ReadonlySet<string> = new Set([
  "aclitem",
  "bit",
  "bool",
  "box",
  "bpchar",
  "bytea",
  "char",
  "cid",
  "cidr",
  "circle",
  "cstring",
  "date",
  "datemultirange",
  "daterange",
  "float4",
  "float8",
  "gtsvector",
  "inet",
  "int2",
  "int2vector",
  "int4",
  "int4multirange",
  "int4range",
  "int8",
  "int8multirange",
  "int8range",
  "interval",
  "json",
  "jsonb",
  "jsonpath",
  "line",
  "lseg",
  "macaddr",
  "macaddr8",
  "money",
  "name",
  "numeric",
  "nummultirange",
  "numrange",
  "oid",
  "oidvector",
  "path",
  "pg_lsn",
  "pg_snapshot",
  "point",
  "polygon",
  "record",
  "refcursor",
  "regclass",
  "regcollation",
  "regconfig",
  "regdictionary",
  "regnamespace",
  "regoper",
  "regoperator",
  "regproc",
  "regprocedure",
  "regrole",
  "regtype",
  "text",
  "tid",
  "time",
  "timestamp",
  "timestamptz",
  "timetz",
  "tsmultirange",
  "tsquery",
  "tsrange",
  "tstzmultirange",
  "tstzrange",
  "tsvector",
  "txid_snapshot",
  "uuid",
  "varbit",
  "varchar",
  "xid",
  "xid8",
  "xml",
])

/**
 * Тип у канонічній формі Postgres (спека П2 §8.3): одне написання на один тип
 * `pg_type`, інакше один об'єкт `pg_proc` мав би дві ідентичності. Синоніми
 * зводить до внутрішніх імен сама граматика (`integer` → `pg_catalog.int4`,
 * `character varying` → `pg_catalog.varchar`), тож лишається прибрати
 * `pg_catalog.`, модифікатор типу (`varchar(10)` — той самий тип) і
 * кількість вимірів масиву; ім'я масиву каталогу `_int4` — те саме, що
 * `int4[]`. Некваліфікований тип моделі бере її схему: єдину, а з кількох —
 * схему одиниці; невідомий моделі (типи розширень) лишається як є. Тип з
 * іншої схеми лишається кваліфікованим як є.
 */
function typeName(type: TypeName | undefined, scope: TypeScope): string {
  if (type === undefined) return ""
  const names = strings(type.names)
  if (type.pct_type === true) return `${names.join(".")}%type`
  const array = (type.arrayBounds?.length ?? 0) > 0 ? "[]" : ""
  const [first, second] = names
  if (names.length === 2 && first === "pg_catalog") {
    return catalogType(second!, array)
  }
  if (names.length !== 1) return names.join(".") + array
  const name = first!
  if (
    CATALOG_TYPES.has(name) ||
    (name.startsWith("_") && CATALOG_TYPES.has(name.slice(1)))
  ) {
    return catalogType(name, array)
  }
  const schemas = scope.types.get(name) ?? []
  if (schemas.length === 0) return name + array
  const schema = schemas.length === 1 ? schemas[0]! : scope.schema
  return `${schema}.${name}${array}`
}

/** Тип каталогу без схеми; `_x` — масив `x[]`. */
function catalogType(name: string, array: string): string {
  return name.length > 1 && name.startsWith("_")
    ? `${name.slice(1)}[]`
    : name + array
}

function functionObject(fn: ObjectWithArgs, scope: TypeScope): string {
  const { schema, name } = qualify(strings(fn.objname), scope.schema)
  if (fn.args_unspecified === true) return `${schema}.${name}`
  return signature(
    name,
    (fn.objargs ?? []).map((a) => ("TypeName" in a ? a.TypeName : undefined)),
    { ...scope, schema }
  )
}

/**
 * Ім'я вузла, що не є ціллю з `TARGET_PARTS`: схема, роль. Типи й функції
 * сюди не доходять — їх розбирає `targetName`.
 */
function nodeText(node: Node): string {
  if ("String" in node) return node.String.sval ?? ""
  if ("RoleSpec" in node) return role(node.RoleSpec)
  if ("List" in node) return strings(node.List.items).join(".")
  return ""
}

/**
 * Скільки частин має повне ім'я цілі гранту чи коментаря: бракує — додається
 * схема (спека П2 §8.3).
 */
const TARGET_PARTS: Readonly<Record<string, number>> = {
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
  OBJECT_DOMCONSTRAINT: 3,
}

/**
 * Частини імені цілі гранту чи коментаря як у тексті. Обмеження домену —
 * список із `TypeName` домену та іменем обмеження: `TypeName` розгорнуто.
 */
export function targetParts(node: Node): string[] {
  if ("List" in node) return (node.List.items ?? []).flatMap(targetParts)
  if ("TypeName" in node) return strings(node.TypeName.names)
  if ("String" in node) return [node.String.sval ?? ""]
  return []
}

/**
 * Ціль гранту чи коментаря: відношення й функції кваліфіковано, типи — за
 * правилом типів аргументів, решту імен — за `TARGET_PARTS`.
 */
function targetName(
  node: Node,
  objtype: string | undefined,
  scope: TypeScope
): string {
  const { schema } = scope
  if ("RangeVar" in node) {
    const { schema: s, name } = relation(node.RangeVar, schema)
    return `${s}.${name}`
  }
  if ("ObjectWithArgs" in node)
    return functionObject(node.ObjectWithArgs, scope)
  // Типи — за тим самим правилом, що й типи аргументів: вбудований — без
  // схеми (`pg_catalog` відкидається), відомий моделі — зі схемою, інший
  // лишається як є.
  if (objtype === "OBJECT_CAST" && "List" in node) {
    // Межа між двома типами — частина ідентичності: `(a.b AS c)` ≠ `(a AS b.c)`.
    return (node.List.items ?? [])
      .map(
        (item) =>
          `(${"TypeName" in item ? typeName(item.TypeName, scope) : ""})`
      )
      .join(".")
  }
  if (objtype === "OBJECT_DOMCONSTRAINT" && "List" in node) {
    const [domain, constraint] = node.List.items ?? []
    if (domain !== undefined && "TypeName" in domain) {
      return `${typeName(domain.TypeName, scope)}.${strings(constraint ? [constraint] : [])[0] ?? ""}`
    }
  }
  if (objtype === "OBJECT_TYPE" || objtype === "OBJECT_DOMAIN") {
    if ("TypeName" in node) return typeName(node.TypeName, scope)
    if ("List" in node) {
      return typeName({ names: node.List.items }, scope)
    }
  }
  const parts =
    "List" in node || "TypeName" in node || "String" in node
      ? targetParts(node)
      : [nodeText(node)]
  const expected = TARGET_PARTS[objtype ?? ""]
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
