import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  attribute,
  catalog,
  customTable,
  metaFiles,
  organization,
  project,
  scopedProject,
} from "./helpers"

const ORG = "catalogs/Organization/Organization.meta.json"
const CP = "catalogs/Counterparty/Counterparty.meta.json"
const TABLE = "custom-tables/Log/Log.meta.json"
const PROJECT = "project.meta.json"

function compileScoped(
  entries: Record<string, unknown>,
  projectFile: unknown = scopedProject()
) {
  return compile(
    metaFiles({
      [PROJECT]: projectFile,
      [ORG]: organization(),
      ...entries,
    })
  )
}

function codes(result: ReturnType<typeof compile>) {
  return result.diagnostics.map((d) => [d.code, d.file, d.pointer])
}

describe("stage 2: scope identity", () => {
  it("scoped project compiles", () => {
    const result = compileScoped({
      [CP]: catalog("Counterparty", { scope: "org" }),
    })
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
    const model = result.model!
    expect(model.scopeKinds.map((kind) => kind.name)).toEqual(["org", "user"])
    const org = model.scopeKinds[0]!
    const cp = model.objects.find((o) => o.name === "Counterparty")!
    const root = model.objects.find((o) => o.name === "Organization")!
    expect(cp.scopeKindId).toBe(org.id)
    expect(root.scopeKindId).toBe(org.id)
    expect(org.root).toEqual({ objectId: root.id })
    expect(org.setFunction).toEqual({ schema: "public", name: "org_ids" })
    expect(org.onRootDelete).toBe("restrict")
    expect(model.scopeKinds[1]!.root).toEqual({
      external: { schema: "auth", table: "users", column: "id" },
    })
  })

  it("missing declaration", () => {
    const result = compileScoped({ [CP]: catalog("Counterparty") })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "scope.declaration-missing",
        file: CP,
        pointer: "",
      }),
    ])
  })

  it("none is always allowed", () => {
    const result = compileScoped({
      [CP]: catalog("Counterparty", { scope: "none" }),
    })
    expect(result.diagnostics).toEqual([])
    const cp = result.model!.objects.find((o) => o.name === "Counterparty")!
    expect(cp.scopeKindId).toBeUndefined()
  })

  it("unknown kind", () => {
    const result = compileScoped({
      [CP]: catalog("Counterparty", { scope: "tenant" }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "scope.unknown-kind",
        file: CP,
        pointer: "/scope",
      }),
    ])
  })

  it("single-tenant project", () => {
    const plain = compile(
      metaFiles({ [PROJECT]: project(), [CP]: catalog("Counterparty") })
    )
    expect(plain.diagnostics).toEqual([])
    expect(plain.model!.scopeKinds).toEqual([])

    const scoped = compile(
      metaFiles({
        [PROJECT]: project(),
        [CP]: catalog("Counterparty", { scope: "org" }),
      })
    )
    expect(codes(scoped)).toEqual([["scope.unknown-kind", CP, "/scope"]])
  })

  it("scope kind identity", () => {
    const base = scopedProject()
    const noId = {
      ...base,
      scopeKinds: [
        { ...base.scopeKinds[0], id: undefined },
        base.scopeKinds[1],
      ],
    }
    expect(codes(compileScoped({}, noId))).toEqual([
      ["identity.id-missing", PROJECT, "/scopeKinds/0/id"],
    ])

    const noPhysical = {
      ...base,
      scopeKinds: [
        { ...base.scopeKinds[0], physicalName: undefined },
        base.scopeKinds[1],
      ],
    }
    expect(codes(compileScoped({}, noPhysical))).toEqual([
      ["identity.physical-name-missing", PROJECT, "/scopeKinds/0/physicalName"],
    ])

    const twice = {
      ...base,
      scopeKinds: [base.scopeKinds[0], { ...base.scopeKinds[1], name: "org" }],
    }
    expect(codes(compileScoped({}, twice))).toEqual([
      ["identity.name-duplicate", PROJECT, "/scopeKinds/1/name"],
    ])

    const sameId = {
      ...base,
      scopeKinds: [
        base.scopeKinds[0],
        { ...base.scopeKinds[1], id: base.scopeKinds[0]!.id },
      ],
    }
    expect(codes(compileScoped({}, sameId))).toEqual([
      ["identity.id-duplicate", PROJECT, "/scopeKinds/1/id"],
    ])
  })

  it("scope kind name follows the project style", () => {
    const base = scopedProject()
    const styled = {
      ...base,
      scopeKinds: [
        base.scopeKinds[0],
        { ...base.scopeKinds[1], name: "app_user" },
      ],
    }
    expect(codes(compileScoped({}, styled))).toEqual([
      ["identity.name-case", PROJECT, "/scopeKinds/1/name"],
    ])
  })

  it("unresolved root", () => {
    const result = compile(
      metaFiles({
        [PROJECT]: scopedProject(),
        [CP]: catalog("Counterparty", { scope: "none" }),
      })
    )
    expect(codes(result)).toEqual([
      ["reference.unresolved", PROJECT, "/scopeKinds/0/root/object"],
    ])
  })

  it("scope name collides with attribute", () => {
    const result = compileScoped({
      [CP]: catalog("Counterparty", {
        scope: "org",
        attributes: [attribute("org")],
      }),
    })
    expect(codes(result)).toEqual([
      ["scope.attribute-name-collision", CP, "/attributes/0/name"],
    ])
  })

  it("scope name collides with a tabular section row attribute", () => {
    const result = compileScoped({
      [CP]: catalog("Counterparty", {
        scope: "org",
        tabularSections: [
          {
            id: "00000000-0000-4000-8000-000000009001",
            name: "lines",
            physicalName: "lines",
            attributes: [attribute("org")],
          },
        ],
      }),
    })
    expect(codes(result)).toEqual([
      [
        "scope.attribute-name-collision",
        CP,
        "/tabularSections/0/attributes/0/name",
      ],
    ])
  })

  it("scope root may use the scope name for its own attribute", () => {
    const result = compileScoped({
      [ORG]: organization({ attributes: [attribute("org")] }),
    })
    expect(result.diagnostics).toEqual([])
  })

  it("custom table scope column must exist", () => {
    const result = compileScoped({
      [TABLE]: customTable("Log", { scope: "none", scopeColumn: "tenant" }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "customTable.column-unknown",
        file: TABLE,
        pointer: "/scopeColumn",
      }),
    ])
  })

  it("references index", () => {
    const result = compileScoped({
      [CP]: catalog("Counterparty", { scope: "org" }),
      [TABLE]: customTable("Log", { scope: "none", scopeColumn: "id" }),
    })
    expect(result.diagnostics).toEqual([])
    const { references, scopeKinds, objects } = result.model!
    const org = scopeKinds[0]!
    const table = objects.find((o) => o.name === "Log")!
    const column = (table.data as { columns: { id: string }[] }).columns[0]!
    expect(references).toContainEqual(
      expect.objectContaining({
        role: "object.scope",
        from: expect.objectContaining({ file: CP, pointer: "/scope" }),
        to: { kind: "ScopeKind", id: org.id },
      })
    )
    expect(references).toContainEqual(
      expect.objectContaining({
        role: "scopeKind.root",
        from: expect.objectContaining({
          file: PROJECT,
          pointer: "/scopeKinds/0/root/object",
          objectId: org.id,
        }),
        to: {
          kind: "Catalog",
          id: (org.root as { objectId: string }).objectId,
        },
      })
    )
    expect(references).toContainEqual(
      expect.objectContaining({
        role: "customTable.scopeColumn",
        from: expect.objectContaining({ file: TABLE, pointer: "/scopeColumn" }),
        to: { kind: "Column", id: column.id },
      })
    )
  })

  it("does not crash on a broken project", () => {
    const result = compile(
      metaFiles({
        [PROJECT]: "{",
        [CP]: catalog("Counterparty", { scope: "org" }),
      })
    )
    expect(result.ok).toBe(false)
  })
})
