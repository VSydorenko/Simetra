import { beforeAll, describe, expect, it } from "vitest"
import {
  addElement,
  applyChanges,
  compile,
  declareFunction,
  declareFunctionInput,
  fixFiles,
  type DeclareFunctionInput,
  type SchemaPathResolver,
} from "simetra/compiler"
import type { SqlFunctionDeclaration } from "simetra/model"
import type { Diagnostic } from "../diagnostics"
import { guardInsertionPoint } from "../sql/guard-of"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import type { VerbatimUnit } from "../sql/units"
import {
  acceptDebt,
  catalog,
  metaFiles,
  project,
  SCOPE_FUNCTIONS_FILE,
  uuid,
} from "./helpers"
import { withRoles } from "./fixtures/rights"

const schemaPath: SchemaPathResolver = (file, schemaFile) =>
  `schemas-of/${file}/${schemaFile}`

function counter(start = 880_000): () => string {
  let n = start
  return () => uuid(++n)
}
const options = () => ({ schemaPath, newId: counter() })

const SQL = "sql/public/fns.sql"
const FUNCTIONS = "sql/public/fns.functions.json"

const CHECK = {
  action: "read",
  object: { kind: "Document" as const, name: "Task" },
  row: "p_row",
}

const definer = (name: string, body = "BEGIN PERFORM 1; END") =>
  `CREATE FUNCTION public.${name}(p_row uuid) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$${body}$$;\n`
const invoker = (name: string) =>
  `CREATE FUNCTION public.${name}(p_row uuid) RETURNS void LANGUAGE plpgsql STABLE SET search_path = '' AS $$BEGIN PERFORM 1; END$$;\n`

const GUARD = "BEGIN PERFORM simetra.rights_require('read', 'task', p_row); END"

/** Тека прав із `.sql`, що має задані функції, і записами `.functions.json`. */
function folder(sql: string, functions?: unknown[]): Map<string, string> {
  const files = withRoles()
  files.set(SQL, sql)
  if (functions !== undefined) {
    files.set(FUNCTIONS, JSON.stringify({ functions }))
  }
  return files
}

const errorsOf = (r: { diagnostics: readonly Diagnostic[] }) =>
  r.diagnostics.filter((d) => d.severity === "error")
const codesOf = (r: { diagnostics: readonly Diagnostic[] }) =>
  errorsOf(r).map((d) => d.code)

const declare = (files: Map<string, string>, input: DeclareFunctionInput) =>
  declareFunction(files, input, options())

const written = (files: Map<string, string>, result: { changes: never[] }) =>
  applyChanges(files, result.changes)

const recordsOf = (
  result: { changes: { path: string; content: string | null }[] },
  path = FUNCTIONS
) =>
  (
    JSON.parse(result.changes.find((c) => c.path === path)!.content!) as {
      functions: SqlFunctionDeclaration[]
    }
  ).functions

describe("declareFunction: the record", () => {
  it("creates a record with an id in a new file with the schema hint", async () => {
    const files = folder(invoker("f"))
    const result = await declare(files, {
      function: { name: "f" },
      callers: ["service"],
    })
    expect(result.ok).toBe(true)
    expect(result.changes.map((c) => c.path)).toEqual([FUNCTIONS])
    const file = JSON.parse(result.changes[0]!.content!) as Record<
      string,
      unknown
    >
    expect(file.$schema).toBe(`schemas-of/${FUNCTIONS}/functions.schema.json`)
    const [record] = recordsOf(result)
    expect(record).toMatchObject({
      function: { name: "f" },
      callers: ["service"],
    })
    expect(record!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect((await compile(written(files, result as never))).ok).toBe(true)
  })

  it("replaces callers and check of an existing record and keeps its id", async () => {
    const id = uuid(881_001)
    const files = folder(definer("f", GUARD), [
      { id, function: { name: "f" }, callers: ["service"], check: CHECK },
    ])
    const result = await declare(files, {
      function: { schema: "public", name: "f" },
      callers: ["user"],
      check: CHECK,
    })
    expect(result.ok).toBe(true)
    const records = recordsOf(result)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id,
      function: { schema: "public", name: "f" },
      callers: ["user"],
      check: CHECK,
    })
  })

  it("keeps the array in the order of the T0 schema", async () => {
    const sql = invoker("b") + invoker("a") + invoker("c")
    let files = folder(sql)
    const shared = options()
    for (const name of ["c", "a", "b"]) {
      const result = await declareFunction(
        files,
        { function: { name }, callers: ["service"] },
        shared
      )
      expect(result.ok).toBe(true)
      files = applyChanges(files, result.changes) as Map<string, string>
    }
    const names = (
      JSON.parse(files.get(FUNCTIONS)!) as {
        functions: SqlFunctionDeclaration[]
      }
    ).functions.map((d) => d.function.name)
    expect(names).toEqual(["a", "b", "c"])
  })

  it("the input has no id: the operation assigns it", () => {
    expect(
      declareFunctionInput.safeParse({
        id: uuid(1),
        function: { name: "f" },
        callers: [],
      }).success
    ).toBe(false)
  })
})

describe("declareFunction: what cannot be declared", () => {
  const refusedWith = async (
    files: Map<string, string>,
    input: DeclareFunctionInput,
    code: string
  ) => {
    const result = await declare(files, input)
    expect(result.ok).toBe(false)
    expect(result.written).toBeUndefined()
    expect(result.changes).toEqual([])
    expect(codesOf(result)).toContain(code)
    return result
  }

  it("a function without a .sql in the folder is target-missing", async () => {
    const result = await refusedWith(
      folder(invoker("f")),
      { function: { name: "ghost" }, callers: [] },
      "sql.declaration-target-missing"
    )
    expect(result.diagnostics[0]!.params).toMatchObject({
      schema: "public",
      name: "ghost",
    })
  })

  it("an overloaded function is overload with the count", async () => {
    const sql = `${invoker("f")}CREATE FUNCTION public.f(p_a int) RETURNS int LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT 1 $$;\n`
    const result = await refusedWith(
      folder(sql),
      { function: { name: "f" }, callers: [] },
      "sql.declaration-overload"
    )
    expect(result.diagnostics[0]!.params).toMatchObject({ count: 2 })
  })

  it("a duplicated declaration in the input is the compiler's duplicate", async () => {
    const files = folder(invoker("f"), [
      { function: { name: "f" }, callers: [] },
      { function: { schema: "public", name: "f" }, callers: [] },
    ])
    await refusedWith(
      files,
      { function: { name: "f" }, callers: [] },
      "sql.declaration-duplicate"
    )
  })

  // Мутація: прибрати відмову ціль-форма — `toPlatformForms` мовчки видалить
  // щойно записану декларацію, і запит автора зникне без сліду.
  it("a function that is already a platform form is refused", async () => {
    let files = folder(
      "CREATE FUNCTION public.team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' SET TimeZone = 'UTC' SET DateStyle = 'ISO, MDY' SET IntervalStyle = 'postgres' SET extra_float_digits = '1' AS $$ SELECT NULL::uuid $$;\n"
    )
    const added = await addElement(
      files,
      {
        target: { kind: "Project" },
        collection: "scopeKinds",
        element: {
          name: "team",
          root: {
            external: { schema: "public", table: "teams", column: "id" },
          },
          setFunction: { name: "team_ids" },
        },
      },
      options()
    )
    expect(added.ok).toBe(true)
    files = applyChanges(files, added.changes) as Map<string, string>
    const result = await refusedWith(
      files,
      { function: { name: "team_ids" }, callers: ["user"] },
      "sql.declaration-platform-form"
    )
    expect(result.diagnostics[0]!.params).toMatchObject({
      form: "setFunction",
    })
  })
})

describe("declareFunction: the repair class", () => {
  const input = (check = true): DeclareFunctionInput => ({
    function: { name: "f" },
    callers: ["user"],
    ...(check ? { check: CHECK } : {}),
  })
  // Відмова хвоста: зміни повертаються для показу, але `written` немає, тож
  // обгортка нічого не пише.
  const notWritten = (r: { ok: boolean; written?: true }) => {
    expect(r.ok).toBe(false)
    expect(r.written).toBeUndefined()
  }

  it("the fixture: an undeclared definer is a repair-class error", async () => {
    const compiled = await compile(folder(definer("f")))
    expect(
      compiled.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => d.code)
    ).toEqual(["sql.definer-caller-unchecked"])
  })

  // Мутація: `acceptsRepair` пропущено — тека з помилкою класу відмовляла б
  // навіть чистому запису, а без хвоста мутація писала б нову помилку класу.
  it("a definer without the guard: the record is written, the target turns into check-not-applied firstStatement", async () => {
    const files = folder(definer("f"))
    const result = await declare(files, input())
    expect(result.ok).toBe(false)
    expect(result.written).toBe(true)
    expect(result.changes.map((c) => c.path)).toEqual([FUNCTIONS])
    const errors = errorsOf(result)
    expect(errors.map((d) => d.code)).toEqual([
      "sql.declaration-check-not-applied",
    ])
    expect(errors[0]!.params).toMatchObject({
      schema: "public",
      name: "f",
      reason: "firstStatement",
    })
  })

  it("callers [] with a check is accepted the same way", async () => {
    const result = await declare(folder(definer("f")), {
      function: { name: "f" },
      callers: [],
      check: CHECK,
    })
    expect(result.written).toBe(true)
    expect(codesOf(result)).toEqual(["sql.declaration-check-not-applied"])
  })

  // Мутація: виняток цілі розширено на будь-яку нову помилку класу.
  it("user without a check is refused with check-missing", async () => {
    const result = await declare(folder(definer("f")), input(false))
    notWritten(result)
    expect(codesOf(result)).toContain("sql.declaration-check-missing")
  })

  it("a check the existing guard does not apply (arguments) is refused", async () => {
    const two = definer("f", GUARD).replace(
      "p_row uuid",
      "p_row uuid, p_other uuid"
    )
    const files = folder(two, [
      {
        id: uuid(883_001),
        function: { name: "f" },
        callers: ["user"],
        check: CHECK,
      },
    ])
    expect((await compile(files)).ok).toBe(true)
    const result = await declare(files, {
      function: { name: "f" },
      callers: ["user"],
      check: { ...CHECK, row: "p_other" },
    })
    notWritten(result)
    expect(errorsOf(result).map((d) => d.params?.reason)).toContain("arguments")
  })

  // Тіла, які `fix` не чіпає (Р3): виняток цілі їх не пропускає.
  it.each([
    ["DECLARE", "DECLARE v int; BEGIN PERFORM 1; END"],
    [
      "an outer EXCEPTION section",
      "BEGIN PERFORM 1; EXCEPTION WHEN OTHERS THEN NULL; END",
    ],
  ])("a body with %s is refused", async (_name, body) => {
    const result = await declare(folder(definer("f", body)), input())
    notWritten(result)
    expect(codesOf(result)).toContain("sql.declaration-check-not-applied")
  })

  it("replacing a record whose body already applies the check is clean", async () => {
    const files = folder(definer("f", GUARD), [
      {
        id: uuid(883_002),
        function: { name: "f" },
        callers: ["service"],
        check: CHECK,
      },
    ])
    const result = await declare(files, input())
    expect(result.ok).toBe(true)
    expect(result.written).toBeUndefined()
  })

  it("an error outside the class in the input refuses", async () => {
    const files = folder(definer("f"))
    files.set("catalogs/Broken/Broken.meta.json", "{")
    const result = await declare(files, input())
    notWritten(result)
    expect(result.changes).toEqual([])
    expect(codesOf(result)).toContain("operation.input-invalid")
  })

  // Ціль без `check` дістає нову помилку класу `check-missing`: відмова.
  it("the target declared without a check is refused with check-missing", async () => {
    const files = folder(definer("f") + definer("g"), [
      { id: uuid(883_003), function: { name: "g" }, callers: ["service"] },
    ])
    expect((await compile(files, { repair: true })).model).toBeDefined()
    // Недекларована `f` лишається як була; нова помилка — `check-missing` `g`.
    const result = await declare(files, {
      function: { name: "g" },
      callers: ["user"],
    })
    notWritten(result)
    expect(codesOf(result)).toContain("sql.declaration-check-missing")
  })
})

describe("declareFunction: other records and verbatim grants", () => {
  const TEAM_SQL = "sql/public/team.sql"
  const TEAM_FUNCTIONS = "sql/public/team.functions.json"
  const OTHER_SQL = "sql/public/other.sql"
  const OTHER_FUNCTIONS = "sql/public/other.functions.json"
  const teamFiles = (callers: string[]) => {
    const files = metaFiles({
      "project.meta.json": project({
        scopeKinds: [
          {
            id: uuid(9401),
            name: "team",
            physicalName: "team_id",
            root: {
              external: { schema: "public", table: "teams", column: "id" },
            },
            setFunction: { schema: "public", name: "team_ids" },
          },
        ],
      }),
      "catalogs/Item/Item.meta.json": catalog("Item", { scope: "none" }),
      [TEAM_SQL]: `CREATE FUNCTION public.team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' SET TimeZone = 'UTC' SET DateStyle = 'ISO, MDY' SET IntervalStyle = 'postgres' SET extra_float_digits = '1' AS $$ SELECT NULL::uuid $$;\n`,
      [TEAM_FUNCTIONS]: JSON.stringify({
        functions: [
          { id: uuid(9402), function: { name: "team_ids" }, callers },
        ],
      }),
      [OTHER_SQL]: invoker("other"),
    })
    // Функція множини — авторська (`team.sql`): спільний файл фікстури
    // створив би другу.
    files.delete(SCOPE_FUNCTIONS_FILE)
    return files
  }

  // Мутація: `declineWidening` вимкнено — декларація чужої функції видаляє
  // запис `team_ids`, який `fix` свідомо лишив, і `EXECUTE` розширюється.
  it("keeps a record whose platform form would widen EXECUTE", async () => {
    const files = teamFiles(["service"])
    const result = await declare(files, {
      function: { name: "other" },
      callers: ["service"],
    })
    expect(result.changes.map((c) => c.path)).toEqual([OTHER_FUNCTIONS])
    expect(applyChanges(files, result.changes).get(TEAM_FUNCTIONS)).toBe(
      files.get(TEAM_FUNCTIONS)
    )
    const [warning] = result.diagnostics.filter(
      (d) => d.code === "sql.declaration-platform-form-widens"
    )
    expect(warning!.params).toMatchObject({ name: "team_ids", declined: 1 })
    expect(result.written).toBe(true)
  })

  it("removes a record the platform form covers with the same callers", async () => {
    const result = await declare(teamFiles(["user", "command", "service"]), {
      function: { name: "other" },
      callers: ["service"],
    })
    expect(
      result.changes.find((c) => c.path === TEAM_FUNCTIONS)?.content
    ).toBeNull()
  })

  const REVOKE_GRANT =
    "REVOKE EXECUTE ON FUNCTION public.f(uuid) FROM PUBLIC;\nGRANT EXECUTE ON FUNCTION public.f(uuid) TO authenticated;\n"

  // Мутація: крок вирізу грантів у `declareFunction` прибрано.
  it("cuts the verbatim grants of the target, then fix has nothing to do", async () => {
    const files = await acceptDebt(folder(definer("f") + REVOKE_GRANT))
    const result = await declare(files, {
      function: { name: "f" },
      callers: ["user"],
      check: CHECK,
    })
    expect(result.written).toBe(true)
    const after = applyChanges(files, result.changes)
    expect(after.get(SQL)).not.toContain("GRANT EXECUTE")
    expect(errorsOf(result).map((d) => d.code)).toEqual([
      "sql.declaration-check-not-applied",
    ])
    const fixed = await fixFiles(after, options())
    expect(errorsOf(fixed)).toEqual([])
    expect(fixed.ok).toBe(true)
  })
})

describe("declareFunction: the widening note", () => {
  const notes = (r: { diagnostics: readonly Diagnostic[] }) =>
    r.diagnostics.filter((d) => d.code === "sql.declaration-execute-widened")

  // Мутація: примітку не сформовано.
  it("a new record names every caller role", async () => {
    const result = await declare(folder(invoker("f")), {
      function: { name: "f" },
      callers: ["user", "service"],
    })
    const [note] = notes(result)
    expect(note).toMatchObject({
      severity: "warning",
      file: FUNCTIONS,
      params: { function: "public.f", roles: "user, service" },
    })
  })

  it("replacing service with user names only the user role", async () => {
    const files = folder(definer("f", GUARD), [
      {
        id: uuid(882_001),
        function: { name: "f" },
        callers: ["service"],
        check: CHECK,
      },
    ])
    const result = await declare(files, {
      function: { name: "f" },
      callers: ["user", "service"],
      check: CHECK,
    })
    expect(notes(result).map((d) => d.params?.roles)).toEqual(["user"])
  })

  it("narrowing the callers gives no note", async () => {
    const files = folder(definer("f", GUARD), [
      {
        id: uuid(882_002),
        function: { name: "f" },
        callers: ["service", "command"],
        check: CHECK,
      },
    ])
    const result = await declare(files, {
      function: { name: "f" },
      callers: ["service"],
    })
    expect(notes(result)).toEqual([])
  })
})

// Предикат умов вставки запобіжника — єдине місце для `declare-function` і
// `fix` (в): зсув одразу після `BEGIN` зовнішнього блоку.
describe("guardInsertionPoint", () => {
  let parse: SqlParser
  let plpgsql: PlpgsqlParser
  beforeAll(async () => {
    parse = await loadSqlParser()
    plpgsql = await loadPlpgsqlParser()
  })

  const check = { ...CHECK } as NonNullable<SqlFunctionDeclaration["check"]>
  const unitOf = (sql: string): VerbatimUnit => {
    const tree = (parse(sql) as { statements: { stmt: unknown }[] })
      .statements[0]!.stmt
    return {
      class: "function",
      identity: "function:public.f",
      schema: "public",
      name: "f",
      file: "f.sql",
      line: 1,
      sql,
      tree,
    }
  }
  const point = (sql: string, c = check) => {
    const unit = unitOf(sql)
    return guardInsertionPoint(unit, c, [unit], plpgsql, parse)
  }
  const create = (body: string, head = "SECURITY DEFINER", lang = "plpgsql") =>
    `CREATE FUNCTION public.f(p_row uuid) RETURNS void LANGUAGE ${lang} ${head} SET search_path = '' AS ${body};`

  it("points right after BEGIN of the outer block", () => {
    const sql = create("$$BEGIN PERFORM 1; END$$")
    expect(point(sql)).toBe(sql.indexOf("BEGIN") + "BEGIN".length)
  })

  it("skips a label, comments and a tagged literal", () => {
    const sql = create("$b$ /* c */ <<blk>> -- x\n begin PERFORM 1; END $b$")
    expect(point(sql)).toBe(sql.indexOf("begin") + "begin".length)
  })

  it("ignores the word BEGIN inside a string before the body literal", () => {
    const sql = `CREATE FUNCTION public.f(p_row uuid, p text DEFAULT $d$BEGIN$d$) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$BEGIN PERFORM 1; END$$;`
    expect(point(sql)).toBe(sql.lastIndexOf("BEGIN") + "BEGIN".length)
  })

  it.each([
    ["an invoker function", create("$$BEGIN PERFORM 1; END$$", "")],
    [
      "a sql language function",
      create("$$ SELECT 1 $$", "SECURITY DEFINER", "sql"),
    ],
    ["a single-quoted body", create("'BEGIN PERFORM 1; END'")],
    ["a DECLARE section", create("$$DECLARE v int; BEGIN PERFORM 1; END$$")],
    [
      "an outer EXCEPTION section",
      create("$$BEGIN PERFORM 1; EXCEPTION WHEN OTHERS THEN NULL; END$$"),
    ],
    [
      "a guard call anywhere",
      create(
        "$$BEGIN PERFORM 1; PERFORM simetra.rights_require('read', 'task', p_row); END$$"
      ),
    ],
    [
      "a guard call of the other form",
      create(
        "$$BEGIN PERFORM 1; PERFORM simetra.rights_require_scope('read', 'task', p_row); END$$"
      ),
    ],
    [
      // Ім'я, якого текстовий пошук не бачить: розібране ім'я збігається.
      "a guard call named by a unicode escape",
      create(
        "$$BEGIN PERFORM 1; PERFORM simetra.U&\"rights\\005frequire\"('read', 'task', p_row); END$$"
      ),
    ],
    [
      "a dynamic guard call",
      create("$$BEGIN EXECUTE 'SELECT simetra.rights_require(1)'; END$$"),
    ],
    [
      "a guard as the first statement (not firstStatement)",
      create(
        "$$BEGIN PERFORM simetra.rights_require('read', 'task', p_row); END$$"
      ),
    ],
  ])("does not insert into %s", (_name, sql) => {
    expect(point(sql)).toBeUndefined()
  })
})
