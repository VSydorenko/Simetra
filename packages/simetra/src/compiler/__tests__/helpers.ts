import { toSnakeCase } from "simetra/model"

/** Детермінований UUID v4 для фікстур: номер видно в самому id. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`
}

// Лічильник дає кожній фікстурі унікальний id без ручної нумерації; тести,
// яким важливе конкретне значення, передають id явно.
let nextId = 1000
function freshId(): string {
  nextId += 1
  return uuid(nextId)
}

export function project(overrides: Record<string, unknown> = {}) {
  return { name: "TestApp", ...overrides }
}

/** Об'єкт серіалізується в JSON, рядок іде як є (для зламаного JSON). */
export function metaFiles(
  entries: Record<string, unknown>
): Map<string, string> {
  return new Map(
    Object.entries(entries).map(([path, content]) => [
      path,
      typeof content === "string" ? content : JSON.stringify(content),
    ])
  )
}

export function attribute(
  name: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: freshId(),
    name,
    physicalName: toSnakeCase(name),
    type: "Boolean",
    ...overrides,
  }
}

function object(
  kind: string,
  name: string,
  overrides: Record<string, unknown>
) {
  return {
    id: freshId(),
    kind,
    name,
    physicalName: toSnakeCase(name),
    ...overrides,
  }
}

export function catalog(name: string, overrides: Record<string, unknown> = {}) {
  return object("Catalog", name, overrides)
}

export function document(
  name: string,
  overrides: Record<string, unknown> = {}
) {
  return object("Document", name, overrides)
}

export function customTable(
  name: string,
  overrides: Record<string, unknown> = {}
) {
  return object("CustomTable", name, {
    columns: [{ id: freshId(), name: "id", physicalName: "id", type: "UUID" }],
    ...overrides,
  })
}

/**
 * Проєкт із двома видами скоупу: `org` (корінь — довідник `Organization`) і
 * `user` (зовнішній корінь). Довідник-корінь дає `organization()`.
 */
export function scopedProject(): {
  name: string
  scopeKinds: Record<string, unknown>[]
} {
  return project({
    scopeKinds: [
      {
        id: freshId(),
        name: "org",
        physicalName: "org_id",
        root: { object: { kind: "Catalog", name: "Organization" } },
        setFunction: { name: "org_ids" },
      },
      {
        id: freshId(),
        name: "user",
        physicalName: "user_id",
        root: { external: { schema: "auth", table: "users", column: "id" } },
        setFunction: { name: "user_ids" },
      },
    ],
  }) as { name: string; scopeKinds: Record<string, unknown>[] }
}

/** Довідник-корінь виду `org`: власний вид оголошує і він сам. */
export function organization(overrides: Record<string, unknown> = {}) {
  return catalog("Organization", { scope: "org", ...overrides })
}

export const SALE_FILE = "documents/Sale/Sale.meta.json"
export const STOCK_FILE = "accumulation-registers/Stock/Stock.meta.json"

/**
 * Документ `Sale` з ТЧ `goods` і регістр залишків `Stock`, що приймає його
 * рухи. `movement` доповнює типовий рух, `sale` — сам документ; обидва
 * перекривають типове.
 */
export function salesDocument(
  movement: Record<string, unknown> = {},
  sale: Record<string, unknown> = {}
): Record<string, unknown> {
  const stockId = freshId()
  const goods = {
    id: freshId(),
    name: "goods",
    physicalName: "goods",
    attributes: [
      attribute("item", {
        physicalName: "item_id",
        type: "Ref",
        ref: { kind: "Catalog", name: "Item" },
      }),
      attribute("qty", { type: "Numeric", precision: 15, scale: 3 }),
      attribute("amount", { type: "Numeric", precision: 15, scale: 2 }),
    ],
  }
  return {
    "catalogs/Item/Item.meta.json": catalog("Item"),
    [SALE_FILE]: document("Sale", {
      tabularSections: [goods],
      posting: {
        movements: [
          {
            register: { kind: "AccumulationRegister", name: "Stock" },
            source: { tabularSection: "goods" },
            movementType: "Expense",
            fields: { item: "row.item", qty: "row.qty" },
            ...movement,
          },
        ],
      },
      ...sale,
    }),
    [STOCK_FILE]: {
      id: stockId,
      kind: "AccumulationRegister",
      name: "Stock",
      physicalName: "stock",
      recorderTypes: [{ kind: "Document", name: "Sale" }],
      dimensions: [
        attribute("item", {
          physicalName: "item_id",
          type: "Ref",
          ref: { kind: "Catalog", name: "Item" },
        }),
      ],
      resources: [
        attribute("qty", { type: "Numeric", precision: 15, scale: 3 }),
      ],
    },
  }
}
