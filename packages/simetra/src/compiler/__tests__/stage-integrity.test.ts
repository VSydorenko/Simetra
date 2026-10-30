import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  acceptDebt,
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

async function compileWith(entries: Record<string, unknown>) {
  return await compile(
    metaFiles({ "project.meta.json": project(), ...entries })
  )
}

const NOTE = "catalogs/Note/Note.meta.json"

function register(name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(700 + name.length),
    kind: "InformationRegister",
    name,
    physicalName: name.toLowerCase(),
    kindLabel: name.toLowerCase(),
    ...overrides,
  }
}

const ENUMERATION = {
  id: uuid(730),
  kind: "Enumeration",
  name: "Status",
  physicalName: "status",
  values: [{ id: uuid(731), name: "Open", physicalName: "open" }],
}

const CONSTANT = {
  id: uuid(710),
  kind: "Constant",
  name: "Rate",
  physicalName: "rate",
  kindLabel: "rate",
  type: "Integer",
}

function refTo(kind: string, name: string) {
  return { type: "Ref", ref: { kind, name } }
}

describe("stage 4: integrity", () => {
  it("reference to a register is not referenceable", async () => {
    const result = await compileWith({
      "information-registers/Prices/Prices.meta.json": register("Prices"),
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("price", refTo("InformationRegister", "Prices")),
        ],
      }),
    })
    expect(result.ok).toBe(false)
    expect(result.model).toBeUndefined()
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "reference.not-referenceable",
        severity: "error",
        file: NOTE,
        pointer: "/attributes/0/ref",
      }),
    ])
  })

  it("reference to a constant or pg enum is not referenceable", async () => {
    const result = await compileWith({
      "constants/Rate/Rate.meta.json": {
        id: uuid(710),
        kind: "Constant",
        name: "Rate",
        physicalName: "rate",
        kindLabel: "rate",
        type: "Integer",
      },
      "pg-enums/Mood/Mood.meta.json": {
        id: uuid(711),
        kind: "PgEnum",
        name: "Mood",
        physicalName: "mood",
        values: ["ok"],
      },
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("subject", {
            type: "Ref",
            allowedTypes: [
              { kind: "Constant", name: "Rate" },
              { kind: "PgEnum", name: "Mood" },
            ],
          }),
        ],
      }),
    })
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["reference.not-referenceable", "/attributes/0/allowedTypes/0"],
      ["reference.not-referenceable", "/attributes/0/allowedTypes/1"],
    ])
  })

  it("pg enum column of a custom table is allowed", async () => {
    const result = await compileWith({
      "pg-enums/Mood/Mood.meta.json": {
        id: uuid(711),
        kind: "PgEnum",
        name: "Mood",
        physicalName: "mood",
        values: ["ok"],
      },
      "custom-tables/Diary/Diary.meta.json": customTable("Diary", {
        columns: [
          {
            id: uuid(712),
            name: "mood",
            physicalName: "mood",
            type: "PgEnum",
            enum: { kind: "PgEnum", name: "Mood" },
          },
        ],
      }),
    })
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("reference to a custom table without a single uuid primary key", async () => {
    const result = await compileWith({
      "custom-tables/Log/Log.meta.json": customTable("Log", {
        columns: [
          {
            id: uuid(720),
            name: "id",
            physicalName: "id",
            type: "BigInt",
            notNull: true,
          },
        ],
        primaryKey: { columns: ["id"] },
      }),
      "custom-tables/Raw/Raw.meta.json": customTable("Raw"),
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("log", refTo("CustomTable", "Log")),
          attribute("raw", refTo("CustomTable", "Raw")),
        ],
      }),
    })
    expect(
      result.diagnostics.map((d) => [d.code, d.severity, d.file, d.pointer])
    ).toEqual([
      ["reference.custom-table-key", "error", NOTE, "/attributes/0/ref"],
      ["reference.custom-table-key", "error", NOTE, "/attributes/1/ref"],
    ])
  })

  it("ref to a custom table with a deferrable uuid primary key", async () => {
    const table = (
      name: string,
      n: number,
      overrides: Record<string, unknown>
    ) =>
      customTable(name, {
        columns: [
          {
            id: uuid(n),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
        ],
        ...overrides,
      })
    const result = await compileWith({
      "custom-tables/Log/Log.meta.json": table("Log", 733, {
        primaryKey: { columns: ["id"], deferrable: "initiallyDeferred" },
      }),
      // Невідкладений UNIQUE на тій самій колонці — законна ціль FK.
      "custom-tables/Pair/Pair.meta.json": table("Pair", 734, {
        primaryKey: { columns: ["id"], deferrable: "deferrable" },
        uniques: [{ name: "pair_id_key", columns: ["id"] }],
      }),
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("log", refTo("CustomTable", "Log")),
          attribute("pair", refTo("CustomTable", "Pair")),
          // Масив посилань FK не має.
          attribute("logs", { ...refTo("CustomTable", "Log"), array: true }),
          attribute("anyLog", {
            type: "Ref",
            allowedTypes: [{ kind: "CustomTable", name: "Log" }],
          }),
        ],
      }),
      "constants/Main/Main.meta.json": {
        ...CONSTANT,
        name: "Main",
        physicalName: "main",
        ...refTo("CustomTable", "Log"),
      },
    })
    expect(
      result.diagnostics.map((d) => [d.code, d.severity, d.file, d.pointer])
    ).toEqual([
      [
        "reference.custom-table-deferrable-key",
        "error",
        NOTE,
        "/attributes/0/ref",
      ],
      [
        "reference.custom-table-deferrable-key",
        "error",
        "constants/Main/Main.meta.json",
        "/ref",
      ],
    ])
  })

  it("catalog owner must be a catalog", async () => {
    const result = await compileWith({
      "enumerations/Status/Status.meta.json": ENUMERATION,
      "documents/Invoice/Invoice.meta.json": document("Invoice"),
      "custom-tables/Log/Log.meta.json": customTable("Log", {
        columns: [
          {
            id: uuid(732),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
        ],
        primaryKey: { columns: ["id"] },
      }),
      "constants/Rate/Rate.meta.json": CONSTANT,
      "catalogs/Owner/Owner.meta.json": catalog("Owner"),
      [NOTE]: catalog("Note", {
        owners: [
          { kind: "Enumeration", name: "Status" },
          { kind: "Document", name: "Invoice" },
          { kind: "CustomTable", name: "Log" },
          { kind: "Constant", name: "Rate" },
          { kind: "Catalog", name: "Owner" },
        ],
      }),
    })
    expect(result.diagnostics.map((d) => [d.code, d.file, d.pointer])).toEqual([
      ["catalog.owner-kind", NOTE, "/owners/0"],
      ["catalog.owner-kind", NOTE, "/owners/1"],
      ["catalog.owner-kind", NOTE, "/owners/2"],
      ["catalog.owner-kind", NOTE, "/owners/3"],
    ])
  })

  it("catalog owned by a catalog is clean", async () => {
    const result = await compileWith({
      "catalogs/Owner/Owner.meta.json": catalog("Owner"),
      [NOTE]: catalog("Note", {
        owners: [{ kind: "Catalog", name: "Owner" }],
      }),
    })
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("enumeration cannot be a target of a polymorphic ref", async () => {
    const result = await compileWith({
      "enumerations/Status/Status.meta.json": ENUMERATION,
      "catalogs/Owner/Owner.meta.json": catalog("Owner"),
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("subject", {
            type: "Ref",
            allowedTypes: [
              { kind: "Catalog", name: "Owner" },
              { kind: "Enumeration", name: "Status" },
            ],
          }),
        ],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "reference.polymorphic-target-kind",
        severity: "error",
        file: NOTE,
        pointer: "/attributes/0/allowedTypes/1",
      }),
    ])
  })

  it("enumeration cannot be a target of a polymorphic constant", async () => {
    const result = await compileWith({
      "enumerations/Status/Status.meta.json": ENUMERATION,
      "catalogs/Owner/Owner.meta.json": catalog("Owner"),
      "constants/Subject/Subject.meta.json": {
        id: uuid(733),
        kind: "Constant",
        name: "Subject",
        physicalName: "subject",
        kindLabel: "subject",
        type: "Ref",
        allowedTypes: [
          { kind: "Enumeration", name: "Status" },
          { kind: "Catalog", name: "Owner" },
        ],
      },
    })
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["reference.polymorphic-target-kind", "/allowedTypes/0"],
    ])
  })

  it("catalog and document are valid polymorphic targets", async () => {
    const result = await compileWith({
      "catalogs/Owner/Owner.meta.json": catalog("Owner"),
      "documents/Invoice/Invoice.meta.json": document("Invoice"),
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("subject", {
            type: "Ref",
            allowedTypes: [
              { kind: "Catalog", name: "Owner" },
              { kind: "Document", name: "Invoice" },
            ],
          }),
        ],
      }),
    })
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("custom table without a uuid key in allowedTypes reports the key once", async () => {
    const result = await compileWith({
      "custom-tables/Log/Log.meta.json": customTable("Log", {
        columns: [
          {
            id: uuid(734),
            name: "id",
            physicalName: "id",
            type: "BigInt",
            notNull: true,
          },
        ],
        primaryKey: { columns: ["id"] },
      }),
      "catalogs/Owner/Owner.meta.json": catalog("Owner"),
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("subject", {
            type: "Ref",
            allowedTypes: [
              { kind: "Catalog", name: "Owner" },
              { kind: "CustomTable", name: "Log" },
            ],
          }),
        ],
      }),
    })
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["reference.custom-table-key", "/attributes/0/allowedTypes/1"],
    ])
  })

  it("register recorder must be a document", async () => {
    const result = await compileWith({
      "enumerations/Status/Status.meta.json": ENUMERATION,
      "documents/Invoice/Invoice.meta.json": document("Invoice"),
      "catalogs/Owner/Owner.meta.json": catalog("Owner"),
      "information-registers/Log/Log.meta.json": register("Log", {
        writeMode: "RecorderSubordinate",
        recorderTypes: [
          { kind: "Document", name: "Invoice" },
          { kind: "Enumeration", name: "Status" },
          // Uuid-ключ довідника реєстратором його не робить: рухи пише проведення.
          { kind: "Catalog", name: "Owner" },
        ],
      }),
    })
    expect(result.diagnostics.map((d) => [d.code, d.file, d.pointer])).toEqual([
      [
        "register.recorder-kind",
        "information-registers/Log/Log.meta.json",
        "/recorderTypes/1",
      ],
      [
        "register.recorder-kind",
        "information-registers/Log/Log.meta.json",
        "/recorderTypes/2",
      ],
    ])
  })

  it("two tables with the same physicalName in one schema", async () => {
    const result = await compileWith({
      "catalogs/A/A.meta.json": catalog("A", { physicalName: "shared" }),
      "documents/B/B.meta.json": document("B", { physicalName: "shared" }),
    })
    // Імена похідних функцій від таблиці (тут — функції ефектів, Р2b1-11)
    // теж збігаються.
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "physical.function-duplicate",
        severity: "error",
        file: "documents/B/B.meta.json",
        pointer: "/physicalName",
      }),
      expect.objectContaining({
        code: "physical.table-duplicate",
        severity: "error",
        file: "documents/B/B.meta.json",
        pointer: "/physicalName",
      }),
    ])
  })

  it("same physicalName in different schemas is fine", async () => {
    const result = await compileWith({
      "catalogs/A/A.meta.json": catalog("A", { physicalName: "shared" }),
      "documents/B/B.meta.json": document("B", {
        physicalName: "shared",
        schema: "sales",
      }),
    })
    expect(result.diagnostics).toEqual([])
  })

  it("tabular section and enum type share the table namespace", async () => {
    const result = await compileWith({
      "catalogs/A/A.meta.json": catalog("A", {
        tabularSections: [
          {
            id: uuid(730),
            name: "lines",
            physicalName: "mood",
            attributes: [],
          },
        ],
      }),
      "pg-enums/Mood/Mood.meta.json": {
        id: uuid(731),
        kind: "PgEnum",
        name: "Mood",
        physicalName: "mood",
        values: ["ok"],
      },
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "physical.table-duplicate",
        file: "pg-enums/Mood/Mood.meta.json",
        pointer: "/physicalName",
      }),
    ])
  })

  it("attribute column collides with a standard column", async () => {
    const result = await compileWith({
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("label", { physicalName: "code" }),
          attribute("other", { physicalName: "note_x" }),
          attribute("again", { physicalName: "note_x" }),
        ],
      }),
    })
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["physical.column-duplicate", "/attributes/0/physicalName"],
      ["physical.column-duplicate", "/attributes/2/physicalName"],
    ])
  })

  it("polymorphic pair collides with a plain column", async () => {
    const result = await compileWith({
      "catalogs/A/A.meta.json": catalog("A"),
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("subjectType", { physicalName: "subject_type" }),
          attribute("subject", {
            type: "Ref",
            allowedTypes: [{ kind: "Catalog", name: "A" }],
          }),
        ],
      }),
    })
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["physical.column-duplicate", "/attributes/1/physicalName"],
    ])
  })

  it("reserved word is a warning", async () => {
    const result = await compileWith({
      "catalogs/Order/Order.meta.json": catalog("Order", {
        attributes: [attribute("check", { physicalName: "check" })],
      }),
    })
    expect(result.ok).toBe(true)
    expect(result.model).toBeDefined()
    expect(
      result.diagnostics.map((d) => [d.code, d.severity, d.pointer])
    ).toEqual([
      ["physical.reserved-word", "warning", "/attributes/0/physicalName"],
      ["physical.reserved-word", "warning", "/physicalName"],
    ])
  })

  it("an existing suffixed name stays as is and is not a warning", async () => {
    // Правило слів змінилося, але physicalName призначено раз (Р5)
    const result = await compileWith({
      "catalogs/Item/Item.meta.json": catalog("Item", {
        attributes: [attribute("key", { physicalName: "key_" })],
      }),
    })
    expect(result.diagnostics).toEqual([])
    const table = result.model!.physical.tables.find((t) => t.name === "item")
    expect(table?.columns.map((c) => c.name)).toContain("key_")
  })

  it("an unreserved keyword as physicalName is not a warning", async () => {
    const result = await compileWith({
      "catalogs/Item/Item.meta.json": catalog("Item", {
        attributes: [attribute("type", { physicalName: "type" })],
      }),
    })
    expect(result.diagnostics).toEqual([])
  })

  it("derived name longer than 63 bytes", async () => {
    const base = "s".repeat(60)
    const result = await compileWith({
      "catalogs/A/A.meta.json": catalog("A"),
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("subject", {
            physicalName: base,
            type: "Ref",
            allowedTypes: [{ kind: "Catalog", name: "A" }],
          }),
        ],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "physical.name-too-long",
        severity: "error",
        file: NOTE,
        pointer: "/attributes/0/physicalName",
        params: { name: `${base}_type` },
      }),
    ])
  })

  it("explicit constraint name longer than 63 bytes", async () => {
    const result = await compileWith({
      "custom-tables/Log/Log.meta.json": customTable("Log", {
        uniques: [{ name: "u".repeat(64), columns: ["id"] }],
      }),
    })
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["physical.name-too-long", "/uniques/0/name"],
    ])
  })

  describe("custom table constraints", () => {
    const LOG = "custom-tables/Log/Log.meta.json"
    const columns = [
      {
        id: uuid(740),
        name: "id",
        physicalName: "id",
        type: "UUID",
        notNull: true,
      },
      { id: uuid(741), name: "email", physicalName: "email", type: "Text" },
    ]
    const log = async (overrides: Record<string, unknown>) =>
      await compileWith({
        [LOG]: customTable("Log", { columns, ...overrides }),
      })
    const codes = (result: Awaited<ReturnType<typeof compileWith>>) =>
      result.diagnostics.map((d) => [d.code, d.severity, d.file, d.pointer])

    it("unnamed index with an expression key needs a name", async () => {
      const result = await log({
        indexes: [
          { name: "log_lower_idx", keys: [{ expression: "lower(email)" }] },
          { keys: [{ column: "email" }] },
          { keys: [{ column: "id" }, { expression: "lower(email)" }] },
        ],
      })
      expect(codes(result)).toEqual([
        ["physical.constraint-name-required", "error", LOG, "/indexes/2"],
      ])
      expect(result.diagnostics[0]!.hint).toContain("explicit name")
    })

    it("unnamed check needs a name", async () => {
      const result = await log({
        checks: [
          { name: "log_email_len", expression: "length(email) > 0" },
          { expression: "length(email) > 0" },
        ],
      })
      expect(codes(result)).toEqual([
        ["physical.constraint-name-required", "error", LOG, "/checks/1"],
      ])
    })

    describe("fk action on a table of a kind (Р2c1-34)", () => {
      // Каскад від таблиці виду до прийнятої таблиці виконував би посеред
      // команди вирази й борговий код прийнятої таблиці.
      const fkOn = (
        references: Record<string, unknown>,
        action: Record<string, string>
      ) =>
        compileWith({
          [NOTE]: catalog("Note"),
          "custom-tables/Other/Other.meta.json": customTable("Other"),
          [LOG]: customTable("Log", {
            columns,
            foreignKeys: [
              {
                name: "log_fk",
                columns: ["id"],
                references,
                ...action,
              },
            ],
          }),
        })
      const kind = {
        object: { kind: "Catalog", name: "Note" },
        columns: ["ref"],
      }
      const other = {
        object: { kind: "CustomTable", name: "Other" },
        columns: ["id"],
      }
      const external = {
        external: { schema: "auth", table: "users", columns: ["id"] },
      }
      const refused = (field: string) => [
        [
          "customTable.fk-action-on-kind-table",
          "error",
          LOG,
          `/foreignKeys/0/${field}`,
        ],
      ]
      it.each([
        {
          field: "onDelete",
          action: "cascade",
          target: kind,
          expected: refused("onDelete"),
        },
        {
          field: "onDelete",
          action: "setNull",
          target: kind,
          expected: refused("onDelete"),
        },
        {
          field: "onDelete",
          action: "setDefault",
          target: kind,
          expected: refused("onDelete"),
        },
        {
          field: "onUpdate",
          action: "cascade",
          target: kind,
          expected: refused("onUpdate"),
        },
        { field: "onDelete", action: "noAction", target: kind, expected: [] },
        { field: "onDelete", action: "restrict", target: kind, expected: [] },
        { field: "onDelete", action: "cascade", target: other, expected: [] },
        {
          field: "onDelete",
          action: "cascade",
          target: external,
          expected: [],
        },
      ])(
        "$field $action → $target.object.kind",
        async ({ field, action, target, expected }) => {
          const result = await fkOn(target, { [field]: action })
          expect(codes(result)).toEqual(expected)
          if (expected.length > 0) {
            expect(result.diagnostics[0]!.params).toEqual({
              table: "public.log",
              foreignKey: "log_fk",
              action,
            })
          }
        }
      )
    })

    describe("fk target on a table of a kind is its key (Рб1-8)", () => {
      // Роль команд змінює унікальний реквізит таблиці виду, а перевірка FK
      // іде повз RLS: FK на нього блокував би команду й був би оракулом
      // наявності рядка в чужому тенанті. Ключ незмінний.
      const NOT_KEY = "customTable.fk-target-not-key"
      const UNKNOWN = "customTable.column-unknown"
      const fkFrom = (
        targetColumns: string[],
        target = { kind: "Catalog", name: "Note" }
      ) =>
        compileWith({
          [NOTE]: catalog("Note"),
          "custom-tables/Other/Other.meta.json": customTable("Other", {
            columns: [
              {
                id: uuid(773),
                name: "id",
                physicalName: "id",
                type: "UUID",
                notNull: true,
              },
              {
                id: uuid(770),
                name: "code",
                physicalName: "code",
                type: "Text",
              },
            ],
          }),
          [LOG]: customTable("Log", {
            columns: [
              ...columns,
              {
                id: uuid(771),
                name: "code",
                physicalName: "code",
                type: "Text",
              },
            ],
            foreignKeys: [
              {
                name: "log_fk",
                columns: targetColumns.map((c) =>
                  c === "code" ? "code" : "id"
                ),
                references: { object: target, columns: targetColumns },
              },
            ],
          }),
        })
      const errors = (result: Awaited<ReturnType<typeof compileWith>>) =>
        result.diagnostics
          .filter((d) => d.severity === "error")
          .map((d) => [d.code, d.pointer])
      it.each([
        { name: "the key", columns: ["ref"], expected: [] },
        {
          name: "a unique attribute",
          columns: ["code"],
          expected: [[NOT_KEY, "/foreignKeys/0/references/columns"]],
        },
        {
          name: "the key and another column",
          columns: ["ref", "code"],
          expected: [[NOT_KEY, "/foreignKeys/0/references/columns"]],
        },
        // Невідому колонку звітує стадія 2: правило ключа її не дублює.
        {
          name: "an unknown column",
          columns: ["missing"],
          expected: [[UNKNOWN, "/foreignKeys/0/references/columns/0"]],
        },
      ])("$name", async ({ columns: target, expected }) => {
        const result = await fkFrom(target)
        expect(errors(result)).toEqual(expected)
        if (expected[0]?.[0] === NOT_KEY) {
          expect(result.diagnostics[0]!.params).toEqual({
            kind: "Catalog",
            name: "Note",
          })
        }
      })

      it("adopted target keeps any column", async () => {
        const result = await fkFrom(["code"], {
          kind: "CustomTable",
          name: "Other",
        })
        expect(errors(result)).toEqual([])
      })

      // Складений `(scope, key)` назвати не можна: колонку скоупу таблиці
      // виду стадія 2 не резолвить, тож і `(scope, id)`, і `(scope, code)`
      // відхиляє `customTable.column-unknown`, а не це правило.
      it.each([
        ["org", "ref"],
        ["org", "code"],
      ])("scoped pair (%s, %s) is an unknown column", async (scope, column) => {
        const result = await compile(
          metaFiles({
            "project.meta.json": scopedProject(),
            "catalogs/Organization/Organization.meta.json": organization(),
            [NOTE]: catalog("Note", { scope: "org" }),
            [LOG]: customTable("Log", {
              scope: "org",
              scopeColumn: "org",
              columns: [
                ...columns,
                {
                  id: uuid(772),
                  name: "org",
                  physicalName: "org_id",
                  type: "UUID",
                  notNull: true,
                },
              ],
              foreignKeys: [
                {
                  name: "log_fk",
                  columns: ["org", "id"],
                  references: {
                    object: { kind: "Catalog", name: "Note" },
                    columns: [scope, column],
                  },
                },
              ],
            }),
          })
        )
        expect(errors(result)).toEqual([
          [UNKNOWN, "/foreignKeys/0/references/columns/0"],
        ])
      })
    })

    describe("metadata expressions of an adopted table (Р2c1-41, Р2c1-55)", () => {
      // Postgres обчислює ці вирази на кожному записі в прийняту таблицю,
      // зокрема записі ролі API, тож їхні виклики — дозвільний перелік
      // виразів: запис сесії й виконання тексту SQL у нього не входять.
      const NOT_ALLOWED = "sql.expression-call-not-allowed"
      const SEQUENCE = "CREATE SEQUENCE public.log_seq;\n"
      const amount = {
        id: uuid(746),
        name: "amount",
        physicalName: "amount",
        type: "Integer",
      }
      const at: Record<string, (e: string) => Record<string, unknown>> = {
        default: (e) => ({
          columns: [...columns, { ...amount, type: "Boolean", default: e }],
        }),
        generated: (e) => ({
          columns: [
            ...columns,
            { ...amount, type: "Boolean", generated: { expression: e } },
          ],
        }),
        checks: (e) => ({
          columns: [...columns, amount],
          checks: [{ name: "log_check", expression: e }],
        }),
        "index key": (e) => ({
          columns: [...columns, amount],
          indexes: [{ name: "log_idx", keys: [{ expression: `(${e})` }] }],
        }),
        "index where": (e) => ({
          columns: [...columns, amount],
          indexes: [{ name: "log_idx", keys: [{ column: "id" }], where: e }],
        }),
      }
      const POINTERS: Record<string, string> = {
        default: "/columns/2/default",
        generated: "/columns/2/generated/expression",
        checks: "/checks/0/expression",
        "index key": "/indexes/0/keys/0/expression",
        "index where": "/indexes/0/where",
      }
      const refused = (field: string, call: string) => ({
        code: NOT_ALLOWED,
        pointer: POINTERS[field],
        call,
      })
      const cases = Object.keys(at).flatMap((field) => [
        {
          field,
          expression:
            "pg_catalog.set_config('simetra.actor', 'x', false) IS NOT NULL",
          expected: [refused(field, "pg_catalog.set_config")],
        },
        {
          field,
          expression:
            "pg_catalog.set_config('request.jwt.claims', '{}', false) IS NOT NULL",
          expected: [refused(field, "pg_catalog.set_config")],
        },
        {
          field,
          expression: "query_to_xml('select 1', true, true, '') IS NOT NULL",
          expected: [refused(field, "query_to_xml")],
        },
        {
          field,
          expression: "extensions.whatever() IS NOT NULL",
          expected: [refused(field, "extensions.whatever")],
        },
        {
          field,
          expression: "simetra.provision_user(id, id) IS NOT NULL",
          expected: [
            {
              code: "sql.platform-function-call",
              pointer: POINTERS[field],
              call: undefined,
            },
          ],
        },
        // `nextval` поза `DEFAULT` — поза переліком і над послідовністю моделі.
        ...(field === "default"
          ? []
          : [
              {
                field,
                expression: "nextval('public.log_seq') > 0",
                expected: [refused(field, "nextval")],
              },
            ]),
        { field, expression: "now() IS NOT NULL", expected: [] },
        { field, expression: "gen_random_uuid() IS NOT NULL", expected: [] },
        {
          field,
          expression: "extensions.uuid_generate_v4() IS NOT NULL",
          expected: [],
        },
        { field, expression: "amount >= 0", expected: [] },
      ])
      // Таблиця колонки `serial`: `DEFAULT nextval(...)` послідовності моделі.
      const serial = [
        { expression: "nextval('public.log_seq'::regclass) > 0", expected: [] },
        {
          expression: "pg_catalog.nextval('public.log_seq') > 0",
          expected: [],
        },
        {
          expression: "nextval('public.' || 'log_seq') > 0",
          expected: [refused("default", "nextval")],
        },
        {
          expression: "nextval('public.other_seq'::regclass) > 0",
          expected: [refused("default", "nextval")],
        },
        {
          expression: "nextval('log_seq'::regclass) > 0",
          expected: [refused("default", "nextval")],
        },
        {
          expression: "nextval('public.log_seq'::text) > 0",
          expected: [refused("default", "nextval")],
        },
      ].map((c) => ({ field: "default", ...c }))
      it.each([...cases, ...serial])(
        "$field: $expression",
        async ({ field, expression, expected }) => {
          // Послідовність — прийнятий борг модуля таблиці.
          const result = await compile(
            await acceptDebt(
              metaFiles({
                "project.meta.json": project(),
                [LOG]: customTable("Log", {
                  columns,
                  ...at[field]!(expression),
                }),
                "custom-tables/Log/Log.sql": SEQUENCE,
              })
            )
          )
          expect(
            result.diagnostics.map((d) => ({
              code: d.code,
              pointer: d.pointer,
              call: d.params?.call,
            }))
          ).toEqual(expected)
          expect(
            result.diagnostics.every(
              (d) => d.file === LOG && d.severity === "error"
            )
          ).toBe(true)
        }
      )
    })

    it("fk to a pg enum is not referenceable, not a table", async () => {
      const result = await compileWith({
        "pg-enums/Mood/Mood.meta.json": {
          id: uuid(742),
          kind: "PgEnum",
          name: "Mood",
          physicalName: "mood",
          values: ["ok"],
        },
        [LOG]: customTable("Log", {
          columns,
          foreignKeys: [
            {
              columns: ["email"],
              references: {
                object: { kind: "PgEnum", name: "Mood" },
                columns: ["ok"],
              },
            },
          ],
        }),
      })
      expect(codes(result)).toEqual([
        [
          "reference.not-referenceable",
          "error",
          LOG,
          "/foreignKeys/0/references/object",
        ],
      ])
    })

    it("fk column count must match the referenced columns", async () => {
      const result = await compileWith({
        "custom-tables/Other/Other.meta.json": customTable("Other"),
        [LOG]: customTable("Log", {
          columns,
          foreignKeys: [
            {
              columns: ["id", "email"],
              references: {
                object: { kind: "CustomTable", name: "Other" },
                columns: ["id"],
              },
            },
            {
              columns: ["id"],
              references: {
                external: {
                  schema: "auth",
                  table: "users",
                  columns: ["id", "aud"],
                },
              },
            },
          ],
        }),
      })
      expect(codes(result)).toEqual([
        ["customTable.foreign-key-arity", "error", LOG, "/foreignKeys/0"],
        ["customTable.foreign-key-arity", "error", LOG, "/foreignKeys/1"],
      ])
    })

    it("fk to a deferrable key without a non-deferrable twin", async () => {
      const fk = (columns: string[]) => ({
        columns: ["id"],
        references: {
          object: { kind: "CustomTable", name: "Other" },
          columns,
        },
      })
      const result = await compileWith({
        "custom-tables/Other/Other.meta.json": customTable("Other", {
          columns: [
            {
              id: uuid(743),
              name: "id",
              physicalName: "id",
              type: "UUID",
              notNull: true,
            },
            { id: uuid(744), name: "code", physicalName: "code", type: "UUID" },
            { id: uuid(745), name: "tag", physicalName: "tag", type: "UUID" },
          ],
          primaryKey: { columns: ["id"], deferrable: "deferrable" },
          uniques: [
            {
              name: "other_code_key",
              columns: ["code"],
              deferrable: "initiallyDeferred",
            },
            { name: "other_code_now_key", columns: ["code"] },
            {
              name: "other_tag_key",
              columns: ["tag"],
              deferrable: "deferrable",
            },
          ],
          indexes: [
            // Частковий унікальний індекс ціллю FK бути не може.
            {
              name: "other_tag_idx",
              unique: true,
              keys: [{ column: "tag" }],
              where: "tag IS NOT NULL",
            },
          ],
        }),
        [LOG]: customTable("Log", {
          columns,
          foreignKeys: [fk(["id"]), fk(["code"]), fk(["tag"])],
        }),
      })
      expect(codes(result)).toEqual([
        [
          "customTable.foreign-key-deferrable-target",
          "error",
          LOG,
          "/foreignKeys/0/references/columns",
        ],
        [
          "customTable.foreign-key-deferrable-target",
          "error",
          LOG,
          "/foreignKeys/2/references/columns",
        ],
      ])
    })

    it("primary key column without notNull", async () => {
      const result = await log({
        columns: [
          { id: uuid(746), name: "id", physicalName: "id", type: "UUID" },
          { id: uuid(747), name: "email", physicalName: "email", type: "Text" },
        ],
        primaryKey: { columns: ["id"] },
      })
      expect(codes(result)).toEqual([
        ["customTable.key-column-nullable", "error", LOG, "/columns/0"],
      ])
      expect(result.diagnostics[0]!.hint).toContain("Set notNull: true")
    })

    it("every column of a composite primary key needs notNull", async () => {
      const result = await log({
        columns: [
          { id: uuid(746), name: "id", physicalName: "id", type: "UUID" },
          { id: uuid(747), name: "email", physicalName: "email", type: "Text" },
          {
            id: uuid(748),
            name: "note",
            physicalName: "note",
            type: "Text",
            notNull: true,
          },
        ],
        primaryKey: { columns: ["email", "note", "id"] },
      })
      expect(codes(result)).toEqual([
        ["customTable.key-column-nullable", "error", LOG, "/columns/0"],
        ["customTable.key-column-nullable", "error", LOG, "/columns/1"],
      ])
    })

    it("identity column without notNull", async () => {
      const result = await log({
        columns: [
          ...columns,
          {
            id: uuid(749),
            name: "seq",
            physicalName: "seq",
            type: "BigInt",
            identity: "byDefault",
          },
          {
            id: uuid(750),
            name: "seqOk",
            physicalName: "seq_ok",
            type: "BigInt",
            identity: "always",
            notNull: true,
          },
        ],
        primaryKey: { columns: ["id"] },
      })
      expect(codes(result)).toEqual([
        ["customTable.key-column-nullable", "error", LOG, "/columns/2"],
      ])
      expect(result.diagnostics[0]!.params).toEqual({
        column: "seq",
        role: "identity",
      })
    })

    it("fk to a composite deferrable key saved by a twin in another order", async () => {
      const keyColumn = (n: number, name: string) => ({
        id: uuid(n),
        name,
        physicalName: name,
        type: "UUID",
        notNull: true,
      })
      const result = await compileWith({
        "custom-tables/Other/Other.meta.json": customTable("Other", {
          columns: [
            keyColumn(751, "a"),
            keyColumn(752, "b"),
            keyColumn(753, "c"),
          ],
          primaryKey: { columns: ["a", "b"], deferrable: "deferrable" },
          uniques: [
            { name: "other_b_a_key", columns: ["b", "a"] },
            { name: "other_c_key", columns: ["c"], deferrable: "deferrable" },
          ],
          // Звичайний унікальний індекс без умови — теж законна ціль FK.
          indexes: [
            { name: "other_c_idx", unique: true, keys: [{ column: "c" }] },
          ],
        }),
        [LOG]: customTable("Log", {
          columns: [keyColumn(754, "x"), keyColumn(755, "y")],
          foreignKeys: [
            {
              columns: ["x", "y"],
              references: {
                object: { kind: "CustomTable", name: "Other" },
                columns: ["a", "b"],
              },
            },
            {
              columns: ["x"],
              references: {
                object: { kind: "CustomTable", name: "Other" },
                columns: ["c"],
              },
            },
          ],
        }),
      })
      expect(codes(result)).toEqual([])
    })

    it("fk to a deferrable key of an external table is not checked", async () => {
      const result = await log({
        primaryKey: { columns: ["id"], deferrable: "deferrable" },
        foreignKeys: [
          {
            columns: ["id"],
            references: {
              external: { schema: "auth", table: "users", columns: ["id"] },
            },
          },
        ],
      })
      expect(codes(result)).toEqual([])
    })
  })

  describe("default value (spec §5)", () => {
    const where = (result: Awaited<ReturnType<typeof compileWith>>) =>
      result.diagnostics.map((d) => [d.code, d.severity, d.file, d.pointer])
    const STATUS_FILE = "enumerations/Status/Status.meta.json"
    const RATE_FILE = "constants/Rate/Rate.meta.json"

    it("attribute default of a Ref to a table is forbidden", async () => {
      const result = await compileWith({
        "catalogs/Item/Item.meta.json": catalog("Item"),
        [NOTE]: catalog("Note", {
          attributes: [
            attribute("item", {
              ...refTo("Catalog", "Item"),
              defaultValue: "Main",
            }),
          ],
        }),
      })
      expect(where(result)).toEqual([
        [
          "reference.default-to-table",
          "error",
          NOTE,
          "/attributes/0/defaultValue",
        ],
      ])
    })

    it("constant default of a Ref to a table is forbidden", async () => {
      const result = await compileWith({
        "catalogs/Item/Item.meta.json": catalog("Item"),
        [RATE_FILE]: {
          ...CONSTANT,
          ...refTo("Catalog", "Item"),
          defaultValue: "Main",
        },
      })
      expect(where(result)).toEqual([
        ["reference.default-to-table", "error", RATE_FILE, "/defaultValue"],
      ])
    })

    it("attribute default of a Ref to an enumeration names an existing value", async () => {
      const result = await compileWith({
        [STATUS_FILE]: ENUMERATION,
        [NOTE]: catalog("Note", {
          attributes: [
            attribute("status", {
              ...refTo("Enumeration", "Status"),
              defaultValue: "Closed",
            }),
            attribute("state", {
              ...refTo("Enumeration", "Status"),
              defaultValue: "Open",
            }),
          ],
        }),
      })
      expect(where(result)).toEqual([
        [
          "reference.default-unknown-value",
          "error",
          NOTE,
          "/attributes/0/defaultValue",
        ],
      ])
    })

    it("constant default of a Ref to an enumeration names an existing value", async () => {
      const result = await compileWith({
        [STATUS_FILE]: ENUMERATION,
        [RATE_FILE]: {
          ...CONSTANT,
          ...refTo("Enumeration", "Status"),
          defaultValue: "Closed",
        },
      })
      expect(where(result)).toEqual([
        [
          "reference.default-unknown-value",
          "error",
          RATE_FILE,
          "/defaultValue",
        ],
      ])
    })

    it("the enumeration value is matched by logical name, not by label", async () => {
      const result = await compileWith({
        [STATUS_FILE]: {
          ...ENUMERATION,
          values: [{ id: uuid(731), name: "Open", physicalName: "opened" }],
        },
        [RATE_FILE]: {
          ...CONSTANT,
          ...refTo("Enumeration", "Status"),
          defaultValue: "opened",
        },
      })
      expect(where(result)).toEqual([
        [
          "reference.default-unknown-value",
          "error",
          RATE_FILE,
          "/defaultValue",
        ],
      ])
    })
  })

  describe("standard attribute overrides", () => {
    const where = (result: Awaited<ReturnType<typeof compileWith>>) =>
      result.diagnostics.map((d) => [d.code, d.severity, d.file, d.pointer])

    it("an override key the kind does not declare is an error on the key", async () => {
      const result = await compileWith({
        [NOTE]: catalog("Note", {
          standardAttributeOverrides: {
            code: { title: { en: "Code" } },
            "bo/gus": { title: { en: "Bogus" } },
          },
        }),
      })
      expect(where(result)).toEqual([
        [
          "presentation.unknown-standard-attribute",
          "error",
          NOTE,
          "/standardAttributeOverrides/bo~1gus",
        ],
      ])
      expect(result.diagnostics[0]?.params).toEqual({
        name: "bo/gus",
        kind: "Catalog",
      })
    })

    it("a tabular section override key the row does not declare is an error", async () => {
      const result = await compileWith({
        [NOTE]: catalog("Note", {
          tabularSections: [
            {
              id: uuid(760),
              name: "rows",
              physicalName: "rows",
              standardAttributeOverrides: {
                lineNumber: { title: { en: "No." } },
                code: { title: { en: "Code" } },
              },
            },
          ],
        }),
      })
      expect(where(result)).toEqual([
        [
          "presentation.unknown-standard-attribute",
          "error",
          NOTE,
          "/tabularSections/0/standardAttributeOverrides/code",
        ],
      ])
    })

    it("an override key in the project attribute case is accepted", async () => {
      const result = await compile(
        metaFiles({
          "project.meta.json": project({
            naming: { attributeCase: "snake_case" },
          }),
          [NOTE]: catalog("Note", {
            standardAttributeOverrides: {
              deletion_mark: { title: { en: "Mark" } },
            },
          }),
        })
      )
      expect(result.diagnostics).toEqual([])
    })
  })

  describe("attribute.unique-within-place", () => {
    const code = (uniqueWithin: string) =>
      attribute("code2", {
        type: "String",
        length: 20,
        unique: true,
        uniqueWithin,
      })

    it("tabular section and document attributes do not accept uniqueWithin", async () => {
      const result = await compileWith({
        "catalogs/A/A.meta.json": catalog("A", {
          tabularSections: [
            {
              id: uuid(740),
              name: "lines",
              physicalName: "lines",
              attributes: [code("parent")],
            },
          ],
        }),
        "documents/D/D.meta.json": document("D", {
          attributes: [code("parent")],
        }),
      })
      expect(
        result.diagnostics.map((d) => [d.code, d.file, d.pointer])
      ).toEqual([
        [
          "file.unknown-key",
          "catalogs/A/A.meta.json",
          "/tabularSections/0/attributes/0/uniqueWithin",
        ],
        [
          "file.unknown-key",
          "documents/D/D.meta.json",
          "/attributes/0/uniqueWithin",
        ],
      ])
    })

    it("is an error for owner on a catalog without owners and parent without hierarchy", async () => {
      const result = await compileWith({
        "catalogs/A/A.meta.json": catalog("A", {
          attributes: [code("owner")],
        }),
        "catalogs/B/B.meta.json": catalog("B", {
          attributes: [code("parent")],
        }),
      })
      expect(
        result.diagnostics.map((d) => [d.code, d.file, d.pointer])
      ).toEqual([
        [
          "attribute.unique-within-place",
          "catalogs/A/A.meta.json",
          "/attributes/0/uniqueWithin",
        ],
        [
          "attribute.unique-within-place",
          "catalogs/B/B.meta.json",
          "/attributes/0/uniqueWithin",
        ],
      ])
    })
  })

  describe("index.attribute-unknown and index.attribute-duplicate", () => {
    it("reports an unknown or repeated name in an object and a section index", async () => {
      const result = await compileWith({
        "documents/D/D.meta.json": document("D", {
          attributes: [attribute("qty", { type: "Integer" })],
          indexes: [
            { attributes: ["qty", "missing"] },
            { attributes: ["qty", { name: "qty", order: "desc" }] },
            { attributes: ["deletionMark", "deletionMark"] },
          ],
          tabularSections: [
            {
              id: uuid(741),
              name: "lines",
              physicalName: "d_lines",
              attributes: [attribute("price", { type: "Integer" })],
              indexes: [{ attributes: ["qty"] }, { attributes: ["price"] }],
            },
          ],
        }),
      })
      expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
        ["index.attribute-unknown", "/indexes/0/attributes/1"],
        ["index.attribute-duplicate", "/indexes/1/attributes/1"],
        ["index.attribute-duplicate", "/indexes/2/attributes/1"],
        [
          "index.attribute-unknown",
          "/tabularSections/0/indexes/0/attributes/0",
        ],
      ])
    })

    it("accepts a standard attribute in the project case and rejects indexes on other kinds", async () => {
      const result = await compileWith({
        "project.meta.json": project({
          naming: { attributeCase: "snake_case" },
        }),
        "catalogs/A/A.meta.json": catalog("A", {
          indexes: [{ attributes: ["deletion_mark", "predefinedName"] }],
        }),
        "enumerations/E/E.meta.json": { ...ENUMERATION, indexes: [] },
      })
      expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
        ["file.unknown-key", "/indexes"],
      ])
    })
  })
})
