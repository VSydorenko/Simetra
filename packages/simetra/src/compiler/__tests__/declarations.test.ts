import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { readFiles } from "../pipeline"
import type { SqlFunctionDeclaration } from "simetra/model"
import {
  checkDeclarations,
  declaredFunctions,
  platformFormFunctions,
} from "../sql/declarations"
import type { VerbatimUnit } from "../sql/units"
import {
  COUNT_COMMENT_SQL_FILE,
  DIMENSION_SQL,
  compiledPolicyDomain,
  dimensionFunction,
  teamScopeKind,
} from "./fixtures/rights"
import {
  SCOPE_FUNCTIONS_FILE,
  acceptDebt,
  metaFiles,
  project,
  uuid,
} from "./helpers"

const SQL = "sql/public/fns.sql"
const FUNCTIONS = "sql/public/fns.functions.json"
const OTHER_SQL = "sql/public/other.sql"
const OTHER_FUNCTIONS = "sql/public/other.functions.json"

const CODES = [
  "sql.declaration-target-missing",
  "sql.declaration-overload",
  "sql.declaration-duplicate",
  "sql.declaration-platform-form",
]

/** Функція в закритій оболонці: ні боргу, ні інших діагностик. */
const fn = (name: string, args = "") =>
  `CREATE FUNCTION ${name}(${args}) RETURNS int LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n`

let nextId = 7000
const declaration = (
  fn: { schema?: string; name: string },
  callers: SqlFunctionDeclaration["callers"] = ["user"]
): SqlFunctionDeclaration => ({ id: uuid(++nextId), function: fn, callers })

const functionsFile = (...entries: SqlFunctionDeclaration[]) =>
  JSON.stringify({ functions: entries })

async function declarationDiagnostics(files: Map<string, string>) {
  const { diagnostics } = await compile(files)
  return diagnostics
    .filter((d) => CODES.includes(d.code))
    .map((d) => [d.code, d.file, d.pointer, d.params])
}

const shared = (entries: Record<string, string>) =>
  declarationDiagnostics(
    metaFiles({ "project.meta.json": project(), ...entries })
  )

const keyParams = (schema: string, name: string) => ({
  schema,
  name,
  function: `${schema}.${name}`,
})

describe("declaration resolution", () => {
  it("a declaration of a function of the sibling .sql compiles clean", async () => {
    const files = metaFiles({
      "project.meta.json": project(),
      [SQL]: fn("public.f"),
      [FUNCTIONS]: functionsFile(declaration({ name: "f" })),
    })
    expect((await compile(files)).diagnostics).toEqual([])
  })

  it("a function missing from the sibling .sql is target-missing on the entry", async () => {
    expect(
      await shared({
        [SQL]: fn("public.f"),
        [OTHER_SQL]: fn("public.g"),
        // `g` є, але в іншому файлі: декларація описує лише сусідній `.sql`.
        [FUNCTIONS]: functionsFile(declaration({ name: "g" })),
      })
    ).toEqual([
      [
        "sql.declaration-target-missing",
        FUNCTIONS,
        "/functions/0",
        { ...keyParams("public", "g"), sqlFile: SQL },
      ],
    ])
  })

  it("an overloaded function is declaration-overload", async () => {
    expect(
      await shared({
        [SQL]: fn("public.f", "a int") + fn("public.f", "a text"),
        [FUNCTIONS]: functionsFile(declaration({ name: "f" })),
      })
    ).toEqual([
      [
        "sql.declaration-overload",
        FUNCTIONS,
        "/functions/0",
        { ...keyParams("public", "f"), count: 2 },
      ],
    ])
  })

  it("an overload in another file of the same pg_proc name is declaration-overload", async () => {
    expect(
      await shared({
        [SQL]: fn("public.f"),
        [OTHER_SQL]: fn("public.f", "a int"),
        [FUNCTIONS]: functionsFile(declaration({ name: "f" })),
      })
    ).toEqual([
      [
        "sql.declaration-overload",
        FUNCTIONS,
        "/functions/0",
        { ...keyParams("public", "f"), count: 2 },
      ],
    ])
  })

  it("two entries of one file are duplicates after defaultSchema", async () => {
    // Записано різне (`{ name }` і `{ schema, name }`), тож схема T0 їх
    // приймає; функція та сама.
    expect(
      await shared({
        [SQL]: fn("public.f"),
        [FUNCTIONS]: functionsFile(
          declaration({ name: "f" }),
          declaration({ schema: "public", name: "f" })
        ),
      })
    ).toEqual([
      [
        "sql.declaration-duplicate",
        FUNCTIONS,
        "/functions/1",
        { ...keyParams("public", "f"), first: `${FUNCTIONS}/functions/0` },
      ],
    ])
  })

  it("an entry of another file declaring the same function is a duplicate", async () => {
    expect(
      await shared({
        [SQL]: fn("public.f"),
        [OTHER_SQL]: fn("public.g"),
        [FUNCTIONS]: functionsFile(declaration({ name: "f" })),
        [OTHER_FUNCTIONS]: functionsFile(
          declaration({ schema: "public", name: "f" })
        ),
      })
    ).toEqual([
      [
        "sql.declaration-duplicate",
        OTHER_FUNCTIONS,
        "/functions/0",
        { ...keyParams("public", "f"), first: `${FUNCTIONS}/functions/0` },
      ],
      [
        "sql.declaration-target-missing",
        OTHER_FUNCTIONS,
        "/functions/0",
        { ...keyParams("public", "f"), sqlFile: OTHER_SQL },
      ],
    ])
  })

  it("an entry of a .sql that does not parse is not judged target-missing", async () => {
    const found = await shared({
      [SQL]: "CREATE FUNCTION broken(",
      [FUNCTIONS]: functionsFile(declaration({ name: "f" })),
    })
    expect(found).toEqual([])
  })
})

describe("declaration key: a (schema, name) pair", () => {
  // Ідентифікатори в лапках з крапкою: `"a.b".c` і `a."b.c"` сире склеювання
  // звело б до того самого рядка `a.b.c`; ключ пари — за `qualifiedName`.
  // Одиниці тут — пряма фікстура, а не `.sql`.
  const units = [
    unit("a.b", "c", SQL),
    unit("a", "b.c", SQL),
  ] satisfies VerbatimUnit[]
  const stage1 = readFiles(
    metaFiles({ "project.meta.json": project(), [SQL]: "" })
  )

  it("each declaration resolves to its own function", () => {
    const declared = declaredFunctions(
      [
        {
          file: FUNCTIONS,
          sqlFile: SQL,
          functions: [
            declaration({ schema: "a", name: "b.c" }),
            declaration({ schema: "a.b", name: "c" }),
          ],
        },
      ],
      units,
      "public"
    )
    expect(
      declared.map((d) => [d.pointer, d.key, d.unit.schema, d.unit.name])
    ).toEqual([
      ["/functions/0", { schema: "a", name: "b.c" }, "a", "b.c"],
      ["/functions/1", { schema: "a.b", name: "c" }, "a.b", "c"],
    ])
  })

  it.each([
    {
      name: "in one file",
      files: [
        {
          file: FUNCTIONS,
          sqlFile: SQL,
          functions: [
            declaration({ schema: "a", name: "b.c" }),
            declaration({ schema: "a.b", name: "c" }),
          ],
        },
      ],
    },
    {
      name: "in two files",
      files: [
        {
          file: FUNCTIONS,
          sqlFile: SQL,
          functions: [declaration({ schema: "a", name: "b.c" })],
        },
        {
          file: OTHER_FUNCTIONS,
          sqlFile: SQL,
          functions: [declaration({ schema: "a.b", name: "c" })],
        },
      ],
    },
  ])("are no duplicates or overloads $name", ({ files }) => {
    expect(
      checkDeclarations(files, units, stage1.objects, stage1.project, new Set())
    ).toEqual([])
  })
  it("platform forms keep both functions of a dotted pair", () => {
    const kind = (
      n: number,
      setFunction: { schema: string; name: string }
    ) => ({
      id: uuid(n),
      name: `kind${n}`,
      physicalName: `kind${n}_id`,
      root: { external: { schema: "public", table: "teams", column: "id" } },
      setFunction,
    })
    const { objects, project: parsed } = readFiles(
      metaFiles({
        "project.meta.json": project({
          scopeKinds: [
            kind(7901, { schema: "a.b", name: "c" }),
            kind(7902, { schema: "a", name: "b.c" }),
          ],
        }),
      })
    )
    expect(
      [...platformFormFunctions(objects, parsed).values()].map(
        (f) => f.function
      )
    ).toEqual([
      { schema: "a.b", name: "c" },
      { schema: "a", name: "b.c" },
    ])
  })
})

describe("declaredFunctions", () => {
  // Нерезолвлена декларація не має давати функції ні виключення з боргу, ні
  // (далі) `EXECUTE`: декларація описує лише функцію сусіднього `.sql`.
  it("does not resolve a function of another .sql file", () => {
    expect(
      declaredFunctions(
        [
          {
            file: FUNCTIONS,
            sqlFile: SQL,
            functions: [declaration({ name: "g" })],
          },
        ],
        [unit("public", "g", OTHER_SQL)],
        "public"
      )
    ).toEqual([])
  })
})

function unit(schema: string, name: string, file: string): VerbatimUnit {
  return {
    class: "function",
    identity: `function:${schema}.${name}()`,
    schema,
    name,
    file,
    line: 1,
    sql: "",
    tree: {},
  }
}

describe("sql.declaration-platform-form", () => {
  const sidecar = (sql: string) => sql.replace(/\.sql$/, ".functions.json")
  const platformForm = async (
    sql: Record<string, string>,
    layers: Parameters<typeof compiledPolicyDomain>[1]
  ) =>
    (await compiledPolicyDomain(sql, layers)).diagnostics
      .filter((d) => CODES.includes(d.code))
      .map((d) => [d.code, d.file, d.pointer, d.params])

  it.each<{
    form: string
    name: string
    file: string
    sql: Record<string, string>
    layers: Parameters<typeof compiledPolicyDomain>[1]
  }>([
    {
      form: "setFunction",
      name: "team_ids",
      file: SCOPE_FUNCTIONS_FILE,
      sql: {
        [SCOPE_FUNCTIONS_FILE]:
          "CREATE FUNCTION public.team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT NULL::uuid $$;\n",
      },
      layers: [teamScopeKind()],
    },
    {
      form: "subscriptionHandler",
      name: "count_comment",
      file: COUNT_COMMENT_SQL_FILE,
      sql: {},
      layers: [],
    },
    {
      form: "dimension",
      name: "region_ids",
      file: "sql/public/region.sql",
      sql: { "sql/public/region.sql": DIMENSION_SQL },
      layers: [dimensionFunction()],
    },
  ])("a declaration of a $form", async ({ form, name, file, sql, layers }) => {
    expect(
      await platformForm(
        {
          ...sql,
          [sidecar(file)]: functionsFile(declaration({ name }, [])),
        },
        layers
      )
    ).toEqual([
      [
        "sql.declaration-platform-form",
        sidecar(file),
        "/functions/0",
        { ...keyParams("public", name), form },
      ],
    ])
  })
})

/** Definer-функція в закритій оболонці: ні боргу, ні інших діагностик. */
const definer = (name: string) =>
  `CREATE FUNCTION ${name}() RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;\n`

const CALLER_CODES = [
  "sql.declaration-check-missing",
  "sql.declaration-check-not-applied",
  "sql.declaration-anonymous-definer",
  "sql.definer-caller-unchecked",
  "sql.definer-reads-rls",
]

async function callerDiagnostics(files: Map<string, string>) {
  const { diagnostics } = await compile(files)
  return diagnostics
    .filter((d) => CALLER_CODES.includes(d.code))
    .map((d) => [d.code, d.file, d.pointer, d.params])
}

// Інваріант 4: definer-функція з викликачами від імені користувача не
// компілюється без названої перевірки; доказ перевірки — `guard-of.test.ts`.
describe("callers of a declared SECURITY DEFINER function", () => {
  const declared = (entry: SqlFunctionDeclaration, sql = definer("public.f")) =>
    callerDiagnostics(
      metaFiles({
        "project.meta.json": project(),
        [SQL]: sql,
        [FUNCTIONS]: functionsFile(entry),
      })
    )
  const at = (code: string, extra: Record<string, string> = {}) => [
    code,
    FUNCTIONS,
    "/functions/0",
    { ...keyParams("public", "f"), ...extra },
  ]

  it.each<{
    name: string
    callers: SqlFunctionDeclaration["callers"]
    expected: unknown[]
  }>([
    {
      name: "user without check is check-missing",
      callers: ["user"],
      expected: [at("sql.declaration-check-missing")],
    },
    {
      // Роль команд діє від імені користувача (спека прав §5.2).
      name: "command without check is check-missing",
      callers: ["command"],
      expected: [at("sql.declaration-check-missing")],
    },
    {
      name: "anonymous is anonymous-definer",
      callers: ["anonymous"],
      expected: [at("sql.declaration-anonymous-definer")],
    },
    {
      name: "anonymous and user are both refused",
      callers: ["anonymous", "user"],
      expected: [
        at("sql.declaration-anonymous-definer"),
        at("sql.declaration-check-missing"),
      ],
    },
    {
      // Сервісна роль не діє від імені користувача.
      name: "service alone compiles without a check",
      callers: ["service"],
      expected: [],
    },
    {
      name: "no callers compile without a check",
      callers: [],
      expected: [],
    },
  ])("$name", async ({ callers, expected }) => {
    expect(await declared(declaration({ name: "f" }, callers))).toEqual(
      expected
    )
  })

  it("an invoker function with every caller compiles clean", async () => {
    const files = metaFiles({
      "project.meta.json": project(),
      [SQL]: fn("public.f"),
      [FUNCTIONS]: functionsFile(
        declaration({ name: "f" }, ["user", "anonymous", "service", "command"])
      ),
    })
    expect((await compile(files)).diagnostics).toEqual([])
  })
})

// Р7: кожна помилка класу ремонту ототожнюється кортежем `code`, `schema`,
// `name`, тож кожен код класу несе обидва параметри.
describe("repair-class codes carry params.schema and params.name", () => {
  // Дослівний ADP — борг: його приймає ратчет, предмет тесту — інше правило.
  const compiled = async (entries: Record<string, string>) =>
    (
      await compile(
        await acceptDebt(
          metaFiles({ "project.meta.json": project(), ...entries })
        )
      )
    ).diagnostics

  it.each<{
    code: string
    diagnostics: () => Promise<readonly { code: string; params?: object }[]>
    schema: string
    name: string
  }>([
    {
      code: "sql.definer-caller-unchecked",
      diagnostics: () => compiled({ [SQL]: definer("public.f") }),
      schema: "public",
      name: "f",
    },
    {
      code: "sql.declaration-check-missing",
      diagnostics: () =>
        compiled({
          [SQL]: definer("public.f"),
          [FUNCTIONS]: functionsFile(declaration({ name: "f" }, ["user"])),
        }),
      schema: "public",
      name: "f",
    },
    {
      code: "sql.declaration-platform-form",
      diagnostics: async () =>
        (
          await compiledPolicyDomain(
            {
              "sql/public/region.sql": DIMENSION_SQL,
              "sql/public/region.functions.json": functionsFile(
                declaration({ name: "region_ids" }, [])
              ),
            },
            [dimensionFunction()]
          )
        ).diagnostics,
      schema: "public",
      name: "region_ids",
    },
    {
      code: "sql.default-privileges-execute",
      diagnostics: () =>
        compiled({
          "sql/app/adp.sql":
            "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO anon;\n",
        }),
      schema: "app",
      // Ідентичність одиниці ADP: два різні ADP на ту саму схему й роль
      // (інші отримувачі чи привілеї) — різні ключі.
      name: "defaultPrivileges:postgres:app:function:grant:anon:execute",
    },
  ])("$code", async ({ code, diagnostics, schema, name }) => {
    const found = (await diagnostics()).filter((d) => d.code === code)
    expect(found).toHaveLength(1)
    expect(found[0]!.params).toMatchObject({ schema, name })
  })
})

// Р15, інваріант 9: типові привілеї не віддають `EXECUTE` майбутнім функціям
// повз виведені гранти.
describe("sql.default-privileges-execute", () => {
  const ADP_FILE = "sql/app/adp.sql"
  const adp = async (entries: Record<string, string>) =>
    (
      await compile(
        await acceptDebt(
          metaFiles({ "project.meta.json": project(), ...entries })
        )
      )
    ).diagnostics
      .filter((d) => d.code === "sql.default-privileges-execute")
      .map((d) => [d.file, d.params])

  it.each<{ name: string; entries: Record<string, string> }>([
    {
      name: "beside a declared service-only definer function",
      entries: {
        [SQL]: definer("public.f"),
        [FUNCTIONS]: functionsFile(declaration({ name: "f" }, ["service"])),
      },
    },
    {
      name: "beside an undeclared definer function",
      entries: { [SQL]: definer("public.f") },
    },
  ])("an ADP in schema app is refused $name", async ({ entries }) => {
    expect(
      await adp({
        ...entries,
        [ADP_FILE]:
          "ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO authenticated;\n",
      })
    ).toEqual([
      [
        ADP_FILE,
        {
          schema: "app",
          // Ключ класу ремонту — ідентичність одиниці ADP (див. нижче).
          name: "defaultPrivileges::app:function:grant:authenticated:execute",
          line: 1,
        },
      ],
    ])
  })

  it.each([
    // Postgres розбирає ROUTINES у той самий клас об'єктів, що й FUNCTIONS.
    "ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON ROUTINES TO anon;",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ALL ON ROUTINES TO PUBLIC;",
    // Глобальний ADP досягає кожної схеми.
    "ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon;",
    // Виняток провайдера — лише в його керованій схемі.
    "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;",
  ])("refuses %s", async (statement) => {
    expect(await adp({ [ADP_FILE]: `${statement}\n` })).toHaveLength(1)
  })

  it.each([
    // ADP пресету Supabase у керованій `public`: не SQL застосунку.
    "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;",
  ])(
    "the provider owner's ADP in public is not judged: %s",
    async (statement) => {
      expect(await adp({ [SQL]: `${statement}\n` })).toEqual([])
    }
  )

  it.each([
    // Роль команд не має типових привілеїв, які рахувало б `checkDefinerReads`.
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO simetra_command;",
    // ADP іншої ролі — не ADP провайдера.
    "ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;",
  ])(
    "an ADP in public outside the provider preset is refused: %s",
    async (statement) => {
      expect(await adp({ [SQL]: `${statement}\n` })).toHaveLength(1)
    }
  )

  it.each([
    "ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;",
    "ALTER DEFAULT PRIVILEGES REVOKE ALL ON ROUTINES FROM anon;",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO anon;",
  ])("does not judge %s", async (statement) => {
    expect(await adp({ [ADP_FILE]: `${statement}\n` })).toEqual([])
  })
})
