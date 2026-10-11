import type { EdgeKind, FactBase, FactKind } from "@supabase/pg-delta"
import type { FingerprintSection } from "simetra/schema"

/**
 * Контракт покриття SQL-відбитка моделлю двигуна (рішення 3 плану П3-1):
 * відбиток покриває кожну властивість, яку закріплений двигун видобуває й
 * планує, а що поза ним — явний виняток із причиною. Без цієї мапи нова
 * властивість наступної альфи pg-delta мовчки лишилася б поза гейтом: двигун
 * її планує, а відбиток її зміни не бачить.
 *
 * Ключ — поле payload факту; `@` — сам факт (його наявність та ідентичність);
 * `*` — увесь вид поза межею гейта. Поля з `_` не входять: двигун сам
 * виключає їх із хешу й diff (`core/hash.ts`, `core/diff.ts` pg-delta), тож
 * нічого за ними не планує.
 *
 * Мапа доводить повноту щодо моделі двигуна, а не те, що SQL справді бачить
 * зміну: це доводять посекційні тести відбитка.
 */
export type Coverage = FingerprintSection | { exception: string }

export type CoverageMap = Partial<
  Record<FactKind, Readonly<Record<string, Coverage>>>
>

/** Сам факт — ключ мапи для виду, у якого payload може бути порожнім. */
export const FACT = "@"
/** Увесь вид — виняток незалежно від полів. */
export const ANY_KEY = "*"

const GLOBAL: Coverage = {
  exception:
    "cluster- or database-level object outside the gate's schema scope (platform spec §6.9)",
}
const SERVER: Coverage = {
  exception:
    "database-level object outside the gate's schema scope; a scope foreign table names its server in `relations`",
}
const RANGE: Coverage = {
  exception:
    "a range type cannot be altered in place; its subtype shows through the constructor signatures in `functions`",
}

const ROUTINE = {
  [FACT]: "functions",
  argSignature: "functions",
  def: "functions",
  isWindow: "functions",
  language: "functions",
  returnType: "functions",
} as const satisfies Record<string, Coverage>

const VIEW = {
  [FACT]: "views",
  def: "views",
  reloptions: "relations",
} as const satisfies Record<string, Coverage>

export const FINGERPRINT_COVERAGE = {
  role: { [ANY_KEY]: GLOBAL },
  membership: { [ANY_KEY]: GLOBAL },
  server: { [ANY_KEY]: SERVER },
  schema: { [FACT]: "schemas" },
  extension: { [FACT]: "extensions", schema: "extensions" },
  table: {
    [FACT]: "inventory",
    forceRowSecurity: "relations",
    parentTable: "relations",
    partitionBound: "relations",
    partitionKey: "relations",
    persistence: "relations",
    reloptions: "relations",
    replicaIdentity: "relations",
    replicaIdentityIndex: "indexes",
    rowSecurity: "relations",
  },
  foreignTable: {
    [FACT]: "inventory",
    options: "relations",
    server: "relations",
  },
  view: VIEW,
  materializedView: VIEW,
  column: {
    [FACT]: "columns",
    collation: "columns",
    generatedExpr: "columns",
    identity: "columns",
    notNull: "columns",
    type: "columns",
  },
  default: { [FACT]: "columns", expr: "columns" },
  typeAttribute: { [FACT]: "columns", collation: "columns", type: "columns" },
  constraint: {
    [FACT]: "constraints",
    def: "constraints",
    type: "constraints",
    validated: "constraints",
  },
  index: {
    [FACT]: "indexes",
    attachedTo: "indexes",
    def: "indexes",
    valid: "indexes",
  },
  sequence: {
    [FACT]: "sequences",
    cache: "sequences",
    cycle: "sequences",
    dataType: "sequences",
    increment: "sequences",
    maxValue: "sequences",
    minValue: "sequences",
    ownedBy: "sequences",
    start: "sequences",
  },
  function: ROUTINE,
  procedure: ROUTINE,
  aggregate: {
    [FACT]: "functions",
    aggKind: "functions",
    combinefunc: "functions",
    deserialfunc: "functions",
    finalfunc: "functions",
    finalfuncExtra: "functions",
    finalfuncModify: "functions",
    initcond: "functions",
    mfinalfunc: "functions",
    mfinalfuncExtra: "functions",
    mfinalfuncModify: "functions",
    minitcond: "functions",
    minvfunc: "functions",
    msfunc: "functions",
    msspace: "functions",
    mstype: "functions",
    numDirectArgs: "functions",
    parallel: "functions",
    serialfunc: "functions",
    sfunc: "functions",
    sortop: "functions",
    sspace: "functions",
    stype: "functions",
  },
  trigger: { [FACT]: "triggers", def: "triggers", enabled: "triggers" },
  policy: {
    [FACT]: "policies",
    checkExpr: "policies",
    cmd: "policies",
    permissive: "policies",
    roles: "policies",
    usingExpr: "policies",
  },
  rule: { [FACT]: "inventory", def: "views", enabled: "views" },
  domain: {
    [FACT]: "types",
    baseType: "types",
    collation: "types",
    default: "types",
    notNull: "types",
  },
  type: {
    [FACT]: "inventory",
    values: "types",
    variant: "types",
    multirangeTypeName: "inventory",
    subtype: "functions",
    subtypeDiff: RANGE,
    subtypeOpclass: RANGE,
    collation: RANGE,
  },
  collation: {
    [FACT]: "inventory",
    deterministic: "types",
    lcCollate: "types",
    lcCtype: "types",
    locale: "types",
    provider: "types",
  },
  acl: { [FACT]: "acl", grantable: "acl", privileges: "acl" },
  defaultPrivilege: {
    [FACT]: "defaultPrivileges",
    grantable: "defaultPrivileges",
    privileges: "defaultPrivileges",
  },
  comment: { [FACT]: "comments", onDomain: "comments", text: "comments" },
  publication: {
    [FACT]: "publications",
    allTables: "publications",
    publish: "publications",
    viaRoot: "publications",
  },
  publicationRel: {
    [FACT]: "publications",
    columns: "publications",
    where: "publications",
  },
  publicationSchema: { [FACT]: "publications" },
} as const satisfies CoverageMap

export const FINGERPRINT_EDGE_COVERAGE = {
  owner: "owner",
  depends: {
    exception:
      "derived from the definitions the sections already hash (`pg_get_*def`), not independent state",
  },
  memberOfExtension: {
    exception:
      "members follow from the extension (`extensions`); each member is hashed as an object of its own class",
  },
} as const satisfies Partial<Record<EdgeKind, Coverage>>

/**
 * Розбіжності моделі двигуна з мапою: поле чи вид, яких мапа не знає, і
 * запис мапи, якого модель (на цьому каталозі) вже не має.
 */
export function coverageGaps(
  facts: FactBase,
  map: CoverageMap = FINGERPRINT_COVERAGE,
  edges: Partial<Record<EdgeKind, Coverage>> = FINGERPRINT_EDGE_COVERAGE
): string[] {
  const observed = new Map<string, Set<string>>()
  for (const fact of facts.facts()) {
    const keys = observed.get(fact.id.kind) ?? new Set([FACT])
    for (const [key, value] of Object.entries(fact.payload))
      if (!key.startsWith("_") && value !== undefined) keys.add(key)
    observed.set(fact.id.kind, keys)
  }
  const gaps: string[] = []
  for (const [kind, keys] of observed) {
    const entry = map[kind as FactKind]
    if (entry === undefined) {
      gaps.push(`unmapped kind ${kind}`)
      continue
    }
    if (ANY_KEY in entry) continue
    for (const key of keys)
      if (!(key in entry)) gaps.push(`unmapped ${kind}.${key}`)
    for (const key of Object.keys(entry))
      if (!keys.has(key)) gaps.push(`stale ${kind}.${key}`)
  }
  for (const kind of Object.keys(map))
    if (!observed.has(kind)) gaps.push(`stale kind ${kind}`)
  const edgeKinds = new Set<string>(facts.edges.map((e) => e.kind))
  for (const kind of edgeKinds)
    if (!(kind in edges)) gaps.push(`unmapped edge ${kind}`)
  for (const kind of Object.keys(edges))
    if (!edgeKinds.has(kind)) gaps.push(`stale edge ${kind}`)
  return gaps.sort()
}
