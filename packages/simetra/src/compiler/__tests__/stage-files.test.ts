import { describe, expect, it } from "vitest"
import { compile, localize, type Diagnostic } from "simetra/compiler"
import {
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  project,
  salesDocument,
  SALE_FILE,
  scopedProject,
  STOCK_FILE,
} from "./helpers"

function codes(diagnostics: Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code)
}

describe("stage 1: files", () => {
  it("empty map reports project.missing", async () => {
    const result = await compile(new Map())
    expect(result.ok).toBe(false)
    expect(result.model).toBeUndefined()
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "project.missing",
        severity: "error",
        file: "project.meta.json",
        pointer: "",
      }),
    ])
  })

  it("valid minimal project compiles with ok true and no diagnostics", async () => {
    const contract = catalog("Contract")
    const order = document("SalesOrder")
    const table = customTable("AuditLog")
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": contract,
        "catalogs/Contract/Contract.module.ts": "export {}",
        "documents/SalesOrder/SalesOrder.meta.json": order,
        "custom-tables/AuditLog/AuditLog.meta.json": table,
        "custom-tables/AuditLog/AuditLog.sql":
          "COMMENT ON TABLE audit_log IS 'Audit';",
      })
    )
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
    const model = result.model!
    expect(model.project.name).toBe("TestApp")
    // Порядок: METADATA_KINDS, далі ім'я.
    expect(model.objects.map((o) => [o.kind, o.name, o.id])).toEqual([
      ["Catalog", "Contract", contract.id],
      ["Document", "SalesOrder", order.id],
      ["CustomTable", "AuditLog", table.id],
    ])
    expect(model.moduleFiles).toEqual([
      {
        file: "catalogs/Contract/Contract.module.ts",
        ownerObjectId: contract.id,
      },
    ])
    expect(
      model.sqlUnits.map(({ identity, file, ownerObjectId }) => ({
        identity,
        file,
        ownerObjectId,
      }))
    ).toEqual([
      {
        identity: "comment:table:public.audit_log",
        file: "custom-tables/AuditLog/AuditLog.sql",
        ownerObjectId: table.id,
      },
    ])
    expect(model.physical.tables.map((t) => `${t.schema}.${t.name}`)).toEqual([
      "public.audit_log",
      "public.contract",
      "public.sales_order",
    ])
  })

  it("kind mismatch", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": document("Contract"),
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "file.kind-mismatch",
        file: "catalogs/Contract/Contract.meta.json",
        pointer: "/kind",
      }),
    ])
  })

  it("folder and file name must equal logical name", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/contract/contract.meta.json": catalog("Contract"),
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "file.name-mismatch",
        file: "catalogs/contract/contract.meta.json",
        pointer: "/name",
      }),
    ])
  })

  it("unknown path", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": catalog("Contract"),
        "catalogs/Contract/notes.txt": "notes",
        "foo.json": "{}",
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "file.unknown-path",
        file: "catalogs/Contract/notes.txt",
        pointer: "",
      }),
      expect.objectContaining({
        code: "file.unknown-path",
        file: "foo.json",
        pointer: "",
      }),
    ])
  })

  it("orphan sql", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.sql": "select 1;",
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "file.orphan",
        file: "catalogs/Contract/Contract.sql",
      }),
    ])
  })

  it("shared sql is registered", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "sql/app/scope_sets.sql":
          "CREATE FUNCTION set_scope() RETURNS void LANGUAGE sql AS $$ select $$;",
      })
    )
    expect(result.ok).toBe(true)
    const [unit] = result.model!.sqlUnits
    expect(unit).toMatchObject({
      identity: "function:app.set_scope()",
      file: "sql/app/scope_sets.sql",
      schema: "app",
    })
    expect(unit!.ownerObjectId).toBeUndefined()
  })

  it("invalid json", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": "{ not json",
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "file.invalid-json",
        file: "catalogs/Contract/Contract.meta.json",
        pointer: "",
      }),
    ])
  })

  it("lone surrogate in a value or a key is a file error, not a throw", async () => {
    // `"\ud800"` — синтаксично коректний JSON, який Zod пропускає, але
    // канонізація хешу (I-JSON) на ньому кидала б: compile мусить повернути
    // діагностику з pointer, а не відхилити проміс.
    const file = "catalogs/Contract/Contract.meta.json"
    const compileWith = (data: unknown) =>
      compile(metaFiles({ "project.meta.json": project(), [file]: data }))

    const control = await compileWith(
      catalog("Contract", { title: { en: "ok" } })
    )
    expect(control.ok).toBe(true)

    const inValue = await compileWith(
      catalog("Contract", { title: { en: "\ud800" } })
    )
    expect(inValue.ok).toBe(false)
    expect(inValue.diagnostics).toEqual([
      expect.objectContaining({
        code: "file.invalid-json",
        file,
        pointer: "/title/en",
        range: expect.any(Object),
      }),
    ])

    const inKey = await compileWith(
      catalog("Contract", {
        standardAttributeOverrides: { "a\udc00": { description: { en: "x" } } },
      })
    )
    expect(inKey.ok).toBe(false)
    expect(inKey.diagnostics).toEqual([
      expect.objectContaining({
        code: "file.invalid-json",
        file,
        pointer: "/standardAttributeOverrides/a\udc00",
      }),
    ])
    expect(localize(inKey.diagnostics[0]!, "en").message).toBe(
      "Invalid JSON: lone surrogate (RFC 7493 I-JSON)"
    )
  })

  it("schema rule code survives mapping", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          attributes: [attribute("note", { type: "String" })],
        }),
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "type.length-required",
        pointer: "/attributes/0/length",
        message: expect.any(String),
      }),
    ])
  })

  it("zod issue without own rule maps to file.schema with zod text", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          codeLength: "nine",
        }),
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "file.schema", pointer: "/codeLength" }),
    ])
    expect(result.diagnostics[0]!.message.length).toBeGreaterThan(0)
  })

  it("malformed reference points at the ref field, not the whole file", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          attributes: [
            attribute("party", {
              type: "Ref",
              ref: { kind: "Foo", name: "X" },
            }),
          ],
        }),
        "catalogs/Order/Order.meta.json": catalog("Order", {
          attributes: [
            attribute("currency", {
              type: "Ref",
              ref: { kind: "Catalog", name: "currency" },
            }),
          ],
        }),
      })
    )
    expect(result.diagnostics.map((d) => [d.code, d.file, d.pointer])).toEqual([
      [
        "file.schema",
        "catalogs/Contract/Contract.meta.json",
        "/attributes/0/ref/kind",
      ],
      [
        "file.schema",
        "catalogs/Order/Order.meta.json",
        "/attributes/0/ref/name",
      ],
    ])
  })

  it("all diagnostics of stages 1-2 are returned", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": "{",
        "documents/Order/Order.meta.json": catalog("Order"),
      })
    )
    expect(codes(result.diagnostics)).toEqual([
      "file.invalid-json",
      "file.kind-mismatch",
    ])
    expect(result.diagnostics.map((d) => d.file)).toEqual([
      "catalogs/Contract/Contract.meta.json",
      "documents/Order/Order.meta.json",
    ])
  })

  it("output does not depend on map insertion order", async () => {
    const entries = {
      "project.meta.json": project(),
      "catalogs/B/B.meta.json": catalog("B", { id: undefined }),
      "catalogs/A/A.meta.json": "{",
      "zzz.txt": "",
      "catalogs/C/C.meta.json": catalog("C"),
    }
    const forward = await compile(metaFiles(entries))
    const backward = await compile(new Map([...metaFiles(entries)].reverse()))
    expect(backward).toEqual(forward)
  })

  it("posting expression parse error becomes posting.parse with offset", async () => {
    const order = {
      ...document("SalesOrder"),
      posting: {
        movements: [
          {
            register: { kind: "AccumulationRegister", name: "Stock" },
            source: "document",
            movementType: "Receipt",
            fields: { qty: "row.qty +" },
          },
        ],
      },
    }
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "documents/SalesOrder/SalesOrder.meta.json": order,
      })
    )
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "posting.parse",
        pointer: "/posting/movements/0/fields/qty",
        params: expect.objectContaining({ offset: 9 }),
      })
    )
  })
})

describe("stage 1: strict schemas", () => {
  /** Діагностики `file.unknown-key` як [файл, pointer, ключ]. */
  function unknownKeys(diagnostics: Diagnostic[]) {
    return diagnostics
      .filter((d) => d.code === "file.unknown-key")
      .map((d) => [d.file, d.pointer, d.params?.key])
  }

  it("unknown key at the object level", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          codeLenght: 5,
        }),
      })
    )
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "file.unknown-key",
        severity: "error",
        file: "catalogs/Contract/Contract.meta.json",
        pointer: "/codeLenght",
        params: { key: "codeLenght" },
      }),
    ])
  })

  it("unknown key in an attribute", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          attributes: [
            attribute("note", { type: "String", length: 10, lenght: 10 }),
          ],
        }),
      })
    )
    expect(unknownKeys(result.diagnostics)).toEqual([
      [
        "catalogs/Contract/Contract.meta.json",
        "/attributes/0/lenght",
        "lenght",
      ],
    ])
  })

  it("unknown key in a tabular section", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "documents/Order/Order.meta.json": document("Order", {
          tabularSections: [
            {
              id: "00000000-0000-4000-8000-000000009001",
              name: "goods",
              physicalName: "goods",
              rows: [],
            },
          ],
        }),
      })
    )
    expect(unknownKeys(result.diagnostics)).toEqual([
      ["documents/Order/Order.meta.json", "/tabularSections/0/rows", "rows"],
    ])
  })

  it("crossScope is an unknown key on a custom table column", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "custom-tables/AuditLog/AuditLog.meta.json": customTable("AuditLog", {
          columns: [
            {
              id: "00000000-0000-4000-8000-000000009002",
              name: "id",
              physicalName: "id",
              type: "UUID",
              crossScope: true,
            },
          ],
        }),
      })
    )
    expect(unknownKeys(result.diagnostics)).toEqual([
      [
        "custom-tables/AuditLog/AuditLog.meta.json",
        "/columns/0/crossScope",
        "crossScope",
      ],
    ])
  })

  it("unknown key in a movement constructor entry", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        ...salesDocument({ perod: "doc.date" }),
      })
    )
    expect(unknownKeys(result.diagnostics)).toEqual([
      [SALE_FILE, "/posting/movements/0/perod", "perod"],
    ])
  })

  it("unknown key in a scope kind of the project", async () => {
    const scoped = scopedProject()
    scoped.scopeKinds[0] = { ...scoped.scopeKinds[0], onDelete: "cascade" }
    const result = await compile(metaFiles({ "project.meta.json": scoped }))
    expect(unknownKeys(result.diagnostics)).toEqual([
      ["project.meta.json", "/scopeKinds/0/onDelete", "onDelete"],
    ])
  })

  it("unknown key inside a union variant points into the variant", async () => {
    const scoped = scopedProject()
    scoped.scopeKinds[1] = {
      ...scoped.scopeKinds[1],
      root: {
        external: { schema: "auth", table: "users", column: "id", key: "id" },
      },
    }
    const result = await compile(metaFiles({ "project.meta.json": scoped }))
    expect(unknownKeys(result.diagnostics)).toEqual([
      ["project.meta.json", "/scopeKinds/1/root/external/key", "key"],
    ])
  })

  it("ref on an accumulation register resource is an unknown key", async () => {
    const files = salesDocument()
    const stock = files[STOCK_FILE] as { resources: Record<string, unknown>[] }
    stock.resources[0] = {
      ...stock.resources[0],
      ref: { kind: "Catalog", name: "Item" },
    }
    const result = await compile(
      metaFiles({ "project.meta.json": project(), ...files })
    )
    expect(unknownKeys(result.diagnostics)).toEqual([
      [STOCK_FILE, "/resources/0/ref", "ref"],
    ])
  })

  it("an accumulation register resource of a wrong type keeps register.resource-type", async () => {
    const files = salesDocument()
    const stock = files[STOCK_FILE] as { resources: Record<string, unknown>[] }
    stock.resources[0] = { ...stock.resources[0], type: "Text" }
    stock.resources[0] = Object.fromEntries(
      Object.entries(stock.resources[0]!).filter(
        ([key]) => key !== "precision" && key !== "scale"
      )
    )
    const result = await compile(
      metaFiles({ "project.meta.json": project(), ...files })
    )
    expect(
      result.diagnostics
        .filter((d) => d.file === STOCK_FILE)
        .map((d) => [d.code, d.pointer])
    ).toEqual([["register.resource-type", "/resources/0/type"]])
  })

  it("one diagnostic per unknown key", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          zeta: 1,
          alpha: 2,
        }),
      })
    )
    expect(unknownKeys(result.diagnostics)).toEqual([
      ["catalogs/Contract/Contract.meta.json", "/alpha", "alpha"],
      ["catalogs/Contract/Contract.meta.json", "/zeta", "zeta"],
    ])
  })

  it("$schema is allowed at the top of object and project files", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project({
          $schema: "../node_modules/simetra/schemas/project.schema.json",
        }),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          $schema: "../../node_modules/simetra/schemas/catalogs.schema.json",
        }),
      })
    )
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("$schema is not allowed below the top of a file", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          attributes: [attribute("flag", { $schema: "x" })],
        }),
      })
    )
    expect(unknownKeys(result.diagnostics)).toEqual([
      [
        "catalogs/Contract/Contract.meta.json",
        "/attributes/0/$schema",
        "$schema",
      ],
    ])
  })

  it("unknown keys do not shift the Ukrainian text of other schema issues", async () => {
    // Issue з двома ключами (title) іде перед іншими issue схеми й дає дві
    // діагностики: український текст має братися за індексом issue.
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          title: { uk: "Договір", a: 1, b: 2 },
          codeLength: "nine",
          codeType: "Hex",
        }),
      })
    )
    const uk = Object.fromEntries(
      result.diagnostics
        .filter((d) => d.code === "file.schema")
        .map((d) => [d.pointer, localize(d, "uk").message])
    )
    expect(uk["/codeLength"]).toMatch(/очікується число/)
    expect(uk["/codeType"]).toMatch(/"String"\|"Number"/)
    expect(unknownKeys(result.diagnostics)).toEqual([
      ["catalogs/Contract/Contract.meta.json", "/title/a", "a"],
      ["catalogs/Contract/Contract.meta.json", "/title/b", "b"],
    ])
  })

  it("the range of an unknown key covers the key itself", async () => {
    const text = [
      "{",
      '  "kind": "Catalog",',
      '  "name": "Contract",',
      '  "lenght": 5',
      "}",
    ].join("\n")
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": text,
      })
    )
    const d = result.diagnostics.find((x) => x.code === "file.unknown-key")
    expect(d?.range).toEqual({
      start: { line: 3, character: 2 },
      end: { line: 3, character: 10 },
    })
  })
})
