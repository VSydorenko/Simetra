import {
  PLATFORM_SCHEMA,
  RIGHTS_COLUMNS,
  USER_PLATFORM_COLUMNS,
  ZERO_UUID,
  keyColumn,
  quoteIdent,
  type AttributeCase,
  type DatabaseProvider,
  type ObjectTable,
  type PhysicalSnapshot,
  type PhysicalTable,
} from "simetra/model"
import { qualified, type Contracts, type QualifiedName } from "../contracts"
import { compareStrings } from "../diagnostics"
import type { CreationNode } from "../sql/dependencies"
import { executeGrants } from "../sql/execute-grants"
import type { SqlParser } from "../sql/parse"
import { generatedUnit, type SqlUnit } from "../sql/units"
import { SIGNAL_FUNCTIONS } from "../signal/names"
import type { ParsedObject } from "../stages/files"
import { standardColumn } from "../standard-column"
import type { SnapshotFact } from "./actor-snapshot"
import { definerTrigger } from "./definer"
import { uuidLiteral } from "./functions"
import { triggeredRelationTable } from "./relation-table"
import {
  rightsSignalFunctionName,
  rightsSignalTriggerNames,
  type RightsSignalOperation,
} from "./signal-names"
import type { SnapshotSources } from "./snapshot-sources"

export type RightsSignalContracts = Pick<
  Contracts,
  | "rightsCatalogs"
  | "membership"
  | "membershipSources"
  | "users"
  | "accessDimensions"
  | "rights"
>

export interface RightsSignalInput {
  contracts: RightsSignalContracts
  physical: PhysicalSnapshot
  objects: readonly Pick<ParsedObject, "id" | "kind">[]
  sources: Pick<SnapshotSources, "sources">
  attributeCase: AttributeCase
  provider: DatabaseProvider
  module: string
  parse: SqlParser
}

/**
 * Чому таблиця фактів тригера сигналу прав не має: `verbatimFunction` — її
 * читає лише дослівна функція (Т2); `adoptedOnly` — форма відома, але її
 * факти доходять до прав лише через прийняті джерела (контейнер без
 * довідників прав моделі), а ті свіжіють за інтервалом.
 */
export type RightsSignalExemptReason = "verbatimFunction" | "adoptedOnly"

export interface RightsSignals {
  units: SqlUnit[]
  /** Таблиці фактів, на яких тригера свідомо немає; за `(schema, name)`. */
  exempt: { table: QualifiedName; reason: RightsSignalExemptReason }[]
  /**
   * Таблиці фактів, які генерований код читає, але жодна відома форма не
   * каже, кому слати сигнал, — помилка компілятора (fail-closed).
   */
  unknown: { table: QualifiedName; facts: readonly SnapshotFact[] }[]
}

type Alias = "o" | "n"
const FROM: Record<Alias, string> = { o: "old_rows o", n: "new_rows n" }
const TRANSITION: Record<RightsSignalOperation, string> = {
  INSERT: "REFERENCING NEW TABLE AS new_rows",
  UPDATE: "REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows",
  DELETE: "REFERENCING OLD TABLE AS old_rows",
}
// Старі й нові рядки (П4-B §8.2): переміщення між скоупами чи зміна
// користувача сповіщає обидва боки.
const ROWS: Record<RightsSignalOperation, readonly Alias[]> = {
  INSERT: ["n"],
  UPDATE: ["o", "n"],
  DELETE: ["o"],
}

const q = quoteIdent
const ZERO = uuidLiteral(ZERO_UUID)
const KEY = keyColumn(false)

/**
 * Канали однієї зміни: `scopes` — запити рядків `(scope_kind, scope)` для
 * `signal_rights`, `users` — рядків `(user_id)` для `signal_user_rights`.
 */
interface Channels {
  scopes: string[]
  users: string[]
}

/** Форма таблиці фактів: з неї тригер знає, кому слати сигнал. */
interface Shape {
  channels: (operation: RightsSignalOperation) => Channels
  /** Таблиці, які тіло читає, крім таблиць переходу, — ребра `requires`. */
  reads: QualifiedName[]
}

const nameOf = (table: { schema: string; name: string }): QualifiedName => ({
  schema: table.schema,
  name: table.name,
})
const keyOf = (table: { schema: string; name: string }) =>
  `${table.schema}.${table.name}`

function tableOf(
  physical: PhysicalSnapshot,
  name: QualifiedName
): PhysicalTable {
  const found = physical.tables.find(
    (t) => t.schema === name.schema && t.name === name.name
  )
  if (found === undefined)
    throw new Error(`internal: missing rights table ${qualified(name)}`)
  return found
}

function scopeColumnOf(table: PhysicalTable): string | undefined {
  return table.columns.find((c) => c.origin.scopeKindId !== undefined)?.name
}

/**
 * Користувачі учасників виду скоупу: довідник членства й прийняте джерело
 * членства. Прийняту таблицю тригер лише читає — тригера на ній немає (спека
 * прав §4.7); умову рядків джерела не звужує: зайвий сигнал безпечний.
 */
function memberUsers(
  contracts: RightsSignalContracts,
  scopeKindId: string,
  from: string,
  subject: string
): { selects: string[]; reads: QualifiedName[] } {
  const members = [
    ...contracts.membership
      .filter((m) => m.scopeKindId === scopeKindId)
      .map((m) => ({ table: m.table, key: m.keyColumn, user: m.userColumn })),
    ...contracts.membershipSources
      .filter((m) => m.scopeKindId === scopeKindId)
      .map((m) => ({ table: m.table, key: m.member, user: m.user })),
  ]
  if (members.length === 0)
    throw new Error(`internal: no members of scope kind ${scopeKindId}`)
  return {
    selects: members.map(
      (m) =>
        `SELECT m.${q(m.user)} AS user_id FROM ${from} JOIN ${qualified(m.table)} m ON m.${q(m.key)} = ${subject}`
    ),
    reads: members.map((m) => m.table),
  }
}

/** Визначення ролі чи дельти: канал скоупу рядка, глобального — глобальний. */
function definitionShape(
  table: PhysicalTable,
  level: Contracts["rightsCatalogs"][number]["level"]
): Shape {
  const scope = level.level === "scope" ? scopeColumnOf(table) : undefined
  if (level.level === "scope" && scope === undefined)
    throw new Error(`internal: rights table ${table.name} has no scope column`)
  return {
    reads: [],
    channels: (operation) => ({
      scopes: ROWS[operation].map((a) =>
        level.level === "scope"
          ? `SELECT ${uuidLiteral(level.scopeKindId)} AS scope_kind, ${a}.${q(scope!)} AS scope FROM ${FROM[a]}`
          : `SELECT ${ZERO} AS scope_kind, ${ZERO} AS scope FROM ${FROM[a]}`
      ),
      users: [],
    }),
  }
}

/** Користувачі суб'єкта призначення каталогу прав за його рівнем. */
function assignmentUsers(
  contracts: RightsSignalContracts,
  level: Contracts["rightsCatalogs"][number]["level"],
  from: string,
  subject: string
): { selects: string[]; reads: QualifiedName[] } {
  if (level.level === "global")
    return { selects: [`SELECT ${subject} AS user_id FROM ${from}`], reads: [] }
  return memberUsers(contracts, level.scopeKindId, from, subject)
}

function shapesOf(table: ObjectTable, input: RightsSignalInput): Shape[] {
  const { contracts, physical, attributeCase } = input
  const same = (name: QualifiedName) =>
    name.schema === table.schema && name.name === table.name
  const shapes: Shape[] = []
  for (const catalog of contracts.rightsCatalogs) {
    if (same(catalog.roles.table) || same(catalog.roles.delta))
      shapes.push(definitionShape(table, catalog.level))
    if (same(catalog.assignments.table)) {
      const subject = standardColumn(
        table,
        RIGHTS_COLUMNS.subject,
        attributeCase
      ).name
      const reads: QualifiedName[] = []
      shapes.push({
        reads,
        channels: (operation) => ({
          scopes: [],
          users: ROWS[operation].flatMap((a) => {
            const found = assignmentUsers(
              contracts,
              catalog.level,
              FROM[a],
              `${a}.${q(subject)}`
            )
            reads.push(...found.reads)
            return found.selects
          }),
        }),
      })
    }
  }
  for (const member of contracts.membership.filter((m) => same(m.table))) {
    shapes.push({
      reads: [],
      channels: (operation) => ({
        scopes: [],
        users: ROWS[operation].map(
          (a) =>
            `SELECT ${a}.${q(member.userColumn)} AS user_id FROM ${FROM[a]}`
        ),
      }),
    })
  }
  const users = contracts.users
  if (users !== undefined && same(users.table)) {
    const key = q(users.keyColumn)
    const invalid = q(users.invalidColumn)
    const kind = q(
      standardColumn(table, USER_PLATFORM_COLUMNS.userKind, attributeCase).name
    )
    // Лише недійсність і вид користувача змінюють його дієві права; нова
    // вставка прав не дає, видалення знімає членство своїми тригерами.
    shapes.push({
      reads: [],
      channels: (operation) => ({
        scopes: [],
        users:
          operation === "UPDATE"
            ? [
                `SELECT n.${key} AS user_id FROM old_rows o JOIN new_rows n ON n.${key} = o.${key} WHERE o.${invalid} IS DISTINCT FROM n.${invalid} OR o.${kind} IS DISTINCT FROM n.${kind}`,
              ]
            : [],
      }),
    })
  }
  for (const dimension of contracts.accessDimensions) {
    if (!("relation" in dimension.values)) continue
    const { relation } = dimension.values
    const found = triggeredRelationTable(relation, physical, input.objects)
    if (found === undefined || !same(found)) continue
    const target = relation.subjectTarget
    const reads: QualifiedName[] = []
    shapes.push({
      reads,
      channels: (operation) => ({
        scopes: [],
        users: ROWS[operation].flatMap((a) => {
          const subject = `${a}.${q(relation.subject)}`
          if ("users" in target)
            return [`SELECT ${subject} AS user_id FROM ${FROM[a]}`]
          const users = memberUsers(
            contracts,
            target.membership,
            FROM[a],
            subject
          )
          reads.push(...users.reads)
          return users.selects
        }),
      }),
    })
  }
  for (const contract of contracts.rights.filter(
    (r) => r.container === true && same(r.table)
  )) {
    shapes.push(containerShape(table, contract.scopeKindId, input))
  }
  return shapes
}

/**
 * Контейнер прав (Т1): права дають призначення рівня контейнера моделі, тож
 * поява й зникнення рядка контейнера чи зміна його носія скоупу змінюють
 * права їхніх суб'єктів. Прийняті джерела призначень сигналу не мають
 * (§4.7, межа `adoptedFacts`).
 */
function containerShape(
  table: ObjectTable,
  scopeKindId: string | undefined,
  input: RightsSignalInput
): Shape {
  const { contracts, physical, attributeCase } = input
  const key = q(standardColumn(table, KEY, attributeCase).name)
  const scope = scopeKindId === undefined ? undefined : scopeColumnOf(table)
  const changed = (operation: RightsSignalOperation): string | undefined => {
    if (operation === "INSERT")
      return `SELECT n.${key} AS container FROM new_rows n`
    if (operation === "DELETE")
      return `SELECT o.${key} AS container FROM old_rows o`
    if (scope === undefined) return undefined
    return `SELECT n.${key} AS container FROM old_rows o JOIN new_rows n ON n.${key} = o.${key} WHERE o.${q(scope)} IS DISTINCT FROM n.${q(scope)}`
  }
  const reads: QualifiedName[] = []
  return {
    reads,
    channels: (operation) => {
      const containers = changed(operation)
      if (containers === undefined) return { scopes: [], users: [] }
      return {
        scopes: [],
        users: contracts.rightsCatalogs.flatMap((catalog) => {
          const assignments = tableOf(physical, catalog.assignments.table)
          const subject = standardColumn(
            assignments,
            RIGHTS_COLUMNS.subject,
            attributeCase
          ).name
          const container = standardColumn(
            assignments,
            RIGHTS_COLUMNS.container,
            attributeCase
          ).name
          reads.push(catalog.assignments.table)
          const users = assignmentUsers(
            contracts,
            catalog.level,
            `(${containers}) c JOIN ${qualified(catalog.assignments.table)} a ON a.${q(container)} = c.container`,
            `a.${q(subject)}`
          )
          reads.push(...users.reads)
          return users.selects
        }),
      }
    },
  }
}

/** Виклики сигналів однієї події: `DISTINCT` на оператор, без `NULL`. */
function callsOf(channels: Channels): string[] {
  const union = (selects: readonly string[]) => selects.join(" UNION ALL ")
  return [
    ...(channels.scopes.length === 0
      ? []
      : [
          `PERFORM ${qualified(SIGNAL_FUNCTIONS.rights)}(s.scope_kind, s.scope) FROM (SELECT DISTINCT r.scope_kind, r.scope FROM (${union(channels.scopes)}) r WHERE r.scope IS NOT NULL) s;`,
        ]),
    ...(channels.users.length === 0
      ? []
      : [
          `PERFORM ${qualified(SIGNAL_FUNCTIONS.userRights)}(s.user_id) FROM (SELECT DISTINCT r.user_id FROM (${union(channels.users)}) r WHERE r.user_id IS NOT NULL) s;`,
        ]),
  ]
}

/**
 * Тригери сигналу прав (спека П4-B §8.2, Р9): AFTER-тригер оператора з
 * таблицями переходу на кожну модельну таблицю фактів з аналізу джерел
 * знімка. Функція — `SECURITY DEFINER` від власника з `row_security = off`:
 * рядок outbox пише власник, для якого outbox без `FORCE` політики не судить,
 * а форму перевіряють самі `signal_rights`/`signal_user_rights`. Без функцій
 * прав сигнальних функцій немає — і тригерів теж.
 */
export function buildRightsSignalUnits(
  input: RightsSignalInput
): RightsSignals {
  const units: SqlUnit[] = []
  const exempt: RightsSignals["exempt"] = []
  const unknown: RightsSignals["unknown"] = []
  const add = (
    sql: string,
    owner: string,
    requires?: readonly CreationNode[]
  ) =>
    units.push({
      ...generatedUnit(sql, PLATFORM_SCHEMA, input.parse),
      module: input.module,
      generator: "rightsSignal",
      ownerObjectId: owner,
      ...(requires === undefined ? {} : { requires }),
    })
  for (const source of input.sources.sources) {
    const { table } = source
    const shapes = shapesOf(table, input)
    if (shapes.length === 0) {
      // Т2: чий факт змінився, знає лише тіло дослівної функції — свіжість
      // за інтервалом; Т3: невідома форма генерованого читання — помилка.
      if (source.verbatimOnly)
        exempt.push({ table: nameOf(table), reason: "verbatimFunction" })
      else unknown.push({ table: nameOf(table), facts: source.facts })
      continue
    }
    const operations = (["INSERT", "UPDATE", "DELETE"] as const).flatMap(
      (operation) => {
        const channels = shapes.map((shape) => shape.channels(operation))
        const calls = callsOf({
          scopes: channels.flatMap((c) => c.scopes),
          users: channels.flatMap((c) => c.users),
        })
        return calls.length === 0 ? [] : [{ operation, calls }]
      }
    )
    if (operations.length === 0) {
      exempt.push({ table: nameOf(table), reason: "adoptedOnly" })
      continue
    }
    const owner = table.origin.objectId
    const fn = rightsSignalFunctionName(table)
    const body = [
      "BEGIN",
      ...operations.map(
        ({ operation, calls }, index) =>
          `  ${index === 0 ? "IF" : "ELSIF"} TG_OP = '${operation}' THEN\n${calls.map((c) => `    ${c}`).join("\n")}`
      ),
      "  END IF;",
      "  RETURN NULL;",
      "END",
    ].join("\n")
    const reads = [
      ...new Map(
        shapes.flatMap((s) => s.reads).map((t) => [keyOf(t), t])
      ).values(),
    ]
    add(definerTrigger(fn, body, { rowSecurity: "off" }), owner, [
      {
        type: "unit",
        identity: `function:${qualified(SIGNAL_FUNCTIONS.rights)}(uuid,uuid)`,
      },
      {
        type: "unit",
        identity: `function:${qualified(SIGNAL_FUNCTIONS.userRights)}(uuid)`,
      },
      ...reads.map((t) => ({ type: "table" as const, ...t })),
    ])
    for (const sql of executeGrants(`${qualified(fn)}()`, [], input.provider))
      add(sql, owner)
    const names = rightsSignalTriggerNames(table)
    for (const { operation } of operations) {
      const trigger = names.find((n) => n.operation === operation)!.trigger
      add(
        `CREATE TRIGGER ${q(trigger)} AFTER ${operation} ON ${qualified(nameOf(table))} ${TRANSITION[operation]} FOR EACH STATEMENT EXECUTE FUNCTION ${qualified(fn)}();`,
        owner
      )
    }
  }
  return {
    units: units.sort((a, b) => compareStrings(a.identity, b.identity)),
    exempt,
    unknown,
  }
}
