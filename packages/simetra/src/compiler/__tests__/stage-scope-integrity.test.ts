import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  organization,
  scopedProject,
  uuid,
} from "./helpers"

const PROJECT = "project.meta.json"
const ORG = "catalogs/Organization/Organization.meta.json"
const CP = "catalogs/Counterparty/Counterparty.meta.json"
const CONTRACT = "catalogs/Contract/Contract.meta.json"
const CURRENCY = "catalogs/Currency/Currency.meta.json"
const SETTINGS = "custom-tables/UserSettings/UserSettings.meta.json"
const SALE = "documents/Sale/Sale.meta.json"
const STOCK = "accumulation-registers/Stock/Stock.meta.json"

function ref(kind: string, name: string, extra: Record<string, unknown> = {}) {
  return { type: "Ref", ref: { kind, name }, ...extra }
}

function compileScoped(
  entries: Record<string, unknown>,
  projectFile: unknown = scopedProject()
) {
  return compile(
    metaFiles({ [PROJECT]: projectFile, [ORG]: organization(), ...entries })
  )
}

/**
 * Усі діагностики прогону як (код, серйозність, файл, pointer): тест бачить і
 * побічні правила, а не лише скоуп.
 */
function scopeDiagnostics(result: ReturnType<typeof compile>) {
  return result.diagnostics.map((d) => [d.code, d.severity, d.file, d.pointer])
}

/** Проєкт, у якого корінь виду за індексом — інший об'єкт. */
function projectWithRoot(index: number, kind: string, name: string) {
  const base = scopedProject()
  return {
    ...base,
    scopeKinds: base.scopeKinds.map((scopeKind, i) =>
      i === index
        ? { ...scopeKind, root: { object: { kind, name } } }
        : scopeKind
    ),
  }
}

const ACCOUNT = "catalogs/Account/Account.meta.json"

const counterparty = (overrides: Record<string, unknown> = {}) =>
  catalog("Counterparty", { scope: "org", ...overrides })

const currency = (overrides: Record<string, unknown> = {}) =>
  catalog("Currency", { scope: "none", ...overrides })

function register(
  scope: string,
  recorders: { kind: string; name: string }[],
  overrides: Record<string, unknown> = {}
) {
  return {
    id: uuid(950),
    kind: "AccumulationRegister",
    name: "Stock",
    physicalName: "stock",
    scope,
    recorderTypes: recorders,
    resources: [attribute("qty", { type: "Integer" })],
    ...overrides,
  }
}

describe("стадія 4: скоуп", () => {
  it("коректний скоупований проєкт проходить без діагностик скоупу", () => {
    const result = compileScoped({
      [CP]: counterparty({
        attributes: [
          attribute("currency", ref("Catalog", "Currency")),
          attribute("parent2", ref("Catalog", "Counterparty")),
        ],
      }),
      [CURRENCY]: currency(),
      [SALE]: document("Sale", { scope: "org" }),
      [STOCK]: register("org", [{ kind: "Document", name: "Sale" }]),
    })
    expect(scopeDiagnostics(result)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("корінь може посилатися на скоуплений об'єкт власного виду", () => {
    const result = compileScoped({
      [ORG]: organization({
        attributes: [attribute("main", ref("Catalog", "Counterparty"))],
        tabularSections: [
          {
            id: uuid(960),
            name: "rows",
            physicalName: "rows",
            attributes: [attribute("cp", ref("Catalog", "Counterparty"))],
          },
        ],
      }),
      [CP]: counterparty(),
    })
    expect(scopeDiagnostics(result)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("missing scope declaration", () => {
    const result = compileScoped({ [CP]: catalog("Counterparty") })
    expect(result.ok).toBe(false)
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.declaration-missing", "error", CP, ""],
    ])
  })

  it("global references scoped", () => {
    const result = compileScoped({
      [CP]: counterparty(),
      [CURRENCY]: currency({
        attributes: [attribute("cp", ref("Catalog", "Counterparty"))],
      }),
    })
    expect(result.ok).toBe(false)
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.global-to-scoped", "error", CURRENCY, "/attributes/0/ref"],
    ])
  })

  it("global references scoped: crossScope дозволяє", () => {
    const result = compileScoped({
      [CP]: counterparty(),
      [CURRENCY]: currency({
        attributes: [
          attribute("cp", ref("Catalog", "Counterparty", { crossScope: true })),
        ],
      }),
    })
    expect(scopeDiagnostics(result)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("global references a scope root", () => {
    const result = compileScoped({
      [CURRENCY]: currency({
        attributes: [attribute("company", ref("Catalog", "Organization"))],
      }),
    })
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.global-to-scoped", "error", CURRENCY, "/attributes/0/ref"],
    ])
  })

  it("reference across scope kinds without crossScope", () => {
    const result = compileScoped({
      [CP]: counterparty({
        attributes: [attribute("settings", ref("CustomTable", "UserSettings"))],
      }),
      [SETTINGS]: customTable("UserSettings", {
        scope: "user",
        scopeColumn: "owner",
        primaryKey: { columns: ["id"] },
        columns: [
          { id: uuid(970), name: "id", physicalName: "id", type: "UUID" },
          { id: uuid(971), name: "owner", physicalName: "owner", type: "UUID" },
        ],
      }),
    })
    expect(result.ok).toBe(false)
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.cross-kind", "error", CP, "/attributes/0/ref"],
    ])
  })

  it("reference across scope kinds: owner каталогу", () => {
    const result = compileScoped({
      [CP]: counterparty(),
      [CONTRACT]: catalog("Contract", {
        scope: "user",
        owners: [{ kind: "Catalog", name: "Counterparty" }],
      }),
    })
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.cross-kind", "error", CONTRACT, "/owners/0"],
    ])
  })

  it("polymorphic target across scope kinds", () => {
    const result = compileScoped({
      [CP]: counterparty({
        attributes: [
          attribute("target", {
            type: "Ref",
            allowedTypes: [
              { kind: "Catalog", name: "Counterparty" },
              { kind: "CustomTable", name: "UserSettings" },
            ],
          }),
        ],
      }),
      [SETTINGS]: customTable("UserSettings", {
        scope: "user",
        scopeColumn: "owner",
        primaryKey: { columns: ["id"] },
        columns: [
          { id: uuid(970), name: "id", physicalName: "id", type: "UUID" },
          { id: uuid(971), name: "owner", physicalName: "owner", type: "UUID" },
        ],
      }),
    })
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.cross-kind", "error", CP, "/attributes/0/allowedTypes/1"],
    ])
  })

  it("register scope differs from recorder", () => {
    const result = compileScoped({
      [SALE]: document("Sale", { scope: "org" }),
      [STOCK]: register("user", [{ kind: "Document", name: "Sale" }]),
    })
    expect(result.ok).toBe(false)
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.recorder-mismatch", "error", STOCK, "/recorderTypes/0"],
    ])
  })

  it("register scope none differs from scoped recorder", () => {
    const result = compileScoped({
      [SALE]: document("Sale", { scope: "org" }),
      [STOCK]: register("none", [{ kind: "Document", name: "Sale" }]),
    })
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.recorder-mismatch", "error", STOCK, "/recorderTypes/0"],
    ])
  })

  it("reference to own root", () => {
    const result = compileScoped({
      [CP]: counterparty({
        attributes: [attribute("company", ref("Catalog", "Organization"))],
      }),
    })
    expect(result.ok).toBe(false)
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.root-self-reference", "error", CP, "/attributes/0/ref"],
    ])
  })

  it("reference to own root: рядок ТЧ, owner і ціль allowedTypes", () => {
    const result = compileScoped({
      [CP]: counterparty({
        owners: [{ kind: "Catalog", name: "Organization" }],
        attributes: [
          attribute("target", {
            type: "Ref",
            allowedTypes: [
              { kind: "Catalog", name: "Counterparty" },
              { kind: "Catalog", name: "Organization" },
            ],
          }),
        ],
        tabularSections: [
          {
            id: uuid(961),
            name: "rows",
            physicalName: "rows",
            attributes: [attribute("company", ref("Catalog", "Organization"))],
          },
        ],
      }),
    })
    expect(scopeDiagnostics(result)).toEqual([
      [
        "scope.root-self-reference",
        "error",
        CP,
        "/attributes/0/allowedTypes/1",
      ],
      ["scope.root-self-reference", "error", CP, "/owners/0"],
      [
        "scope.root-self-reference",
        "error",
        CP,
        "/tabularSections/0/attributes/0/ref",
      ],
    ])
  })

  it("reference to own root: crossScope дозволяє свідому межтенантну ціль", () => {
    const result = compileScoped({
      [CP]: counterparty({
        attributes: [
          attribute(
            "company",
            ref("Catalog", "Organization", { crossScope: true })
          ),
        ],
      }),
    })
    expect(scopeDiagnostics(result)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("root references the root of its own kind", () => {
    const attributes = (extra: Record<string, unknown>) => [
      attribute("head", ref("Catalog", "Organization", extra)),
    ]
    const bare = compileScoped({
      [ORG]: organization({ attributes: attributes({}) }),
    })
    expect(scopeDiagnostics(bare)).toEqual([
      ["scope.root-self-reference", "error", ORG, "/attributes/0/ref"],
    ])
    const cross = compileScoped({
      [ORG]: organization({ attributes: attributes({ crossScope: true }) }),
    })
    expect(scopeDiagnostics(cross)).toEqual([])
    expect(cross.ok).toBe(true)
  })

  it("root owner is the root of its own kind", () => {
    const result = compileScoped({
      [ORG]: organization({
        owners: [{ kind: "Catalog", name: "Organization" }],
      }),
    })
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.root-self-reference", "error", ORG, "/owners/0"],
    ])
  })

  it("hierarchical root", () => {
    const result = compileScoped({
      [ORG]: organization({ hierarchyType: "FoldersAndItems" }),
    })
    expect(result.ok).toBe(false)
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.root-hierarchy", "error", ORG, "/hierarchyType"],
    ])
  })

  it("reference to the root of another scope kind", () => {
    const entries = (extra: Record<string, unknown>) => ({
      [ACCOUNT]: catalog("Account", { scope: "user" }),
      [CP]: counterparty({
        attributes: [
          attribute("single", ref("Catalog", "Account", extra)),
          attribute("target", {
            type: "Ref",
            ...extra,
            allowedTypes: [
              { kind: "Catalog", name: "Counterparty" },
              { kind: "Catalog", name: "Account" },
            ],
          }),
        ],
      }),
    })
    const project = projectWithRoot(1, "Catalog", "Account")
    const bare = compileScoped(entries({}), project)
    expect(scopeDiagnostics(bare)).toEqual([
      ["scope.cross-kind", "error", CP, "/attributes/0/ref"],
      ["scope.cross-kind", "error", CP, "/attributes/1/allowedTypes/1"],
    ])
    const cross = compileScoped(entries({ crossScope: true }), project)
    expect(scopeDiagnostics(cross)).toEqual([])
    expect(cross.ok).toBe(true)
  })

  it("misdeclared root gets only its own error", () => {
    const result = compileScoped({
      [ORG]: organization({
        scope: "none",
        attributes: [attribute("cp", ref("Catalog", "Counterparty"))],
      }),
      [CP]: counterparty(),
    })
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.root-declaration", "error", ORG, "/scope"],
    ])
  })

  it("root must declare own kind", () => {
    const result = compileScoped({
      [ORG]: organization({ scope: "none" }),
    })
    expect(result.ok).toBe(false)
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.root-declaration", "error", ORG, "/scope"],
    ])
  })

  it("root must declare own kind: чужий вид", () => {
    const result = compileScoped({
      [ORG]: organization({ scope: "user" }),
    })
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.root-declaration", "error", ORG, "/scope"],
    ])
  })

  it("register cannot be a root", () => {
    const base = scopedProject()
    const [first, ...rest] = base.scopeKinds
    const result = compile(
      metaFiles({
        [PROJECT]: {
          ...base,
          scopeKinds: [
            {
              ...first,
              root: { object: { kind: "AccumulationRegister", name: "Stock" } },
            },
            ...rest,
          ],
        },
        [STOCK]: register("org", []),
      })
    )
    expect(result.ok).toBe(false)
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.root-key", "error", PROJECT, "/scopeKinds/0/root/object"],
    ])
  })

  it("root without a single uuid key: composite PK, constant, enumeration", () => {
    const cases: [string, string, string, Record<string, unknown>][] = [
      [
        "CustomTable",
        "Tenants",
        "custom-tables/Tenants/Tenants.meta.json",
        customTable("Tenants", {
          scope: "none",
          primaryKey: { columns: ["id", "other"] },
          columns: [
            { id: uuid(980), name: "id", physicalName: "id", type: "UUID" },
            {
              id: uuid(981),
              name: "other",
              physicalName: "other",
              type: "UUID",
            },
          ],
        }),
      ],
      [
        "Constant",
        "Limit",
        "constants/Limit/Limit.meta.json",
        {
          id: uuid(982),
          kind: "Constant",
          name: "Limit",
          physicalName: "limit_value",
          scope: "none",
          type: "Integer",
        },
      ],
      [
        "Enumeration",
        "Status",
        "enumerations/Status/Status.meta.json",
        {
          id: uuid(983),
          kind: "Enumeration",
          name: "Status",
          physicalName: "status",
          scope: "none",
        },
      ],
    ]
    for (const [kind, name, file, data] of cases) {
      const result = compile(
        metaFiles({
          [PROJECT]: projectWithRoot(0, kind, name),
          [file]: data,
        })
      )
      expect(scopeDiagnostics(result), kind).toEqual([
        ["scope.root-key", "error", PROJECT, "/scopeKinds/0/root/object"],
      ])
    }
  })

  it("custom table scope column must be uuid", () => {
    const result = compileScoped({
      [SETTINGS]: customTable("UserSettings", {
        scope: "user",
        scopeColumn: "owner",
        columns: [
          { id: uuid(970), name: "id", physicalName: "id", type: "UUID" },
          {
            id: uuid(971),
            name: "owner",
            physicalName: "owner",
            type: "String",
            length: 20,
          },
        ],
      }),
    })
    expect(result.ok).toBe(false)
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.custom-table-column", "error", SETTINGS, "/scopeColumn"],
    ])
  })

  it("scoped custom table without scope column", () => {
    const result = compileScoped({
      [SETTINGS]: customTable("UserSettings", { scope: "user" }),
    })
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.custom-table-column", "error", SETTINGS, ""],
    ])
  })

  it("custom table with a uuid scope column is valid", () => {
    const result = compileScoped({
      [SETTINGS]: customTable("UserSettings", {
        scope: "user",
        scopeColumn: "owner",
        columns: [
          { id: uuid(970), name: "id", physicalName: "id", type: "UUID" },
          { id: uuid(971), name: "owner", physicalName: "owner", type: "UUID" },
        ],
      }),
    })
    expect(scopeDiagnostics(result)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("redundant crossScope is a warning", () => {
    const result = compileScoped({
      [CP]: counterparty({
        attributes: [
          attribute(
            "currency",
            ref("Catalog", "Currency", { crossScope: true })
          ),
        ],
      }),
      [CURRENCY]: currency(),
    })
    expect(result.ok).toBe(true)
    expect(scopeDiagnostics(result)).toEqual([
      [
        "scope.cross-scope-redundant",
        "warning",
        CP,
        "/attributes/0/crossScope",
      ],
    ])
  })

  it("crossScope між скоупленими одного виду не зайвий", () => {
    const result = compileScoped({
      [CP]: counterparty({
        attributes: [
          attribute(
            "other",
            ref("Catalog", "Counterparty", { crossScope: true })
          ),
        ],
      }),
    })
    expect(scopeDiagnostics(result)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("crossScope на поліморфному Ref зайвий, лише якщо зайвий для кожної цілі", () => {
    const polymorphic = (targets: { kind: string; name: string }[]) =>
      compileScoped({
        [CP]: counterparty({
          attributes: [
            attribute("target", {
              type: "Ref",
              crossScope: true,
              allowedTypes: targets,
            }),
          ],
        }),
        [CURRENCY]: currency(),
      })
    expect(
      scopeDiagnostics(
        polymorphic([
          { kind: "Catalog", name: "Currency" },
          { kind: "Catalog", name: "Counterparty" },
        ])
      )
    ).toEqual([])
    expect(
      scopeDiagnostics(polymorphic([{ kind: "Catalog", name: "Currency" }]))
    ).toEqual([
      [
        "scope.cross-scope-redundant",
        "warning",
        CP,
        "/attributes/0/crossScope",
      ],
    ])
  })

  it("однотенантний проєкт: crossScope без діагностик", () => {
    const result = compile(
      metaFiles({
        [PROJECT]: { name: "TestApp" },
        [CP]: catalog("Counterparty", {
          attributes: [
            attribute(
              "self",
              ref("Catalog", "Counterparty", { crossScope: true })
            ),
          ],
        }),
      })
    )
    expect(scopeDiagnostics(result)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("однотенантний проєкт не дає діагностик скоупу", () => {
    const result = compile(
      metaFiles({
        [PROJECT]: { name: "TestApp" },
        [CP]: catalog("Counterparty", {
          attributes: [attribute("self", ref("Catalog", "Counterparty"))],
        }),
      })
    )
    expect(scopeDiagnostics(result)).toEqual([])
    expect(result.ok).toBe(true)
  })
})
