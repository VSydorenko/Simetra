import { describe, expect, it } from "vitest"
import { compile, type CompileResult } from "simetra/compiler"
import {
  attribute,
  catalog,
  customTable,
  metaFiles,
  organization,
  project,
  scopedProject,
  uuid,
} from "./helpers"

const ORG = "catalogs/Organization/Organization.meta.json"
const CP = "catalogs/Counterparty/Counterparty.meta.json"
const TABLE = "custom-tables/Log/Log.meta.json"
const PROJECT = "project.meta.json"

async function compileScoped(
  entries: Record<string, unknown>,
  projectFile: unknown = scopedProject()
) {
  return await compile(
    metaFiles({
      [PROJECT]: projectFile,
      [ORG]: organization(),
      ...entries,
    })
  )
}

function codes(result: CompileResult) {
  return result.diagnostics.map((d) => [d.code, d.file, d.pointer])
}

describe("stage 2: scope identity", () => {
  it("scoped project compiles", async () => {
    const result = await compileScoped({
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

  it("missing declaration", async () => {
    const result = await compileScoped({ [CP]: catalog("Counterparty") })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "scope.declaration-missing",
        file: CP,
        pointer: "",
      }),
    ])
  })

  it("none is always allowed", async () => {
    const result = await compileScoped({
      [CP]: catalog("Counterparty", { scope: "none" }),
    })
    expect(result.diagnostics).toEqual([])
    const cp = result.model!.objects.find((o) => o.name === "Counterparty")!
    expect(cp.scopeKindId).toBeUndefined()
  })

  it("unknown kind", async () => {
    const result = await compileScoped({
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

  it("single-tenant project", async () => {
    const plain = await compile(
      metaFiles({ [PROJECT]: project(), [CP]: catalog("Counterparty") })
    )
    expect(plain.diagnostics).toEqual([])
    expect(plain.model!.scopeKinds).toEqual([])

    const scoped = await compile(
      metaFiles({
        [PROJECT]: project(),
        [CP]: catalog("Counterparty", { scope: "org" }),
      })
    )
    expect(codes(scoped)).toEqual([["scope.unknown-kind", CP, "/scope"]])
  })

  it("scope kind identity", async () => {
    const base = scopedProject()
    const noId = {
      ...base,
      scopeKinds: [
        { ...base.scopeKinds[0], id: undefined },
        base.scopeKinds[1],
      ],
    }
    expect(codes(await compileScoped({}, noId))).toEqual([
      ["identity.id-missing", PROJECT, "/scopeKinds/0/id"],
    ])

    const noPhysical = {
      ...base,
      scopeKinds: [
        { ...base.scopeKinds[0], physicalName: undefined },
        base.scopeKinds[1],
      ],
    }
    expect(codes(await compileScoped({}, noPhysical))).toEqual([
      ["identity.physical-name-missing", PROJECT, "/scopeKinds/0/physicalName"],
    ])

    const twice = {
      ...base,
      scopeKinds: [base.scopeKinds[0], { ...base.scopeKinds[1], name: "org" }],
    }
    expect(codes(await compileScoped({}, twice))).toEqual([
      ["identity.name-duplicate", PROJECT, "/scopeKinds/1/name"],
    ])

    const sameId = {
      ...base,
      scopeKinds: [
        base.scopeKinds[0],
        { ...base.scopeKinds[1], id: base.scopeKinds[0]!.id },
      ],
    }
    expect(codes(await compileScoped({}, sameId))).toEqual([
      ["identity.id-duplicate", PROJECT, "/scopeKinds/1/id"],
    ])
  })

  it("scope kind name follows the project style", async () => {
    const base = scopedProject()
    const styled = {
      ...base,
      scopeKinds: [
        base.scopeKinds[0],
        { ...base.scopeKinds[1], name: "app_user" },
      ],
    }
    expect(codes(await compileScoped({}, styled))).toEqual([
      ["identity.name-case", PROJECT, "/scopeKinds/1/name"],
    ])
  })

  it("unresolved root", async () => {
    const result = await compile(
      metaFiles({
        [PROJECT]: scopedProject(),
        [CP]: catalog("Counterparty", { scope: "none" }),
      })
    )
    expect(codes(result)).toEqual([
      ["reference.unresolved", PROJECT, "/scopeKinds/0/root/object"],
    ])
  })

  it("two scope kinds with the same object root", async () => {
    const base = scopedProject()
    const [first, second] = base.scopeKinds
    const result = await compileScoped(
      {},
      {
        ...base,
        scopeKinds: [first, { ...second, root: first!.root }],
      }
    )
    expect(result.ok).toBe(false)
    expect(codes(result)).toEqual([
      ["scope.root-duplicate", PROJECT, "/scopeKinds/1/root/object"],
    ])
  })

  it("two scope kinds with the same external root", async () => {
    const base = scopedProject()
    const [first, second] = base.scopeKinds
    const result = await compileScoped(
      {},
      {
        ...base,
        scopeKinds: [
          first,
          second,
          {
            ...second,
            id: uuid(990),
            name: "member",
            physicalName: "member_id",
          },
        ],
      }
    )
    expect(codes(result)).toEqual([
      ["scope.root-duplicate", PROJECT, "/scopeKinds/2/root/external"],
    ])
  })

  it("scope name collides with attribute", async () => {
    const result = await compileScoped({
      [CP]: catalog("Counterparty", {
        scope: "org",
        attributes: [attribute("org")],
      }),
    })
    expect(codes(result)).toEqual([
      ["scope.attribute-name-collision", CP, "/attributes/0/name"],
    ])
  })

  it("scope kind named like a standard attribute", async () => {
    const base = scopedProject()
    const renamed = {
      ...base,
      scopeKinds: [base.scopeKinds[0], { ...base.scopeKinds[1], name: "code" }],
    }
    const result = await compileScoped(
      { [CP]: catalog("Counterparty", { scope: "code", codeLength: 9 }) },
      renamed
    )
    expect(codes(result)).toEqual([
      ["scope.attribute-name-collision", CP, "/scope"],
    ])
    // Без коду в довідника імені `code` ніщо не займає.
    const noCode = await compileScoped(
      { [CP]: catalog("Counterparty", { scope: "code", codeLength: 0 }) },
      renamed
    )
    expect(codes(noCode)).toEqual([])
  })

  it("custom table may name a column like its scope kind", async () => {
    const result = await compileScoped({
      [TABLE]: customTable("Log", {
        scope: "org",
        scopeColumn: "org",
        columns: [
          { id: uuid(991), name: "id", physicalName: "id", type: "UUID" },
          { id: uuid(992), name: "org", physicalName: "org_id", type: "UUID" },
        ],
      }),
    })
    expect(codes(result)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("scope name collides with a tabular section row attribute", async () => {
    const result = await compileScoped({
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

  it("scope root may use the scope name for its own attribute", async () => {
    const result = await compileScoped({
      [ORG]: organization({ attributes: [attribute("org")] }),
    })
    expect(result.diagnostics).toEqual([])
  })

  it("custom table scope column must exist", async () => {
    const result = await compileScoped({
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

  it("references index", async () => {
    const result = await compileScoped({
      [CP]: catalog("Counterparty", { scope: "org" }),
      [TABLE]: customTable("Log", { scope: "org", scopeColumn: "id" }),
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
        to: { kind: "Element", id: column.id },
      })
    )
  })

  it("does not crash on a broken project", async () => {
    const result = await compile(
      metaFiles({
        [PROJECT]: "{",
        [CP]: catalog("Counterparty", { scope: "org" }),
      })
    )
    expect(result.ok).toBe(false)
  })
})
