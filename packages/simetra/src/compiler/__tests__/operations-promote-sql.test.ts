import { parsePlPgSQLSync } from "@libpg-query/parser"
import { describe, expect, it, vi } from "vitest"
import {
  applyChanges,
  compile,
  promoteObject,
  type PromoteInput,
  type SchemaPathResolver,
} from "simetra/compiler"
import { SQL_DEBT_FILE } from "simetra/model"
import {
  CATALOG_FILE,
  COUNTERPARTY_FILE,
  COUNTERPARTY_SQL,
  COUNTERPARTY_UNITS,
  SHARED_SQL,
  counterpartyMapping,
  promotionProject,
} from "./fixtures/promotion"
import { acceptDebt, attribute, customTable, document, uuid } from "./helpers"

// Шпигун викликає справжній розбір: решта тестів файлу розбирає plpgsql далі.
vi.mock("@libpg-query/parser", async (orig) => {
  const real = await orig<typeof import("@libpg-query/parser")>()
  return { ...real, parsePlPgSQLSync: vi.fn(real.parsePlPgSQLSync) }
})

type Json = Record<string, unknown>

function counter(start = 950_000): () => string {
  let n = start
  return () => uuid(++n)
}

const schemaPath: SchemaPathResolver = (file, schemaFile) =>
  `schemas-of/${file}/${schemaFile}`

const COMPLETION = { schemaPath, newId: counter() }

const KIND_MODULE = "catalogs/Counterparty/Counterparty.sql"
const TOUCH = "function:app.counterparty_touch()"
const NAMES = "function:app.counterparty_names()"

const errors = (result: { diagnostics: { severity: string }[] }) =>
  result.diagnostics.filter((d) => d.severity === "error")

const brief = (result: {
  diagnostics: {
    code: string
    file: string
    params?: Record<string, unknown>
  }[]
}) =>
  result.diagnostics.map((d) => ({
    code: d.code,
    file: d.file,
    params: d.params,
  }))

function mapping(edit: (input: PromoteInput) => void = () => {}): PromoteInput {
  const input = structuredClone(counterpartyMapping())
  edit(input)
  return input
}

/** Повна фікстура з додатковими SQL-файлами; борг приймається як є. */
async function project(
  sql: Record<string, string> = {},
  edit: (files: Map<string, string>) => void = () => {}
): Promise<Map<string, string>> {
  const files = promotionProject()
  for (const [path, text] of Object.entries(sql)) files.set(path, text)
  edit(files)
  const accepted = await acceptDebt(files)
  expect(errors(await compile(accepted))).toEqual([])
  return accepted
}

async function promoted(
  files: ReadonlyMap<string, string>,
  input: PromoteInput = mapping()
) {
  const result = await promoteObject(files, input, COMPLETION)
  return { result, after: applyChanges(files, result.changes) }
}

/** Промоція, що мусить пройти, і чиста компіляція результату. */
async function passes(
  files: ReadonlyMap<string, string>,
  input: PromoteInput = mapping()
) {
  const out = await promoted(files, input)
  expect(errors(out.result)).toEqual([])
  expect(out.result.ok).toBe(true)
  expect(
    errors(await compile(out.after, { baseline: files })),
    "the result compiles"
  ).toEqual([])
  return out
}

const fn = (name: string, body: string, returns = "integer") =>
  `CREATE FUNCTION app.${name}() RETURNS ${returns} LANGUAGE sql STABLE AS $fn$\n  ${body}\n$fn$;\n`

describe("promoteObject: SQL units", () => {
  it("moves the closed trigger function into the kind module and rewrites it", async () => {
    const files = await project()
    const { result, after } = await passes(files)
    expect(after.has(COUNTERPARTY_SQL)).toBe(false)
    expect(after.get(KIND_MODULE)).toBe(
      `CREATE FUNCTION app.counterparty_touch() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  NEW.description := btrim(NEW.description);
  RETURN NEW;
END
$fn$;
`
    )
    expect(result.record?.movedUnits).toEqual([
      { identity: TOUCH, from: COUNTERPARTY_SQL, to: KIND_MODULE },
    ])
    // Об'єкт класу одиниці — ключ предмета в старих іменах (рішення 7 П3-2a).
    const unit = (cls: string, name: string) => [
      {
        kind: "unit",
        class: cls,
        schema: "app",
        table: "counterparties",
        name,
      },
    ]
    expect(result.record?.conversions).toEqual(
      expect.arrayContaining([
        {
          subject: COUNTERPARTY_UNITS.trigger,
          class: "platform",
          objects: unit("trigger", "counterparty_touch"),
        },
        {
          subject: COUNTERPARTY_UNITS.policy,
          class: "platform",
          objects: unit("policy", "counterparties_read"),
        },
        {
          subject: COUNTERPARTY_UNITS.grant,
          class: "platform",
          objects: unit("grant", "grant:authenticated:select"),
        },
      ])
    )
    const debt = after.get(SQL_DEBT_FILE)
    for (const identity of Object.values(COUNTERPARTY_UNITS)) {
      expect(debt ?? "").not.toContain(identity)
    }
  })

  it("moves a function named in sharedFunctions to sql/<schema>/", async () => {
    const files = await project()
    const { result, after } = await passes(
      files,
      mapping((m) => {
        m.sharedFunctions = [TOUCH]
      })
    )
    expect(after.has(KIND_MODULE)).toBe(false)
    expect(after.get("sql/app/counterparty_touch.sql")).toContain(
      "NEW.description := btrim(NEW.description);"
    )
    expect(result.record?.movedUnits).toEqual([
      {
        identity: TOUCH,
        from: COUNTERPARTY_SQL,
        to: "sql/app/counterparty_touch.sql",
      },
    ])
  })

  it("refuses a sharedFunctions entry that names no moved function", async () => {
    const files = await project()
    const { result } = await promoted(
      files,
      mapping((m) => {
        m.sharedFunctions = [NAMES]
      })
    )
    expect(brief(result)).toEqual([
      {
        code: "promote.mapping-unknown",
        file: "",
        params: expect.objectContaining({ at: "/sharedFunctions/0" }),
      },
    ])
  })

  it("rewrites a shared function that reads the promoted table", async () => {
    const files = await project()
    const { result, after } = await passes(files)
    expect(after.get(SHARED_SQL)).toBe(
      `CREATE FUNCTION app.counterparty_names() RETURNS TABLE (name text, inn text) LANGUAGE sql STABLE AS $fn$
  SELECT c.description AS name, c.tax_id AS inn FROM app.counterparty c
$fn$;
`
    )
    expect(result.record?.rewrittenUnits).toEqual(
      expect.arrayContaining([{ identity: NAMES, file: SHARED_SQL }])
    )
  })

  it("treats a SQL-standard function body like an AS $$ body and never hands it to the WASM plpgsql parser", async () => {
    const standard = `CREATE FUNCTION app.cp_total() RETURNS integer LANGUAGE sql STABLE
BEGIN ATOMIC
  SELECT count(*)::integer FROM app.counterparty;
END;
`
    const quoted = fn(
      "cp_total",
      "SELECT count(*)::integer FROM app.counterparty"
    )
    const outcome = async (text: string) => {
      const files = await project({ "sql/app/cp_total.sql": text })
      vi.mocked(parsePlPgSQLSync).mockClear()
      const { result } = await promoted(files)
      const handed = vi
        .mocked(parsePlPgSQLSync)
        .mock.calls.map(([sql]) => sql)
        .filter((sql) => sql.includes("cp_total"))
      return { ok: result.ok, diagnostics: brief(result), handed }
    }
    const a = await outcome(standard)
    const b = await outcome(quoted)
    expect(a.handed).toEqual([])
    expect({ ok: a.ok, diagnostics: a.diagnostics }).toEqual({
      ok: b.ok,
      diagnostics: b.diagnostics,
    })
  })

  it("refuses an unclassified policy and a non-closed module function", async () => {
    const files = await project({}, (f) => {
      f.set(
        COUNTERPARTY_SQL,
        `${f.get(COUNTERPARTY_SQL)!}
CREATE POLICY counterparties_audit ON app.counterparties FOR SELECT TO anon USING (false);

CREATE FUNCTION app.counterparty_raw() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
`
      )
    })
    const { result, after } = await promoted(files)
    expect(result.ok).toBe(false)
    expect(after).toEqual(files)
    expect(brief(result)).toEqual([
      {
        code: "promote.unclassified",
        file: COUNTERPARTY_SQL,
        params: {
          subject: "function:app.counterparty_raw()",
          line: 17,
        },
      },
      {
        code: "promote.unclassified",
        file: COUNTERPARTY_SQL,
        params: {
          subject: "policy:app.counterparties.counterparties_audit",
          line: 15,
        },
      },
    ])
    // Класифіковані знімаються разом з модулем.
    const classified = await passes(
      files,
      mapping((m) => {
        m.conversions["function:app.counterparty_raw()"] = "applicationCode"
        m.conversions["policy:app.counterparties.counterparties_audit"] =
          "removed"
      })
    )
    expect(classified.after.get(KIND_MODULE)).not.toContain("counterparty_raw")
  })

  it("refuses a view of another table that reads a promoted column", async () => {
    const files = await project({
      "sql/app/views.sql": `CREATE VIEW app.invoice_parties AS
  SELECT i.id, c.name FROM app.invoices i JOIN app.counterparties c ON c.id = i.counterparty_id;
`,
    })
    const { result } = await promoted(files)
    expect(brief(result)).toEqual([
      {
        code: "promote.debt-text-reference",
        file: "sql/app/views.sql",
        params: { identity: "view:app.invoice_parties", line: 1 },
      },
    ])
  })

  it("classifies and cuts a unit elsewhere whose target is the promoted table", async () => {
    const comment =
      "COMMENT ON POLICY counterparties_read ON app.counterparties IS 'read';"
    const files = await project({
      "sql/app/comments.sql": `-- keep this line\n${comment}\n\nCOMMENT ON SCHEMA app IS 'application';\n`,
    })
    const identity = "comment:policy:app.counterparties.counterparties_read"
    const refused = await promoted(files)
    expect(brief(refused.result)).toEqual([
      {
        code: "promote.unclassified",
        file: "sql/app/comments.sql",
        params: { subject: identity, line: 2 },
      },
    ])
    const { after } = await passes(
      files,
      mapping((m) => {
        m.conversions[identity] = "platform"
      })
    )
    expect(after.get("sql/app/comments.sql")).toBe(
      "-- keep this line\nCOMMENT ON SCHEMA app IS 'application';\n"
    )
  })

  it("refuses write grants and write policies", async () => {
    const files = await project({}, (f) => {
      f.set(
        COUNTERPARTY_SQL,
        `${f.get(COUNTERPARTY_SQL)!}
GRANT INSERT, UPDATE ON app.counterparties TO authenticated;

CREATE POLICY counterparties_edit ON app.counterparties FOR UPDATE TO authenticated USING (true);
`
      )
    })
    const { result } = await promoted(
      files,
      mapping((m) => {
        m.conversions[
          "grant:grant:table:app.counterparties:authenticated:insert"
        ] = "platform"
        m.conversions[
          "grant:grant:table:app.counterparties:authenticated:update"
        ] = "platform"
        m.conversions["policy:app.counterparties.counterparties_edit"] =
          "platform"
      })
    )
    const write = result.diagnostics.filter(
      (d) => d.code === "promote.write-path"
    )
    expect(write.map((d) => d.file)).toEqual([
      COUNTERPARTY_SQL,
      COUNTERPARTY_SQL,
    ])
    expect(write.map((d) => d.params?.line)).toEqual([15, 17])
    for (const d of write) {
      expect(d.message).toContain("write path after promotion")
    }
    expect(result.ok).toBe(false)
  })

  it("refuses a write privilege that comes from the schema's default privileges", async () => {
    const files = await project({
      "sql/app/default-privileges.sql":
        "ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ALL ON TABLES TO authenticated;\n",
    })
    const { result } = await promoted(files)
    expect(brief(result)).toEqual([
      {
        code: "promote.write-path",
        file: "sql/app/default-privileges.sql",
        params: expect.objectContaining({ table: "app.counterparties" }),
      },
    ])
    expect(result.diagnostics[0]!.message).toContain(
      "write path after promotion"
    )
  })

  it("ignores default privileges of another schema and read-only ones", async () => {
    const files = await project({
      "sql/public/default-privileges.sql":
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;\n",
      "sql/app/default-privileges.sql":
        "ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO authenticated;\n",
    })
    await passes(files)
  })

  it("leaves a candidate untouched when resolution finds no reference", async () => {
    const text = fn(
      "other_counts",
      "-- counts rows of counterparties elsewhere\n  SELECT count(*)::integer FROM other.counterparties"
    )
    const files = await project({ "sql/app/other_counts.sql": text })
    const { result, after } = await passes(files)
    expect(after.get("sql/app/other_counts.sql")).toBe(text)
    expect(result.record?.rewrittenUnits.map((u) => u.identity)).not.toContain(
      "function:app.other_counts()"
    )
  })

  it("finds debt text references by dependency resolution, not by word", async () => {
    const literal = await project({
      "sql/app/views.sql":
        "CREATE VIEW app.labels AS SELECT 'all counterparties' AS name, 1 AS counterparties;\n",
    })
    await passes(literal)
    const reading = await project({
      "sql/app/views.sql":
        "CREATE VIEW app.labels AS SELECT count(*) AS n FROM app.counterparties;\n",
    })
    const { result } = await promoted(reading)
    expect(brief(result)).toEqual([
      {
        code: "promote.debt-text-reference",
        file: "sql/app/views.sql",
        params: { identity: "view:app.labels", line: 1 },
      },
    ])
  })

  it("warns about out-of-scope debt functions with dynamic SQL", async () => {
    const files = await project({
      "sql/app/dyn.sql": `CREATE FUNCTION app.dyn(t text) RETURNS void LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  EXECUTE format('delete from app.%I', t);
END
$fn$;
`,
    })
    const { result } = await passes(files)
    expect(
      brief(result).filter((d) => d.code === "rewrite.dynamic-sql-unscoped")
    ).toEqual([
      {
        code: "rewrite.dynamic-sql-unscoped",
        file: "sql/app/dyn.sql",
        params: expect.objectContaining({
          function: "function:app.dyn(text)",
          line: 3,
        }),
      },
    ])
  })

  it("propagates a contract change to callers transitively", async () => {
    const files = await project({
      "sql/app/f.sql": fn(
        "f",
        "SELECT * FROM app.counterparties",
        "SETOF app.counterparties"
      ),
      "sql/app/g.sql": fn("g", "SELECT count(*)::integer FROM app.f()"),
      "sql/app/h.sql": fn("h", "SELECT app.g()"),
    })
    const { result, after } = await passes(files)
    expect(after.get("sql/app/f.sql")).toContain(
      "RETURNS SETOF app.counterparty"
    )
    const callers = result.record?.contractChanges.filter(
      (c) => c.via !== undefined
    )
    expect(callers).toEqual([
      {
        identity: "function:app.g()",
        file: "sql/app/g.sql",
        line: 1,
        reason: "caller",
        detail: expect.stringContaining("function:app.f()"),
        via: ["function:app.f()"],
      },
      {
        identity: "function:app.h()",
        file: "sql/app/h.sql",
        line: 1,
        reason: "caller",
        detail: expect.stringContaining("function:app.g()"),
        via: ["function:app.g()", "function:app.f()"],
      },
    ])
    const warnings = result.diagnostics.filter(
      (d) => d.code === "rewrite.contract-change" && d.params?.via !== undefined
    )
    expect(warnings.map((d) => d.severity)).toEqual(["warning", "warning"])
  })

  it("records the label translation and the polymorphic consumer columns", async () => {
    const sale = document("Sale", {
      attributes: [
        attribute("party", {
          type: "Ref",
          allowedTypes: [
            { kind: "CustomTable", name: "Counterparty" },
            { kind: "Document", name: "Sale" },
          ],
        }),
      ],
    })
    const files = await project({}, (f) => {
      f.set("documents/Sale/Sale.meta.json", JSON.stringify(sale))
    })
    const { result } = await passes(
      files,
      mapping((m) => {
        m.consumerLabels = ["cp"]
      })
    )
    expect(result.record?.labelTranslation).toEqual({
      from: ["cp"],
      to: "counterparty",
      columns: [{ schema: "public", table: "sale", column: "party_type" }],
    })
  })

  it("finds the pair of a standard column: the value of a polymorphic constant", async () => {
    // Пара константи — стандартна колонка `value`, а не елемент: `value_type`.
    const favorite = {
      id: uuid(7100),
      kind: "Constant",
      name: "Favorite",
      physicalName: "favorite",
      kindLabel: "favorite",
      type: "Ref",
      allowedTypes: [
        { kind: "CustomTable", name: "Counterparty" },
        { kind: "Document", name: "Sale" },
      ],
    }
    const files = await project({}, (f) => {
      f.set("documents/Sale/Sale.meta.json", JSON.stringify(document("Sale")))
      f.set("constants/Favorite/Favorite.meta.json", JSON.stringify(favorite))
    })
    const { result } = await passes(
      files,
      mapping((m) => {
        m.consumerLabels = ["cp"]
      })
    )
    expect(result.record?.labelTranslation?.columns).toEqual([
      { schema: "public", table: "favorite", column: "value_type" },
    ])
  })

  it("refuses a provider user reference that is not the user scope carrier", async () => {
    const files = await project({}, (f) => {
      const raw = JSON.parse(f.get(COUNTERPARTY_FILE)!) as Json
      ;(raw.columns as Json[]).push({
        id: uuid(7009),
        name: "authorId",
        physicalName: "author_id",
        type: "UUID",
      })
      raw.foreignKeys = [
        {
          name: "counterparties_author_id_fkey",
          columns: ["authorId"],
          references: {
            external: { schema: "auth", table: "users", columns: ["id"] },
          },
        },
      ]
      f.set(COUNTERPARTY_FILE, JSON.stringify(raw))
    })
    const { result } = await promoted(
      files,
      mapping((m) => {
        m.columns.authorId = {
          to: "attribute",
          collection: "attributes",
          element: { name: "author" },
        }
      })
    )
    expect(brief(result)).toEqual([
      {
        code: "promote.provider-user-reference",
        file: COUNTERPARTY_FILE,
        params: { table: "Counterparty", column: "authorId" },
      },
    ])
  })

  it("refuses NEW fields of a function bound also to a table the promotion keeps", async () => {
    const partner = customTable("Partner", {
      schema: "app",
      physicalName: "partners",
      columns: [
        {
          id: uuid(7401),
          name: "id",
          physicalName: "id",
          type: "UUID",
          notNull: true,
        },
        { id: uuid(7402), name: "name", physicalName: "name", type: "Text" },
      ],
      primaryKey: { name: "partners_pkey", columns: ["id"] },
    })
    const files = await project(
      {
        "sql/app/touch_name.sql": `CREATE FUNCTION app.touch_name() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  NEW.name := btrim(NEW.name);
  RETURN NEW;
END
$fn$;

CREATE TRIGGER touch_name BEFORE INSERT ON app.counterparties
  FOR EACH ROW EXECUTE FUNCTION app.touch_name();

CREATE TRIGGER touch_name BEFORE INSERT ON app.partners
  FOR EACH ROW EXECUTE FUNCTION app.touch_name();
`,
      },
      (f) => {
        f.set(
          "custom-tables/Partner/Partner.meta.json",
          JSON.stringify(partner)
        )
      }
    )
    const { result } = await promoted(
      files,
      mapping((m) => {
        m.conversions["trigger:app.counterparties.touch_name"] = "property"
      })
    )
    expect(brief(result).map((d) => [d.code, d.file, d.params?.line])).toEqual([
      ["rewrite.trigger-binding", "sql/app/touch_name.sql", 3],
      ["rewrite.trigger-binding", "sql/app/touch_name.sql", 3],
    ])
  })

  it("aggregates rewriter refusals and writes nothing", async () => {
    const dynamic = `CREATE FUNCTION app.purge() RETURNS void LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  EXECUTE 'delete from app.counterparties';
END
$fn$;
`
    const files = await project({
      "sql/app/purge.sql": dynamic,
      "sql/app/unqualified.sql": fn(
        "unqualified",
        "SELECT count(*)::integer FROM counterparties"
      ),
    })
    const { result, after } = await promoted(files)
    expect(result.ok).toBe(false)
    expect(result.changes).toEqual([])
    expect(after).toEqual(files)
    expect(
      brief(result).map((d) => [
        d.code,
        d.file,
        d.params?.line,
        d.params?.function,
      ])
    ).toEqual([
      ["rewrite.dynamic-sql", "sql/app/purge.sql", 3, "function:app.purge()"],
      [
        "rewrite.unqualified-table",
        "sql/app/unqualified.sql",
        2,
        "function:app.unqualified()",
      ],
    ])
  })

  it("flags consumer label literals", async () => {
    const files = await project({
      "sql/app/kinds.sql": fn(
        "kinds",
        "SELECT count(*)::integer FROM app.counterparties c WHERE 'cp' = c.inn"
      ),
    })
    const { result } = await promoted(
      files,
      mapping((m) => {
        m.consumerLabels = ["cp"]
      })
    )
    expect(brief(result)).toEqual([
      {
        code: "rewrite.label-literal",
        file: "sql/app/kinds.sql",
        params: expect.objectContaining({
          function: "function:app.kinds()",
          line: 2,
        }),
      },
    ])
  })

  it("passes contract changes through as warnings and into the record", async () => {
    const files = await project({
      "sql/app/rows.sql": fn(
        "rows",
        "SELECT * FROM app.counterparties",
        "SETOF app.counterparties"
      ),
    })
    const { result } = await passes(files)
    const changes = result.record?.contractChanges ?? []
    expect(changes.length).toBeGreaterThan(0)
    for (const c of changes) {
      expect(c).toMatchObject({
        identity: "function:app.rows()",
        file: "sql/app/rows.sql",
      })
      expect(c.detail).toEqual(expect.any(String))
    }
    const warnings = result.diagnostics.filter(
      (d) => d.code === "rewrite.contract-change"
    )
    expect(warnings).toHaveLength(changes.length)
    expect(warnings.every((d) => d.severity === "warning")).toBe(true)
  })

  it("keeps the catalog file next to the moved module", async () => {
    const files = await project()
    const { after } = await passes(files)
    expect(after.has(CATALOG_FILE)).toBe(true)
  })
})

/** Ідентичності одиниць файлу — з компіляції, а не з тексту тесту. */
async function identities(
  files: ReadonlyMap<string, string>,
  file: string
): Promise<string[]> {
  const compiled = await compile(files)
  return (compiled.model?.sqlUnits ?? [])
    .filter((u) => u.file === file)
    .map((u) => u.identity)
}

/** Мапінг разом з ТЧ `contacts` з таблиці контактів. */
const withContacts = (edit: (m: PromoteInput) => void = () => {}) =>
  mapping((m) => {
    m.tabularSections = [
      {
        table: "CounterpartyContact",
        name: "contacts",
        columns: {
          id: { to: "standard", name: "ref" },
          counterpartyId: { to: "standard", name: "parent" },
          phone: {
            to: "attribute",
            collection: "attributes",
            element: { name: "phone" },
          },
        },
      },
    ]
    m.fill.push({
      table: "CounterpartyContact",
      target: { to: "standard", name: "lineNumber" },
      expression:
        "row_number() over (partition by counterparty_id order by id)",
    })
    edit(m)
  })

describe("promoteObject: SQL units, review round 1", () => {
  it("refuses a view that names the promoted row type", async () => {
    const files = await project({
      "sql/app/v.sql":
        "CREATE VIEW app.v AS SELECT (jsonb_populate_record(NULL::app.counterparties, '{}'::jsonb)).id AS id;\n",
    })
    const { result } = await promoted(files)
    expect(brief(result)).toEqual([
      {
        code: "promote.debt-text-reference",
        file: "sql/app/v.sql",
        params: { identity: "view:app.v", line: 1 },
      },
    ])
  })

  it("refuses a grant on a function whose signature names the promoted row type", async () => {
    const files = await project({
      "sql/app/k.sql":
        "CREATE FUNCTION app.k(c app.counterparties) RETURNS text LANGUAGE sql AS $$ SELECT c.inn $$;\n",
      "sql/app/grantk.sql":
        "GRANT EXECUTE ON FUNCTION app.k(app.counterparties) TO authenticated;\n",
    })
    const [grant] = await identities(files, "sql/app/grantk.sql")
    const { result } = await promoted(files)
    expect(brief(result)).toEqual([
      {
        code: "promote.debt-text-reference",
        file: "sql/app/grantk.sql",
        params: { identity: grant, line: 1 },
      },
    ])
  })

  it("renames the debt entry of a rewritten function whose identity changes", async () => {
    const files = await project({
      "sql/app/k.sql":
        "CREATE FUNCTION app.k(c app.counterparties) RETURNS text LANGUAGE sql AS $$ SELECT c.inn $$;\n",
    })
    expect(files.get(SQL_DEBT_FILE)).toContain(
      "function:app.k(app.counterparties)"
    )
    const { after } = await passes(files)
    expect(after.get("sql/app/k.sql")).toBe(
      "CREATE FUNCTION app.k(c app.counterparty) RETURNS text LANGUAGE sql AS $$ SELECT c.tax_id AS inn $$;\n"
    )
    const debt = after.get(SQL_DEBT_FILE)!
    expect(debt).toContain("function:app.k(app.counterparty)")
    expect(debt).not.toContain("function:app.k(app.counterparties)")
  })

  it.each([
    [
      "a column grant of ALL",
      "GRANT ALL (name) ON app.counterparties TO authenticated;",
    ],
    [
      "a column grant of UPDATE",
      "GRANT UPDATE (inn) ON app.counterparties TO anon;",
    ],
    [
      "a policy without FOR",
      "CREATE POLICY counterparties_any ON app.counterparties TO authenticated USING (true);",
    ],
    [
      "default privileges FOR ROLE",
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app GRANT INSERT ON TABLES TO anon;",
    ],
  ])("refuses the write path of %s", async (_, statement) => {
    const files = await project({ "sql/app/write.sql": `${statement}\n` })
    const { result } = await promoted(files)
    expect(
      result.diagnostics
        .filter((d) => d.code === "promote.write-path")
        .map((d) => [d.file, d.params?.table, d.params?.line])
    ).toEqual([["sql/app/write.sql", "app.counterparties", 1]])
    expect(result.ok).toBe(false)
  })

  it("gates and classifies a grant on a tabular section table", async () => {
    const write = await project({
      "sql/app/contacts.sql":
        "GRANT INSERT ON app.counterparty_contacts TO authenticated;\n",
    })
    const refused = await promoted(write, withContacts())
    expect(
      refused.result.diagnostics
        .filter((d) => d.code === "promote.write-path")
        .map((d) => d.params?.table)
    ).toEqual(["app.counterparty_contacts"])

    const read = await project({
      "sql/app/contacts.sql":
        "GRANT SELECT ON app.counterparty_contacts TO authenticated;\n",
    })
    const [grant] = await identities(read, "sql/app/contacts.sql")
    const unclassified = await promoted(read, withContacts())
    expect(brief(unclassified.result)).toEqual([
      {
        code: "promote.unclassified",
        file: "sql/app/contacts.sql",
        params: { subject: grant, line: 1 },
      },
    ])
    const { after } = await passes(
      read,
      withContacts((m) => {
        m.conversions[grant!] = "platform"
      })
    )
    expect(after.has("sql/app/contacts.sql")).toBe(false)
  })

  it("classifies and moves the units of a tabular section's module", async () => {
    const module = "custom-tables/CounterpartyContact/CounterpartyContact.sql"
    const files = await project({
      [module]: `CREATE FUNCTION app.contact_touch() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  NEW.phone := btrim(NEW.phone);
  RETURN NEW;
END
$fn$;

CREATE TRIGGER contact_touch BEFORE INSERT ON app.counterparty_contacts
  FOR EACH ROW EXECUTE FUNCTION app.contact_touch();
`,
    })
    const [, trigger] = await identities(files, module)
    const unclassified = await promoted(files, withContacts())
    expect(brief(unclassified.result)).toEqual([
      {
        code: "promote.unclassified",
        file: module,
        params: { subject: trigger, line: 8 },
      },
    ])
    const { result, after } = await passes(
      files,
      withContacts((m) => {
        m.conversions[trigger!] = "property"
      })
    )
    expect(after.has(module)).toBe(false)
    const kindModule = after.get(KIND_MODULE)!
    expect(kindModule).toContain("FUNCTION app.counterparty_touch()")
    expect(kindModule).toContain("NEW.phone := btrim(NEW.phone);")
    expect(result.record?.movedUnits.map((u) => [u.identity, u.from])).toEqual([
      ["function:app.contact_touch()", module],
      [TOUCH, COUNTERPARTY_SQL],
    ])
  })

  it("classifies REPLICA IDENTITY and publication membership of the promoted table", async () => {
    const realtime = "sql/app/realtime.sql"
    const files = await project({
      [realtime]: `ALTER TABLE app.counterparties REPLICA IDENTITY FULL;

ALTER PUBLICATION supabase_realtime ADD TABLE app.counterparties;
`,
    })
    const units = await identities(files, realtime)
    expect(units).toHaveLength(2)
    const refused = await promoted(files)
    expect(
      brief(refused.result).map((d) => [
        d.code,
        d.params?.subject,
        d.params?.line,
      ])
    ).toEqual(
      expect.arrayContaining([
        ["promote.unclassified", units[0], expect.any(Number)],
        ["promote.unclassified", units[1], expect.any(Number)],
      ])
    )
    expect(refused.result.diagnostics).toHaveLength(2)
    const { after } = await passes(
      files,
      mapping((m) => {
        for (const unit of units) m.conversions[unit] = "platform"
      })
    )
    expect(after.has(realtime)).toBe(false)
  })

  it.each([
    [
      "the last statement of a shared line",
      "COMMENT ON SCHEMA app IS 'a'; COMMENT ON TABLE app.counterparties IS 'x';\nCOMMENT ON SCHEMA public IS 'p';\n",
    ],
    [
      "the first statement of a shared line",
      "COMMENT ON TABLE app.counterparties IS 'x'; COMMENT ON SCHEMA app IS 'a';\nCOMMENT ON SCHEMA public IS 'p';\n",
    ],
    [
      "an indented statement on its own line",
      "COMMENT ON SCHEMA app IS 'a';\n  COMMENT ON TABLE app.counterparties IS 'x';\n\nCOMMENT ON SCHEMA public IS 'p';\n",
    ],
  ])("cuts %s and keeps the line structure", async (_, text) => {
    const files = await project({ "sql/app/c.sql": text })
    const { after } = await passes(
      files,
      mapping((m) => {
        m.conversions["comment:table:app.counterparties"] = "removed"
      })
    )
    expect(after.get("sql/app/c.sql")).toBe(
      "COMMENT ON SCHEMA app IS 'a';\nCOMMENT ON SCHEMA public IS 'p';\n"
    )
  })

  it.each([
    [
      "two classified statements sharing a line",
      "COMMENT ON TABLE app.counterparties IS 'x'; COMMENT ON COLUMN app.counterparties.inn IS 'y';\nCOMMENT ON SCHEMA public IS 'p';\n",
      "COMMENT ON SCHEMA public IS 'p';\n",
    ],
    [
      "the last two of three statements on a line",
      "COMMENT ON SCHEMA app IS 'a'; COMMENT ON TABLE app.counterparties IS 'x'; COMMENT ON COLUMN app.counterparties.inn IS 'y';\nCOMMENT ON SCHEMA public IS 'p';\n",
      "COMMENT ON SCHEMA app IS 'a';\nCOMMENT ON SCHEMA public IS 'p';\n",
    ],
    [
      "the first two of three statements on a line",
      "COMMENT ON TABLE app.counterparties IS 'x'; COMMENT ON COLUMN app.counterparties.inn IS 'y'; COMMENT ON SCHEMA app IS 'a';\r\nCOMMENT ON SCHEMA public IS 'p';\r\n",
      "COMMENT ON SCHEMA app IS 'a';\r\nCOMMENT ON SCHEMA public IS 'p';\r\n",
    ],
  ])("cuts %s", async (_, text, expected) => {
    const files = await project({ "sql/app/c.sql": text })
    const { after } = await passes(
      files,
      mapping((m) => {
        m.conversions["comment:table:app.counterparties"] = "removed"
        m.conversions["comment:column:app.counterparties.inn"] = "removed"
      })
    )
    expect(after.get("sql/app/c.sql")).toBe(expected)
  })

  it("refuses a regclass literal of the promoted table in verbatim debt", async () => {
    for (const expression of [
      "'app.counterparties'::regclass",
      "CAST('app.counterparties' AS regclass)",
      "regclass 'counterparties'",
      `'"app"."counterparties"'::pg_catalog.regclass`,
    ]) {
      const files = await project({
        "sql/app/v.sql": `CREATE VIEW app.v AS SELECT ${expression} AS r;\n`,
      })
      const { result } = await promoted(files)
      expect(brief(result), expression).toEqual([
        {
          code: "promote.debt-text-reference",
          file: "sql/app/v.sql",
          params: { identity: "view:app.v", line: 1 },
        },
      ])
    }
    const other = await project({
      "sql/app/v.sql":
        "CREATE VIEW app.v AS SELECT 'app.invoices'::regclass AS r;\n",
    })
    await passes(other)
  })

  it("refuses a regclass literal of the promoted table in a candidate function", async () => {
    const files = await project({
      "sql/app/oid.sql": fn(
        "counterparties_oid",
        "SELECT 'app.counterparties'::regclass::oid",
        "oid"
      ),
    })
    const { result, after } = await promoted(files)
    expect(after).toEqual(files)
    expect(brief(result)).toEqual([
      {
        code: "rewrite.unsupported",
        file: "sql/app/oid.sql",
        params: expect.objectContaining({
          function: "function:app.counterparties_oid()",
          line: 2,
          detail: expect.stringContaining("table name in a string literal"),
        }),
      },
    ])
  })

  it("refuses verbatim debt that names the promoted table in a string literal", async () => {
    for (const expression of [
      "to_regclass('app.counterparties')",
      "pg_relation_size('app.counterparties')",
      "has_table_privilege('app.counterparties', 'select')",
    ]) {
      const files = await project({
        "sql/app/v.sql": `CREATE VIEW app.v AS SELECT ${expression} AS r;\n`,
      })
      const { result, after } = await promoted(files)
      expect(after, expression).toEqual(files)
      expect(brief(result), expression).toEqual([
        {
          code: "promote.debt-text-reference",
          file: "sql/app/v.sql",
          params: { identity: "view:app.v", line: 1 },
        },
      ])
    }
    const other = await project({
      "sql/app/v.sql":
        "CREATE VIEW app.v AS SELECT to_regclass('app.invoices') AS r, 'counterparties are many' AS t;\n",
    })
    await passes(other)
  })

  it("refuses a candidate that names the promoted table in a text argument", async () => {
    const files = await project({
      "sql/app/probe.sql": `CREATE FUNCTION app.has_cp() RETURNS boolean LANGUAGE plpgsql STABLE AS $fn$
BEGIN
  RETURN to_regclass('app.counterparties') IS NOT NULL;
END
$fn$;
`,
    })
    const { result, after } = await promoted(files)
    expect(after).toEqual(files)
    expect(brief(result)).toEqual([
      {
        code: "rewrite.unsupported",
        file: "sql/app/probe.sql",
        params: expect.objectContaining({
          function: "function:app.has_cp()",
          line: 3,
          detail: expect.stringContaining("table name in a string literal"),
        }),
      },
    ])
  })
})
