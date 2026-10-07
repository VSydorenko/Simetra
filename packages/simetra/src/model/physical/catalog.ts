import type {
  PhysicalCheck,
  PhysicalColumn,
  PhysicalEnumType,
  PhysicalSnapshot,
  PhysicalTable,
} from "./snapshot"

/** Клас SQL-одиниці (спека П2 §8.3); належить T0, бо його читає й порт каталогу. */
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
 * Модель каталогу порту `SchemaEngine`: те, що бачить база, без походження
 * (`origin` — знання компілятора, каталог його не має). Зведення до однієї
 * форми з обох боків (бажаний стан і витяг із живої бази) робить порівняння
 * структурним.
 */
export type CatalogColumn = Omit<PhysicalColumn, "origin">
export type CatalogCheck = Omit<PhysicalCheck, "origin">
export type CatalogTable = Omit<
  PhysicalTable,
  "origin" | "columns" | "checks"
> & {
  columns: CatalogColumn[]
  checks: CatalogCheck[]
}
export type CatalogEnumType = Omit<PhysicalEnumType, "origin">

export interface CatalogUnit {
  class: SqlUnitClass
  identity: string
  schema: string
  name: string
  sql: string
}

/** Порядок як у знімку: `tables`/`enumTypes` за `(schema, name)`, `units` за `identity`. */
export interface CatalogModel {
  tables: CatalogTable[]
  enumTypes: CatalogEnumType[]
  units: CatalogUnit[]
}

/**
 * `path` — крапкова адреса: `tables.<schema>.<table>`, далі `columns.<name>`,
 * `primaryKey`, `uniques.<name>`, `checks.<name>`, `foreignKeys.<name>`,
 * `indexes.<name>`; `enumTypes.<schema>.<name>`; `units.<identity>`.
 * Різний порядок колонок — `order` на `…columns`.
 */
export interface CatalogDifference {
  path: string
  kind: "missing" | "extra" | "changed" | "order"
  detail: string
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Знімок без `origin`; порядок уже детермінований знімком. */
export function catalogFromSnapshot(
  snapshot: PhysicalSnapshot
): Pick<CatalogModel, "tables" | "enumTypes"> {
  return {
    tables: snapshot.tables.map((table) => {
      const copy: Partial<PhysicalTable> = { ...table }
      delete copy.origin
      return {
        ...copy,
        columns: table.columns.map((column) => {
          const c: Partial<PhysicalColumn> = { ...column }
          delete c.origin
          return c
        }),
        // Походження правила рядка — знання компілятора; база бачить той
        // самий CHECK, тож різниці між бажаним станом і витягом бути не може.
        checks: table.checks.map(({ name, expression }) => ({
          name,
          expression,
        })),
      } as CatalogTable
    }),
    enumTypes: snapshot.enumTypes.map((e) => {
      const copy: Partial<PhysicalEnumType> = { ...e }
      delete copy.origin
      return copy as CatalogEnumType
    }),
  }
}

/** Канонічна JSON-форма: ключі впорядковані, тож порядок полів не впливає. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => compare(x, y)))
      : v
  )
}

/** Порівнює словники за ключем: відсутній ліворуч — `extra`, праворуч — `missing`. */
function diffKeyed<T>(
  path: string,
  a: ReadonlyMap<string, T>,
  b: ReadonlyMap<string, T>,
  out: CatalogDifference[],
  onBoth: (p: string, x: T, y: T) => void
): void {
  for (const [key, x] of a) {
    const y = b.get(key)
    if (y === undefined) {
      out.push({
        path: `${path}.${key}`,
        kind: "missing",
        detail: "absent in second model",
      })
    } else onBoth(`${path}.${key}`, x, y)
  }
  for (const key of b.keys()) {
    if (!a.has(key))
      out.push({
        path: `${path}.${key}`,
        kind: "extra",
        detail: "absent in first model",
      })
  }
}

const byName = <T extends { name: string }>(items: readonly T[]) =>
  new Map(items.map((i) => [i.name, i]))

function diffChanged(
  path: string,
  x: unknown,
  y: unknown,
  out: CatalogDifference[]
): void {
  if (canon(x) !== canon(y))
    out.push({
      path,
      kind: "changed",
      detail: `${canon(x)} != ${canon(y)}`,
    })
}

function diffTable(
  path: string,
  a: CatalogTable,
  b: CatalogTable,
  out: CatalogDifference[]
): void {
  const {
    columns: ca,
    primaryKey: pa,
    uniques: ua,
    checks: ka,
    foreignKeys: fa,
    indexes: ia,
    ...restA
  } = a
  const {
    columns: cb,
    primaryKey: pb,
    uniques: ub,
    checks: kb,
    foreignKeys: fb,
    indexes: ib,
    ...restB
  } = b
  diffChanged(path, restA, restB, out)
  diffKeyed(`${path}.columns`, byName(ca), byName(cb), out, (p, x, y) =>
    diffChanged(p, x, y, out)
  )
  const namesA = ca.map((c) => c.name)
  const namesB = cb.map((c) => c.name)
  const sameSet =
    namesA.length === namesB.length && namesA.every((n) => namesB.includes(n))
  if (sameSet && namesA.some((n, i) => n !== namesB[i]))
    out.push({
      path: `${path}.columns`,
      kind: "order",
      detail: `column order ${namesA.join(",")} != ${namesB.join(",")}`,
    })
  diffChanged(`${path}.primaryKey`, pa ?? null, pb ?? null, out)
  diffKeyed(`${path}.uniques`, byName(ua), byName(ub), out, (p, x, y) =>
    diffChanged(p, x, y, out)
  )
  diffKeyed(`${path}.checks`, byName(ka), byName(kb), out, (p, x, y) =>
    diffChanged(p, x, y, out)
  )
  diffKeyed(`${path}.foreignKeys`, byName(fa), byName(fb), out, (p, x, y) =>
    diffChanged(p, x, y, out)
  )
  diffKeyed(`${path}.indexes`, byName(ia), byName(ib), out, (p, x, y) =>
    diffChanged(p, x, y, out)
  )
}

/** Структурне порівняння двох моделей каталогу; результат упорядкований за `path`. */
export function diffCatalogModels(
  a: CatalogModel,
  b: CatalogModel
): CatalogDifference[] {
  const out: CatalogDifference[] = []
  const qualified = <T extends { schema: string; name: string }>(
    items: readonly T[]
  ) => new Map(items.map((i) => [`${i.schema}.${i.name}`, i]))
  diffKeyed(
    "tables",
    qualified(a.tables),
    qualified(b.tables),
    out,
    (p, x, y) => diffTable(p, x, y, out)
  )
  diffKeyed(
    "enumTypes",
    qualified(a.enumTypes),
    qualified(b.enumTypes),
    out,
    (p, x, y) => diffChanged(p, x, y, out)
  )
  diffKeyed(
    "units",
    new Map(a.units.map((u) => [u.identity, u])),
    new Map(b.units.map((u) => [u.identity, u])),
    out,
    (p, x, y) => diffChanged(p, x, y, out)
  )
  return out.sort((x, y) => compare(x.path, y.path))
}
