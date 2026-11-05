import {
  KIND_REGISTRY,
  PLATFORM_SCHEMA,
  type AttributeCase,
  type PhysicalSnapshot,
  type PhysicalTable,
} from "simetra/model"
import type { QualifiedName } from "../contracts"
import { compareStrings } from "../diagnostics"
import type { ReferencedName } from "../sql/dependencies"
import type { SqlParser } from "../sql/parse"
import type { PlpgsqlParser } from "../sql/plpgsql"
import { reachableUnits, relationReads } from "../sql/reads"
import { generatedUnit, type SqlUnit, type VerbatimUnit } from "../sql/units"
import type { ParsedObject } from "../stages/files"
import {
  SNAPSHOT_FACTS,
  SNAPSHOT_TABLES,
  type SnapshotFact,
} from "./actor-snapshot"
import {
  LIVE,
  RIGHTS_FUNCTIONS,
  liveInputs,
  type MineInputs,
} from "./functions"
import { fullAccessHolderRows, type GuardContracts } from "./guard-units"

/** Чому таблицю, яку читають факти, знімок не стереже тригером (Р3-6). */
export type SnapshotExemptReason =
  | "membershipSource"
  | "assignmentSource"
  | "sourceRoleTable"
  | "declared"
  | "identities"
  | "materializedView"
  | "snapshot"

export interface SnapshotSources {
  /** Таблиці виду, що живлять факти; за `(schema, name)`. */
  sources: { table: PhysicalTable; facts: readonly SnapshotFact[] }[]
  /** Відношення, які факти читають без тригера знімка; за `(schema, name)`. */
  exempt: { table: QualifiedName; reason: SnapshotExemptReason }[]
  /** Відношення, яких аналіз не класифікував, — помилка компілятора. */
  unknown: { relation: string; fact: SnapshotFact; via: string }[]
}

export interface SnapshotSourcesInput {
  contracts: GuardContracts
  physical: PhysicalSnapshot
  objects: readonly Pick<ParsedObject, "id" | "kind" | "file">[]
  /** Згенеровані функції прав, членства й платформного шару. */
  generated: readonly SqlUnit[]
  verbatim: readonly VerbatimUnit[]
  attributeCase: AttributeCase
  parse: SqlParser
  plpgsql: PlpgsqlParser
}

/**
 * Живі варіанти, з яких знімок рахує факт; факт `rights` знімок рахує не
 * варіантом, а запитами входів (`heads`).
 */
const LIVE_HEADS: Record<Exclude<SnapshotFact, "rights">, QualifiedName> = {
  scopes: RIGHTS_FUNCTIONS.myScopesLive,
  values: RIGHTS_FUNCTIONS.dimensionValuesLive,
  scopeSets: RIGHTS_FUNCTIONS.scopeSetLive,
}

const key = (name: { schema: string; name: string }) =>
  `${name.schema}.${name.name}`

/** Згенерована одиниця в формі дослівної — обхід читань їх не розрізняє. */
function asVerbatim(
  unit: Pick<
    SqlUnit,
    "class" | "identity" | "schema" | "name" | "sql" | "tree"
  > &
    Partial<Pick<SqlUnit, "file" | "line">>
): VerbatimUnit {
  return {
    class: unit.class,
    identity: unit.identity,
    schema: unit.schema,
    name: unit.name,
    file: unit.file ?? "",
    line: unit.line ?? 0,
    sql: unit.sql,
    tree: unit.tree,
  }
}

type Classified =
  | { kind: "source"; table: PhysicalTable }
  | { kind: "exempt"; table: QualifiedName; reason: SnapshotExemptReason }
  | { kind: "unknown" }

/**
 * Джерела фактів актора (спека прав §7, Р3-6) — аналізом тих самих тіл, що
 * рахують факти: замикання викликів живого варіанта факту (а для `rights` —
 * запитів входів `rights_mine` і рядків носіїв `fullAccess`) над повним переліком одиниць, бо
 * `reachableUnits` мовчки пропускає нерозв'язаний виклик. Кожне відношення
 * класифікується: таблиця виду — джерело; подання моделі прозоре;
 * матеріалізоване подання — виняток, лише коли всі його базові відношення —
 * винятки; виняток — прийняті джерела й їхні таблиці ролей, `CustomTable`,
 * `simetra.identities`, таблиці знімка. Решта — невідоме (fail-closed): тригер
 * знімка на ньому не стоїть, і зміна такого відношення змінила б факт повз
 * знімок.
 */
export function snapshotSources(input: SnapshotSourcesInput): SnapshotSources {
  const { contracts, physical, parse, plpgsql } = input
  const units = [...input.generated.map(asVerbatim), ...input.verbatim]
  const kinds = new Map(input.objects.map((o) => [o.id ?? "", o.kind]))
  const exemptTables = new Map<string, SnapshotExemptReason>()
  for (const source of contracts.membershipSources)
    exemptTables.set(key(source.table), "membershipSource")
  for (const source of contracts.assignmentSources) {
    exemptTables.set(key(source.table), "assignmentSource")
    if (
      source.roleTable !== undefined &&
      !exemptTables.has(key(source.roleTable.table))
    )
      exemptTables.set(key(source.roleTable.table), "sourceRoleTable")
  }
  const snapshotTables = new Set(Object.values(SNAPSHOT_TABLES).map(key))
  const views = units.filter(
    (u) => u.class === "view" || u.class === "materializedView"
  )

  const classifyTable = (table: PhysicalTable): Classified => {
    const name = { schema: table.schema, name: table.name }
    if (table.schema === PLATFORM_SCHEMA) {
      if (table.origin.part === "identities")
        return { kind: "exempt", table: name, reason: "identities" }
      if (snapshotTables.has(key(name)))
        return { kind: "exempt", table: name, reason: "snapshot" }
      return { kind: "unknown" }
    }
    const reason = exemptTables.get(key(name))
    if (reason !== undefined) return { kind: "exempt", table: name, reason }
    const kind = kinds.get(table.origin.objectId)
    if (kind === undefined) return { kind: "unknown" }
    if (KIND_REGISTRY[kind].declared)
      return { kind: "exempt", table: name, reason: "declared" }
    return { kind: "source", table }
  }

  // Відношення за посиланням; некваліфіковане — кожен можливий збіг, і
  // результат має сенс, лише коли кожен збіг класифіковано.
  const classify = (
    ref: ReferencedName,
    visited: ReadonlySet<string>
  ): Classified[] => {
    const matches = (candidate: { schema: string; name: string }) =>
      candidate.name === ref.name &&
      (ref.schema === undefined || candidate.schema === ref.schema)
    const tables = physical.tables.filter(matches)
    const relations = views.filter(matches)
    if (tables.length + relations.length === 0) return [{ kind: "unknown" }]
    const found: Classified[] = tables.map(classifyTable)
    for (const view of relations) {
      const id = key(view)
      if (visited.has(id)) continue
      const next = new Set([...visited, id])
      const bases = relationReads(view, units, parse, plpgsql).flatMap((r) =>
        classify(r, next)
      )
      if (view.class === "view") {
        found.push(...bases)
        continue
      }
      found.push(
        bases.every((b) => b.kind === "exempt")
          ? {
              kind: "exempt",
              table: { schema: view.schema, name: view.name },
              reason: "materializedView",
            }
          : { kind: "unknown" }
      )
    }
    return found.some((c) => c.kind === "unknown")
      ? [{ kind: "unknown" }]
      : found
  }

  const sourceFacts = new Map<
    string,
    { table: PhysicalTable; facts: Set<SnapshotFact> }
  >()
  const exempt = new Map<
    string,
    { table: QualifiedName; reason: SnapshotExemptReason }
  >()
  const unknown: SnapshotSources["unknown"] = []
  for (const fact of SNAPSHOT_FACTS) {
    for (const head of heads(fact, input, units)) {
      const readers = [head, ...reachableUnits(head, units, parse, plpgsql)]
      for (const reader of readers) {
        for (const ref of relationReads(reader, units, parse, plpgsql)) {
          for (const c of classify(ref, new Set())) {
            if (c.kind === "unknown") {
              unknown.push({
                relation:
                  ref.schema === undefined
                    ? ref.name
                    : key(ref as QualifiedName),
                fact,
                via: reader.identity,
              })
              continue
            }
            const id = key(c.table)
            if (c.kind === "exempt") {
              if (!exempt.has(id)) exempt.set(id, c)
              continue
            }
            const entry = sourceFacts.get(id) ?? {
              table: c.table,
              facts: new Set<SnapshotFact>(),
            }
            entry.facts.add(fact)
            sourceFacts.set(id, entry)
          }
        }
      }
    }
  }
  const byName = (a: string, b: string) => compareStrings(a, b)
  return {
    sources: [...sourceFacts.entries()]
      .sort(([a], [b]) => byName(a, b))
      .map(([, { table, facts }]) => ({
        table,
        facts: SNAPSHOT_FACTS.filter((f) => facts.has(f)),
      })),
    exempt: [...exempt.entries()]
      .sort(([a], [b]) => byName(a, b))
      .map(([, value]) => value),
    unknown: unknown
      .filter(
        (entry, i) =>
          unknown.findIndex(
            (other) =>
              other.relation === entry.relation &&
              other.fact === entry.fact &&
              other.via === entry.via
          ) === i
      )
      .sort(
        (a, b) =>
          byName(a.relation, b.relation) ||
          byName(a.fact, b.fact) ||
          byName(a.via, b.via)
      ),
  }
}

/**
 * Голови обходу факту: його живий варіант, а для `rights` — запити входів
 * `rights_mine` (Р3-15) і рядки носіїв `fullAccess` кожного довідника, які
 * тіло знімка пише поруч. Запити входів і рядки носіїв — не функції моделі,
 * тож обгортаються в одиницю лише для обходу; входи — без звуження до
 * призначень знімка: їхні читання — надмножина, а таблиці знімка серед
 * джерел не потрібні.
 */
function heads(
  fact: SnapshotFact,
  input: SnapshotSourcesInput,
  units: readonly VerbatimUnit[]
): VerbatimUnit[] {
  const wrap = (name: string, returns: string, body: string) =>
    asVerbatim({
      ...generatedUnit(
        `CREATE FUNCTION ${PLATFORM_SCHEMA}.${name}() RETURNS ${returns} LANGUAGE sql STABLE SET search_path = '' AS $snapshot$\n${body}\n$snapshot$;`,
        PLATFORM_SCHEMA,
        input.parse
      ),
    })
  if (fact === "rights") {
    const inputs = liveInputs(
      input.contracts,
      input.physical,
      input.attributeCase,
      LIVE
    )
    return [
      ...(Object.keys(inputs) as (keyof MineInputs)[]).map((name) =>
        wrap(`rights_snapshot_input_${name}`, "SETOF record", inputs[name])
      ),
      ...input.contracts.rightsCatalogs.map((catalog, index) =>
        wrap(
          `rights_snapshot_holders_${index}`,
          "TABLE (scope uuid, actor uuid)",
          fullAccessHolderRows(
            catalog,
            input.contracts,
            input.physical,
            input.attributeCase
          )
        )
      ),
    ]
  }
  const live = LIVE_HEADS[fact]
  const found = units.filter(
    (u) =>
      u.class === "function" && u.schema === live.schema && u.name === live.name
  )
  if (found.length === 0)
    throw new Error(`internal: missing live variant ${key(live)}`)
  return found
}
