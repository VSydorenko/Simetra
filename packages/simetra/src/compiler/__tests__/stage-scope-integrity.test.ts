import { describe, expect, it } from "vitest"
import { compile, type CompileResult } from "simetra/compiler"
import {
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  organization,
  project,
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

async function compileScoped(
  entries: Record<string, unknown>,
  projectFile: unknown = scopedProject()
) {
  return await compile(
    metaFiles({ [PROJECT]: projectFile, [ORG]: organization(), ...entries })
  )
}

/**
 * Усі діагностики прогону як (код, серйозність, файл, pointer): тест бачить і
 * побічні правила, а не лише скоуп.
 */
function scopeDiagnostics(result: CompileResult) {
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
  it("коректний скоупований проєкт проходить без діагностик скоупу", async () => {
    const result = await compileScoped({
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

  it("корінь може посилатися на скоуплений об'єкт власного виду", async () => {
    const result = await compileScoped({
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

  it("missing scope declaration", async () => {
    const result = await compileScoped({ [CP]: catalog("Counterparty") })
    expect(result.ok).toBe(false)
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.declaration-missing", "error", CP, ""],
    ])
  })

  it("global references scoped", async () => {
    const result = await compileScoped({
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

  it("global references scoped: crossScope дозволяє", async () => {
    const result = await compileScoped({
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

  it("global references a scope root", async () => {
    const result = await compileScoped({
      [CURRENCY]: currency({
        attributes: [attribute("company", ref("Catalog", "Organization"))],
      }),
    })
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.global-to-scoped", "error", CURRENCY, "/attributes/0/ref"],
    ])
  })

  it("reference across scope kinds without crossScope", async () => {
    const result = await compileScoped({
      [CP]: counterparty({
        attributes: [attribute("settings", ref("CustomTable", "UserSettings"))],
      }),
      [SETTINGS]: customTable("UserSettings", {
        scope: "user",
        scopeColumn: "owner",
        primaryKey: { columns: ["id"] },
        columns: [
          {
            id: uuid(970),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
          { id: uuid(971), name: "owner", physicalName: "owner", type: "UUID" },
        ],
      }),
    })
    expect(result.ok).toBe(false)
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.cross-kind", "error", CP, "/attributes/0/ref"],
    ])
  })

  it("reference across scope kinds: owner каталогу", async () => {
    const result = await compileScoped({
      [CP]: counterparty(),
      [CONTRACT]: catalog("Contract", {
        scope: "user",
        owners: [{ kind: "Catalog", name: "Counterparty" }],
      }),
    })
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.cross-kind", "error", CONTRACT, "/owners/0"],
    ])
    const [owner] = result.diagnostics
    expect(owner?.params).toMatchObject({ via: "owner" })
    expect(owner?.hint).toContain("owner")
    expect(owner?.hint).not.toContain("crossScope")
  })

  it("polymorphic target across scope kinds", async () => {
    const result = await compileScoped({
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
          {
            id: uuid(970),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
          { id: uuid(971), name: "owner", physicalName: "owner", type: "UUID" },
        ],
      }),
    })
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.cross-kind", "error", CP, "/attributes/0/allowedTypes/1"],
    ])
  })

  it("register scope differs from recorder", async () => {
    const result = await compileScoped({
      [SALE]: document("Sale", { scope: "org" }),
      [STOCK]: register("user", [{ kind: "Document", name: "Sale" }]),
    })
    expect(result.ok).toBe(false)
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.recorder-mismatch", "error", STOCK, "/recorderTypes/0"],
    ])
  })

  it("recorder that is not a document gets no scope mismatch", async () => {
    const result = await compileScoped({
      [CP]: counterparty(),
      [STOCK]: register("user", [{ kind: "Catalog", name: "Counterparty" }]),
    })
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["register.recorder-kind", "/recorderTypes/0"],
    ])
  })

  it("register scope none differs from scoped recorder", async () => {
    const result = await compileScoped({
      [SALE]: document("Sale", { scope: "org" }),
      [STOCK]: register("none", [{ kind: "Document", name: "Sale" }]),
    })
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.recorder-mismatch", "error", STOCK, "/recorderTypes/0"],
    ])
  })

  it("reference to own root", async () => {
    const result = await compileScoped({
      [CP]: counterparty({
        attributes: [attribute("company", ref("Catalog", "Organization"))],
      }),
    })
    expect(result.ok).toBe(false)
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.root-self-reference", "error", CP, "/attributes/0/ref"],
    ])
  })

  it("reference to own root: рядок ТЧ, owner і ціль allowedTypes", async () => {
    const result = await compileScoped({
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

  it("reference to own root: crossScope дозволяє свідому межтенантну ціль", async () => {
    const result = await compileScoped({
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

  it("root references the root of its own kind", async () => {
    const attributes = (extra: Record<string, unknown>) => [
      attribute("head", ref("Catalog", "Organization", extra)),
    ]
    const bare = await compileScoped({
      [ORG]: organization({ attributes: attributes({}) }),
    })
    expect(scopeDiagnostics(bare)).toEqual([
      ["scope.root-self-reference", "error", ORG, "/attributes/0/ref"],
    ])
    const cross = await compileScoped({
      [ORG]: organization({ attributes: attributes({ crossScope: true }) }),
    })
    expect(scopeDiagnostics(cross)).toEqual([])
    expect(cross.ok).toBe(true)
  })

  it("root owner is the root of its own kind", async () => {
    const result = await compileScoped({
      [ORG]: organization({
        owners: [{ kind: "Catalog", name: "Organization" }],
      }),
    })
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.root-self-reference", "error", ORG, "/owners/0"],
    ])
  })

  it("hierarchical root", async () => {
    const result = await compileScoped({
      [ORG]: organization({ hierarchyType: "FoldersAndItems" }),
    })
    expect(result.ok).toBe(false)
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.root-hierarchy", "error", ORG, "/hierarchyType"],
    ])
  })

  it("reference to the root of another scope kind", async () => {
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
    const bare = await compileScoped(entries({}), project)
    expect(scopeDiagnostics(bare)).toEqual([
      ["scope.cross-kind", "error", CP, "/attributes/0/ref"],
      ["scope.cross-kind", "error", CP, "/attributes/1/allowedTypes/1"],
    ])
    const cross = await compileScoped(entries({ crossScope: true }), project)
    expect(scopeDiagnostics(cross)).toEqual([])
    expect(cross.ok).toBe(true)
  })

  it("misdeclared root gets only its own error", async () => {
    const result = await compileScoped({
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

  it("root must declare own kind", async () => {
    const result = await compileScoped({
      [ORG]: organization({ scope: "none" }),
    })
    expect(result.ok).toBe(false)
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.root-declaration", "error", ORG, "/scope"],
    ])
  })

  it("root must declare own kind: чужий вид", async () => {
    const result = await compileScoped({
      [ORG]: organization({ scope: "user" }),
    })
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.root-declaration", "error", ORG, "/scope"],
    ])
  })

  it("register cannot be a root", async () => {
    const base = scopedProject()
    const [first, ...rest] = base.scopeKinds
    const result = await compile(
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

  it("root without a single uuid key: composite PK, constant, enumeration", async () => {
    const cases: [string, string, string, Record<string, unknown>][] = [
      [
        "CustomTable",
        "Tenants",
        "custom-tables/Tenants/Tenants.meta.json",
        customTable("Tenants", {
          scope: "none",
          primaryKey: { columns: ["id", "other"] },
          columns: [
            {
              id: uuid(980),
              name: "id",
              physicalName: "id",
              type: "UUID",
              notNull: true,
            },
            {
              id: uuid(981),
              name: "other",
              physicalName: "other",
              type: "UUID",
              notNull: true,
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
      const result = await compile(
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

  it("custom table scope column must be uuid", async () => {
    const result = await compileScoped({
      [SETTINGS]: customTable("UserSettings", {
        scope: "user",
        scopeColumn: "owner",
        columns: [
          {
            id: uuid(970),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
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

  it("scoped custom table without scope column", async () => {
    const result = await compileScoped({
      [SETTINGS]: customTable("UserSettings", { scope: "user" }),
    })
    expect(scopeDiagnostics(result)).toEqual([
      ["scope.custom-table-column", "error", SETTINGS, ""],
    ])
  })

  it("scopeColumn without scope", async () => {
    const table = (overrides: Record<string, unknown>) =>
      customTable("UserSettings", { scopeColumn: "id", ...overrides })
    const none = await compileScoped({ [SETTINGS]: table({ scope: "none" }) })
    expect(scopeDiagnostics(none)).toEqual([
      ["scope.custom-table-column", "error", SETTINGS, "/scopeColumn"],
    ])
    // Однотенантний проєкт скоуп-правил не має, але хибна ознака лишається хибною.
    const single = await compile(
      metaFiles({ [PROJECT]: project(), [SETTINGS]: table({}) })
    )
    expect(scopeDiagnostics(single)).toEqual([
      ["scope.custom-table-column", "error", SETTINGS, "/scopeColumn"],
    ])
  })

  it("custom table with a uuid scope column is valid", async () => {
    const result = await compileScoped({
      [SETTINGS]: customTable("UserSettings", {
        scope: "user",
        scopeColumn: "owner",
        columns: [
          {
            id: uuid(970),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
          { id: uuid(971), name: "owner", physicalName: "owner", type: "UUID" },
        ],
      }),
    })
    expect(scopeDiagnostics(result)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("redundant crossScope is a warning", async () => {
    const result = await compileScoped({
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

  it("crossScope між скоупленими одного виду не зайвий", async () => {
    const result = await compileScoped({
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

  it("crossScope на поліморфному Ref зайвий, лише якщо зайвий для кожної цілі", async () => {
    const polymorphic = async (targets: { kind: string; name: string }[]) =>
      await compileScoped({
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
        await polymorphic([
          { kind: "Catalog", name: "Currency" },
          { kind: "Catalog", name: "Counterparty" },
        ])
      )
    ).toEqual([])
    // Корисна ціль не мусить іти останньою.
    expect(
      scopeDiagnostics(
        await polymorphic([
          { kind: "Catalog", name: "Counterparty" },
          { kind: "Catalog", name: "Currency" },
        ])
      )
    ).toEqual([])
    expect(
      scopeDiagnostics(
        await polymorphic([{ kind: "Catalog", name: "Currency" }])
      )
    ).toEqual([
      [
        "scope.cross-scope-redundant",
        "warning",
        CP,
        "/attributes/0/crossScope",
      ],
    ])
  })

  it("однотенантний проєкт: crossScope без діагностик", async () => {
    const result = await compile(
      metaFiles({
        [PROJECT]: project(),
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

  it("однотенантний проєкт не дає діагностик скоупу", async () => {
    const result = await compile(
      metaFiles({
        [PROJECT]: project(),
        [CP]: catalog("Counterparty", {
          attributes: [attribute("self", ref("Catalog", "Counterparty"))],
        }),
      })
    )
    expect(scopeDiagnostics(result)).toEqual([])
    expect(result.ok).toBe(true)
  })
})

/**
 * Скоуп-колонка стоїть не першою, а її ім'я — префікс сусідньої колонки:
 * пошук за іменем «першої схожої» тут схибив би, а індекс посилань — ні.
 */
function prefixedScopeTable(
  scope: string | undefined,
  types: { org: string; orgName: string } = { org: "UUID", orgName: "String" }
) {
  const column = (
    n: number,
    name: string,
    physicalName: string,
    type: string
  ) => ({
    id: uuid(n),
    name,
    physicalName,
    type,
    ...(type === "String" ? { length: 20 } : {}),
    notNull: true,
  })
  return customTable("UserSettings", {
    ...(scope === undefined ? {} : { scope }),
    scopeColumn: "org",
    columns: [
      column(980, "id", "id", "UUID"),
      column(981, "orgName", "org_name", types.orgName),
      column(982, "org", "org_id", types.org),
    ],
    primaryKey: { columns: ["id"] },
  })
}

describe("scope column is taken from the reference index", () => {
  it("stage 4 checks the indexed column", async () => {
    const valid = await compileScoped({ [SETTINGS]: prefixedScopeTable("org") })
    expect(scopeDiagnostics(valid)).toEqual([])
    const swapped = await compileScoped({
      [SETTINGS]: prefixedScopeTable("org", { org: "String", orgName: "UUID" }),
    })
    expect(scopeDiagnostics(swapped)).toEqual([
      ["scope.custom-table-column", "error", SETTINGS, "/scopeColumn"],
    ])
  })

  it("unscoped table reports the indexed column", async () => {
    const result = await compileScoped({
      [SETTINGS]: prefixedScopeTable("none"),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "scope.custom-table-column",
        pointer: "/scopeColumn",
        params: expect.objectContaining({ column: "org", unscoped: 1 }),
      }),
    ])
  })

  it("snapshot marks the indexed column", async () => {
    const projectFile = scopedProject()
    const orgKindId = projectFile.scopeKinds[0]!.id
    const result = await compileScoped(
      { [SETTINGS]: prefixedScopeTable("org") },
      projectFile
    )
    expect(result.diagnostics).toEqual([])
    const table = result.model!.physical.tables.find(
      (t) => t.name === "user_settings"
    )!
    expect(table.columns.map((c) => [c.name, c.origin])).toEqual([
      ["id", { elementId: uuid(980) }],
      ["org_name", { elementId: uuid(981) }],
      ["org_id", { elementId: uuid(982), scopeKindId: orgKindId }],
    ])
    // Названа скоуп-колонка лишається елементом опису: id елемента не губиться.
    const scopeColumn = table.columns.find((c) => c.name === "org_id")!
    expect(scopeColumn.origin.elementId).toBe(uuid(982))
    expect(scopeColumn.origin.scopeKindId).toBe(orgKindId)
  })
})
