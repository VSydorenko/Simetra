import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  compile,
  formPolicies,
  loadSqlParser,
  readSqlUnits,
  type Diagnostic,
  type SchemaPathResolver,
  type SqlParser,
} from "simetra/compiler"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  PROVIDER_OWNER_ROLES,
  catalogFromSnapshot,
  type CatalogModel,
  type CatalogUnit,
  type DatabaseProvider,
} from "simetra/model"
import {
  reverseGenerate,
  type ExecuteFacts,
  type FunctionExecuteFact,
  type ReverseResult,
} from "simetra/schema"
import {
  catalog,
  metaFiles,
  project,
  uuid,
} from "../../compiler/__tests__/helpers"
import {
  teamScopeKind,
  withRoles,
} from "../../compiler/__tests__/fixtures/rights"
import { pinnedSettingsClause } from "../../compiler/sql/head-settings"
import {
  DOCS_GRANT,
  POLICY_DEBT,
  POLICY_FUNCTION,
  POLICY_SHELL,
  READ_POLICY,
  policyFiles,
} from "../../compiler/__tests__/fixtures/policy-function"

// Скільки разів зворотна генерація рахує стадію SQL чернетки заради функцій
// політик: обгортка кличе справжній розпізнавач
const policyRuns = vi.hoisted(() => ({ count: 0 }))
vi.mock("simetra/compiler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("simetra/compiler")>()
  return {
    ...actual,
    formPolicies: (files: ReadonlyMap<string, string>) => {
      policyRuns.count += 1
      return actual.formPolicies(files)
    },
  }
})

/**
 * Декларації definer-функцій у зворотній генерації (спека декларацій функцій
 * §5.5): факти `EXECUTE` з каталогу бази, `check` із запобіжника, без
 * дослівних грантів задекларованої функції.
 */

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const schemaPath: SchemaPathResolver = (file, schemaFile) =>
  `schemas-of/${file}/${schemaFile}`

const ACTION_ID = "0a1b2c3d-0000-4000-8000-000000000001"

/** Тека з об'єктом `Task` (мітка `task`, скоуп `org`) і словником дій. */
const FOLDER = () => withRoles()

function projectOf(files: ReadonlyMap<string, string>) {
  const data = JSON.parse(files.get("project.meta.json")!) as {
    name: string
    defaultSchema?: string
    naming?: { attributeCase?: "camelCase" | "snake_case" }
    database: { provider: DatabaseProvider }
  }
  return {
    name: data.name,
    defaultSchema: data.defaultSchema ?? "public",
    attributeCase: data.naming?.attributeCase ?? "camelCase",
    databaseProvider: data.database.provider,
  }
}

function counter(start = 700_000): () => string {
  let n = start
  return () => uuid(++n)
}

function options(
  existing: ReadonlyMap<string, string>,
  executeFacts: ExecuteFacts | undefined,
  idStart?: number
) {
  return {
    project: projectOf(existing),
    existing,
    newId: counter(idStart),
    schemaPath,
    parse,
    ...(executeFacts === undefined ? {} : { executeFacts }),
  }
}

function units(sql: string): CatalogUnit[] {
  const read = readSqlUnits(
    [{ file: "x.sql", text: sql, schema: "" }],
    parse,
    []
  )
  expect(read.diagnostics).toEqual([])
  return read.units.map((u) => ({
    class: u.class,
    identity: u.identity,
    schema: u.schema,
    name: u.name,
    sql: u.sql,
    ...(u.class === "function" ? { volatility: "stable" as const } : {}),
  }))
}

const model = (sql: string): CatalogModel => ({
  tables: [],
  enumTypes: [],
  units: units(sql),
})

/** Ролі профілю, які є в базі, і власник провайдера. */
function profile(provider: DatabaseProvider) {
  const api = PROVIDER_API_ROLES[provider]
  return {
    owner: PROVIDER_OWNER_ROLES[provider],
    user: api.user,
    anonymous: api.anonymous,
    service: api.service,
    command: PLATFORM_ROLES.command,
    roles: [
      api.user,
      api.anonymous,
      api.service,
      PLATFORM_ROLES.command,
    ].filter((r): r is string => typeof r === "string"),
  }
}

interface FactOptions {
  provider?: DatabaseProvider
  /** Отримувачі в ACL (ім'я ролі чи `PUBLIC`); власник є завжди. */
  grants?: string[]
  /** Ролі профілю з дієвим `EXECUTE`; типово — ті, що названі в `grants`. */
  executes?: string[]
  /** Ролі профілю без `USAGE` на схему. */
  noUsage?: string[]
  grantor?: string
  grantable?: boolean
  identityArguments?: string
  schema?: string
}

function fact(name: string, o: FactOptions = {}): FunctionExecuteFact {
  const p = profile(o.provider ?? "supabase")
  const grants = o.grants ?? []
  const via = (role: string) =>
    grants.includes("PUBLIC") || grants.includes(role)
  const executes = o.executes ?? p.roles.filter(via)
  return {
    schema: o.schema ?? "public",
    name,
    identityArguments: o.identityArguments ?? "",
    owner: p.owner,
    acl: [
      { grantee: p.owner, grantor: p.owner, grantable: false },
      ...grants.map((grantee) => ({
        grantee,
        grantor: o.grantor ?? p.owner,
        grantable: o.grantable ?? false,
      })),
    ],
    executeByRole: Object.fromEntries(
      p.roles.map((r) => [r, executes.includes(r)])
    ),
    schemaUsageByRole: Object.fromEntries(
      p.roles.map((r) => [r, !(o.noUsage ?? []).includes(r)])
    ),
  }
}

const facts = (...functions: FunctionExecuteFact[]): ExecuteFacts => ({
  missingRoles: [],
  functions,
  crossCheckFailures: [],
  catalogChanged: false,
})

const ROW = "p_id"

/** definer-RPC у закритій оболонці з вмістом `body` між `BEGIN` і `END`. */
const rpc = (name: string, body: string, args = "p_id uuid") =>
  `CREATE FUNCTION public.${name}(${args}) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$ BEGIN ${body} END $$;`

const guarded = (name: string, call = `'read', 'task', ${ROW}`) =>
  rpc(name, `PERFORM simetra.rights_require(${call});`)

const errorsOf = (result: ReverseResult) =>
  result.diagnostics.filter((d) => d.severity === "error")
const codes = (list: readonly Diagnostic[]) => list.map((d) => d.code)
const declarationsOf = (result: ReverseResult, path: string) => {
  const text = result.files.get(path)
  expect(text, path).toBeDefined()
  return (JSON.parse(text!) as { functions: Record<string, unknown>[] })
    .functions
}
const RPC_FUNCTIONS = "sql/public/rpc__uuid.functions.json"
const warning = (result: ReverseResult, code: string) =>
  result.diagnostics.filter((d) => d.code === code)

describe("declarations of definer functions", () => {
  it.each(["supabase", "postgres"] as const)(
    "%s: PUBLIC gives the roles with a session, drops the role without one with a warning",
    async (provider) => {
      const existing = withRoles()
      // Профіль провайдера задає проєкт теки
      const files = new Map(existing)
      files.set(
        "project.meta.json",
        JSON.stringify({
          ...JSON.parse(existing.get("project.meta.json")!),
          database: { provider },
        })
      )
      const result = await reverseGenerate(
        model(guarded("rpc")),
        options(files, facts(fact("rpc", { provider, grants: ["PUBLIC"] })))
      )
      expect(errorsOf(result).filter((d) => d.severity === "error")).toEqual([])
      const [entry] = declarationsOf(result, RPC_FUNCTIONS)
      // Роль без сесії викликачем не стає; сервісної ролі профіль `postgres` не має
      expect(entry!.callers).toEqual(
        provider === "supabase"
          ? ["user", "service", "command"]
          : ["user", "command"]
      )
      expect(
        warning(result, "introspect.execute-narrowed").map((d) => d.params)
      ).toEqual([
        {
          function: "public.rpc",
          role: PROVIDER_API_ROLES[provider].anonymous,
          reason: "anonymous",
        },
      ])
    }
  )

  // Каталог не друкує типову VOLATILE, а закрита оболонка вимагає її явно:
  // без дописаного слова definer-функція лишалася без декларації мовчки.
  // Мутація: не дописувати слово в текст, який судить `declarations`.
  it("a definer with the catalog default VOLATILE gets a declaration and a closed shell", async () => {
    const text = `CREATE FUNCTION public.rpc(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN NULL; END $$;`
    const catalogModel = model(text)
    catalogModel.units = catalogModel.units.map((u) => ({
      ...u,
      sql: text,
      ...(u.class === "function" ? { volatility: "volatile" as const } : {}),
    }))
    const result = await reverseGenerate(
      catalogModel,
      options(FOLDER(), facts(fact("rpc", { grants: ["PUBLIC"] })))
    )
    const [entry] = declarationsOf(result, RPC_FUNCTIONS)
    expect(entry!.callers).toEqual(["user", "service", "command"])
    // Файл функції несе то саме явне слово, тож тека компілюється з закритою оболонкою
    expect(result.files.get("sql/public/rpc__uuid.sql")).toContain("VOLATILE")
  })

  it("only the owner can execute: no declaration", async () => {
    const result = await reverseGenerate(
      model(
        `${rpc("rpc", "NULL;")}\nREVOKE EXECUTE ON FUNCTION public.rpc(uuid) FROM PUBLIC, authenticated, anon, service_role;`
      ),
      options(FOLDER(), facts(fact("rpc")))
    )
    expect(
      [...result.files.keys()].filter((p) => p.endsWith(".functions.json"))
    ).toEqual([])
    expect(errorsOf(result)).toEqual([])
  })

  it.each(["supabase", "postgres"] as const)(
    "%s: EXECUTE only for the anonymous role without a guard: a declaration without callers, the grant is revoked",
    async (provider) => {
      const anonymous = PROVIDER_API_ROLES[provider].anonymous!
      const existing = withRoles()
      const files = new Map(existing)
      files.set(
        "project.meta.json",
        JSON.stringify({
          ...JSON.parse(existing.get("project.meta.json")!),
          database: { provider },
        })
      )
      const result = await reverseGenerate(
        model(
          [
            rpc("rpc", "NULL;"),
            "REVOKE EXECUTE ON FUNCTION public.rpc(uuid) FROM PUBLIC;",
            `GRANT EXECUTE ON FUNCTION public.rpc(uuid) TO ${anonymous};`,
          ].join("\n")
        ),
        options(files, facts(fact("rpc", { provider, grants: [anonymous] })))
      )
      expect(errorsOf(result)).toEqual([])
      expect(
        warning(result, "introspect.execute-narrowed").map((d) => d.params)
      ).toEqual([
        { function: "public.rpc", role: anonymous, reason: "anonymous" },
      ])
      const [entry] = declarationsOf(result, RPC_FUNCTIONS)
      expect(entry).toMatchObject({ callers: [] })
      expect(entry).not.toHaveProperty("check")
      // Дослівного гранту немає ніде: його відтворює генератор
      expect(
        [...result.files.keys()].filter((p) => p.includes("grant__"))
      ).toEqual([])
      const compiled = await compile(result.files)
      const execute = compiled
        .model!.sqlUnits.filter((u) => u.generator === "functionExecute")
        .map((u) => u.sql)
      expect(execute).toContain(
        `REVOKE EXECUTE ON FUNCTION public.rpc(uuid) FROM ${anonymous};`
      )
      expect(execute).toContain(
        "REVOKE EXECUTE ON FUNCTION public.rpc(uuid) FROM PUBLIC;"
      )
      expect(execute.filter((sql) => sql.startsWith("GRANT"))).toEqual([])
    }
  )

  // Типові привілеї провайдера дають `EXECUTE` у ACL без одиниці гранту:
  // звуження те саме, що з одиницею (попередній тест).
  // Мутація: порівнювати лише одиниці грантів
  it("EXECUTE of anon from default privileges, without a grant unit: the same introspect.execute-narrowed", async () => {
    const result = await reverseGenerate(
      model(
        `${guarded("rpc")}\nGRANT EXECUTE ON FUNCTION public.rpc(uuid) TO authenticated;`
      ),
      options(
        FOLDER(),
        facts(fact("rpc", { grants: ["authenticated", "anon"] }))
      )
    )
    expect(declarationsOf(result, RPC_FUNCTIONS)[0]!.callers).toEqual(["user"])
    expect(
      warning(result, "introspect.execute-narrowed").map((d) => d.params)
    ).toEqual([{ function: "public.rpc", role: "anon", reason: "anonymous" }])
  })

  it("only the user role: callers [user], the id is generated", async () => {
    const result = await reverseGenerate(
      model(guarded("rpc")),
      options(FOLDER(), facts(fact("rpc", { grants: ["authenticated"] })))
    )
    const [entry] = declarationsOf(result, RPC_FUNCTIONS)
    expect(entry).toMatchObject({
      function: { schema: "public", name: "rpc" },
      callers: ["user"],
    })
    expect(entry!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(codes(errorsOf(result))).toEqual([])
  })

  it("EXECUTE without USAGE on the schema does not make a caller", async () => {
    // Компілятор додав би `USAGE` разом з виведеним грантом і розширив доступ
    const result = await reverseGenerate(
      model(guarded("rpc")),
      options(
        FOLDER(),
        facts(
          fact("rpc", {
            grants: ["authenticated", "service_role"],
            noUsage: ["authenticated"],
          })
        )
      )
    )
    expect(declarationsOf(result, RPC_FUNCTIONS)[0]!.callers).toEqual([
      "service",
    ])
  })

  it("the grants of a declared function are not written, the compile has no generated-grant", async () => {
    const result = await reverseGenerate(
      model(
        [
          guarded("rpc"),
          "REVOKE EXECUTE ON FUNCTION public.rpc(uuid) FROM PUBLIC;",
          "GRANT EXECUTE ON FUNCTION public.rpc(uuid) TO authenticated;",
          "GRANT EXECUTE ON FUNCTION public.rpc(uuid) TO service_role;",
        ].join("\n")
      ),
      options(
        FOLDER(),
        facts(fact("rpc", { grants: ["authenticated", "service_role"] }))
      )
    )
    expect(
      [...result.files.keys()].filter((p) => p.includes("grant__"))
    ).toEqual([])
    expect(codes(result.diagnostics)).not.toContain("sql.generated-grant")
    expect(errorsOf(result)).toEqual([])
  })

  it("a grant of a function that is not declared stays verbatim", async () => {
    // Оболонка без `SET search_path`: декларації немає, гранти лишаються, а
    // компіляція називає недекларовану definer-функцію (клас ремонту)
    const open = rpc("rpc", "NULL;").replace(" SET search_path = ''", "")
    const result = await reverseGenerate(
      model(
        `${open}\nGRANT EXECUTE ON FUNCTION public.rpc(uuid) TO authenticated;`
      ),
      options(FOLDER(), facts(fact("rpc", { grants: ["authenticated"] })))
    )
    expect(
      [...result.files.keys()].filter((p) => p.endsWith(".functions.json"))
    ).toEqual([])
    expect([...result.files.keys()].some((p) => p.includes("grant__"))).toBe(
      true
    )
    expect(codes(errorsOf(result))).toEqual(["sql.definer-caller-unchecked"])
    expect(result.changes.length).toBeGreaterThan(0)
  })

  it("an overloaded definer function is not declared, its grants stay", async () => {
    const result = await reverseGenerate(
      model(
        [
          rpc("rpc", "NULL;"),
          rpc("rpc", "NULL;", "p_id uuid, p_other uuid"),
          "GRANT EXECUTE ON FUNCTION public.rpc(uuid) TO authenticated;",
        ].join("\n")
      ),
      options(
        FOLDER(),
        facts(
          fact("rpc", {
            grants: ["authenticated"],
            identityArguments: "p_id uuid",
          }),
          fact("rpc", { identityArguments: "p_id uuid, p_other uuid" })
        )
      )
    )
    expect(
      [...result.files.keys()].filter((p) => p.endsWith(".functions.json"))
    ).toEqual([])
    expect(codes(errorsOf(result))).toContain("sql.definer-caller-unchecked")
  })
})

describe("the check of a declaration", () => {
  const ROW_OK = (result: ReverseResult) =>
    declarationsOf(result, RPC_FUNCTIONS)[0]!

  it("a guard on a row gives check.row, the compile proves it", async () => {
    const result = await reverseGenerate(
      model(guarded("rpc")),
      options(FOLDER(), facts(fact("rpc", { grants: ["authenticated"] })))
    )
    expect(ROW_OK(result).check).toEqual({
      action: "read",
      object: { kind: "Document", name: "Task" },
      row: ROW,
    })
    expect(
      codes(result.diagnostics).filter((c) => c.startsWith("sql.declaration"))
    ).toEqual([])
    expect(warning(result, "introspect.definer-check-unknown")).toEqual([])
  })

  it("a scope guard gives check.scope", async () => {
    const result = await reverseGenerate(
      model(
        rpc(
          "rpc",
          `PERFORM simetra.rights_require_scope('create', 'task', ${ROW});`
        )
      ),
      options(FOLDER(), facts(fact("rpc", { grants: ["authenticated"] })))
    )
    expect(ROW_OK(result).check).toEqual({
      action: "create",
      object: { kind: "Document", name: "Task" },
      scope: ROW,
    })
    expect(
      codes(result.diagnostics).filter((c) => c.startsWith("sql.declaration"))
    ).toEqual([])
  })

  it("a body without a guard: no check, a warning, the compile asks for it", async () => {
    const result = await reverseGenerate(
      model(rpc("rpc", "NULL;")),
      options(FOLDER(), facts(fact("rpc", { grants: ["authenticated"] })))
    )
    expect(ROW_OK(result).check).toBeUndefined()
    expect(
      warning(result, "introspect.definer-check-unknown").map((d) => d.params)
    ).toEqual([
      {
        function: "public.rpc",
        reason: "no call guard of the proven form as the first statement",
      },
    ])
    expect(codes(errorsOf(result))).toEqual(["sql.declaration-check-missing"])
  })

  it("a kind label that is no object of the folder: no check, the reason names the label", async () => {
    const result = await reverseGenerate(
      model(guarded("rpc", `'read', 'ghost', ${ROW}`)),
      options(FOLDER(), facts(fact("rpc", { grants: ["authenticated"] })))
    )
    expect(ROW_OK(result).check).toBeUndefined()
    expect(
      warning(result, "introspect.definer-check-unknown").map(
        (d) => d.params?.reason
      )
    ).toEqual(["kind label ghost is not an object of the folder"])
  })

  it("an action that is no action of the object: no check", async () => {
    const result = await reverseGenerate(
      model(guarded("rpc", `'${ACTION_ID}', 'task', ${ROW}`)),
      options(FOLDER(), facts(fact("rpc", { grants: ["authenticated"] })))
    )
    expect(ROW_OK(result).check).toBeUndefined()
    expect(
      warning(result, "introspect.definer-check-unknown").map(
        (d) => d.params?.reason
      )
    ).toEqual([`action ${ACTION_ID} is not an action of Document Task`])
  })

  it("a check the contract refuses stays the named refusal, nothing is written", async () => {
    // `Task` має носіїв, тож `check` без цілі — `sql.declaration-check-form`
    // (поза класом ремонту): помилка названа, а не підмінена іншою
    const result = await reverseGenerate(
      model(guarded("rpc", `'read', 'task', NULL`)),
      options(FOLDER(), facts(fact("rpc", { grants: ["authenticated"] })))
    )
    expect(
      result.diagnostics
        .filter((d) => d.code === "sql.declaration-check-form")
        .map((d) => d.params?.reason)
    ).toEqual(["targetRequired"])
    expect(codes(errorsOf(result))).not.toContain("sql.platform-function-call")
    expect(result.changes).toEqual([])
  })

  it("another unit that calls the definer function does not cost it the check", async () => {
    // Мітки видів беруться з метаданих, а не з компіляції SQL теки
    const result = await reverseGenerate(
      model(
        [
          guarded("rpc"),
          "CREATE FUNCTION public.caller() RETURNS void LANGUAGE sql VOLATILE SET search_path = '' AS $$ SELECT public.rpc(gen_random_uuid()) $$;",
        ].join("\n")
      ),
      options(FOLDER(), facts(fact("rpc", { grants: ["authenticated"] })))
    )
    expect(ROW_OK(result).check).toMatchObject({ action: "read", row: ROW })
    expect(warning(result, "introspect.definer-check-unknown")).toEqual([])
  })

  it("only the owner with a guard in the body: a declaration without callers and with the check", async () => {
    const result = await reverseGenerate(
      model(
        `${guarded("rpc")}\nREVOKE EXECUTE ON FUNCTION public.rpc(uuid) FROM PUBLIC, authenticated, anon, service_role;`
      ),
      options(FOLDER(), facts(fact("rpc")))
    )
    expect(ROW_OK(result)).toMatchObject({
      callers: [],
      check: { action: "read", row: ROW },
    })
    // Компіляція дає рівно стан бази: жодного гранту, виняток Д2 діє
    expect(errorsOf(result)).toEqual([])
    expect(
      [...result.files.keys()].filter((p) => p.includes("grant__"))
    ).toEqual([])
  })

  it("an unresolved guard of a function without callers is named too", async () => {
    // Роль користувача не потрібна: запобіжник у тілі без `check` компіляція
    // відмовила б, тож причину називаємо завжди
    const result = await reverseGenerate(
      model(guarded("rpc", `'read', 'ghost', ${ROW}`)),
      options(FOLDER(), facts(fact("rpc")))
    )
    expect(
      warning(result, "introspect.definer-check-unknown").map((d) =>
        String(d.params?.reason)
      )
    ).toEqual(["kind label ghost is not an object of the folder"])
  })

  it.each([
    {
      name: "open shell",
      sql: guarded("rpc").replace(" SET search_path = ''", ""),
      reason: /the shell is not closed/,
    },
    {
      name: "a procedure",
      sql: "CREATE PROCEDURE public.rpc(p_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN PERFORM simetra.rights_require('read', 'task', p_id); END $$;",
      reason: /a procedure cannot be declared/,
    },
    {
      name: "an overload",
      sql: `${guarded("rpc")}\n${rpc("rpc", "NULL;", "p_id uuid, p_x uuid")}`,
      reason: /overloaded/,
    },
  ])(
    "a guard in a function that cannot be declared ($name) is refused with the reason",
    async (c) => {
      const result = await reverseGenerate(
        model(c.sql),
        options(
          FOLDER(),
          facts(
            fact("rpc", {
              grants: ["authenticated"],
              identityArguments: "p_id uuid",
            }),
            ...(c.name === "an overload"
              ? [fact("rpc", { identityArguments: "p_id uuid, p_x uuid" })]
              : [])
          )
        )
      )
      expect(
        warning(result, "introspect.definer-check-unknown").map((d) =>
          String(d.params?.reason)
        )
      ).toEqual([expect.stringMatching(c.reason)])
      expect(codes(errorsOf(result))).toContain("sql.platform-function-call")
    }
  )

  it("a service-only function needs no check and no warning", async () => {
    const result = await reverseGenerate(
      model(rpc("rpc", "NULL;")),
      options(FOLDER(), facts(fact("rpc", { grants: ["service_role"] })))
    )
    expect(ROW_OK(result).callers).toEqual(["service"])
    expect(warning(result, "introspect.definer-check-unknown")).toEqual([])
    expect(errorsOf(result)).toEqual([])
  })

  it("no arguments and SETOF uuid: a platform form candidate", async () => {
    const result = await reverseGenerate(
      model(
        `CREATE FUNCTION public.org_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' ${pinnedSettingsClause()} AS $$ SELECT gen_random_uuid() $$;`
      ),
      options(FOLDER(), facts(fact("org_ids", { grants: ["authenticated"] })))
    )
    expect(
      warning(result, "introspect.definer-platform-form-candidate").map(
        (d) => d.params
      )
    ).toEqual([{ function: "public.org_ids" }])
  })
})

describe("the ACL of a definer function", () => {
  const cases: {
    name: string
    fact: FactOptions
    role: string
    reason: RegExp
  }[] = [
    {
      name: "a role of the application",
      fact: { grants: ["app_reader"] },
      role: "app_reader",
      reason: /not a role of the provider profile/,
    },
    {
      name: "the signal consumer role",
      fact: { grants: [PLATFORM_ROLES.signalConsumer] },
      role: PLATFORM_ROLES.signalConsumer,
      reason: /not a role of the provider profile/,
    },
    {
      name: "a grant option of a profile role",
      fact: { grants: ["authenticated"], grantable: true },
      role: "authenticated",
      reason: /grant option/,
    },
    {
      name: "another grantor",
      fact: { grants: ["authenticated"], grantor: "somebody" },
      role: "authenticated",
      reason: /granted by somebody/,
    },
  ]
  it.each(cases)(
    "$name is an error, nothing is written, declared or not",
    async (c) => {
      for (const sql of [
        guarded("rpc"),
        // Поза закритою оболонкою декларації немає, але грант не мовчить (Р9)
        rpc("rpc", "NULL;").replace(" SET search_path = ''", ""),
      ]) {
        const result = await reverseGenerate(
          model(sql),
          options(FOLDER(), facts(fact("rpc", c.fact)))
        )
        const found = result.diagnostics.filter(
          (d) => d.code === "introspect.definer-foreign-grant"
        )
        expect(found.map((d) => d.params?.role)).toEqual([c.role])
        expect(String(found[0]!.params?.reason)).toMatch(c.reason)
        expect(result.changes).toEqual([])
      }
    }
  )
})

describe("platform forms of the kept folder", () => {
  it("the set function of a scope kind is not declared and needs no fact", async () => {
    // Її `EXECUTE` виводять метадані: декларація на неї — `sql.declaration-platform-form`
    const result = await reverseGenerate(
      model(
        `CREATE FUNCTION public.team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' ${pinnedSettingsClause()} AS $$ SELECT gen_random_uuid() $$;`
      ),
      options(withRoles(teamScopeKind()), undefined)
    )
    expect(
      [...result.files.keys()].filter((p) => p.endsWith(".functions.json"))
    ).toEqual([])
    expect(
      codes(result.diagnostics).filter(
        (c) =>
          c.startsWith("sql.declaration") || c.startsWith("introspect.definer")
      )
    ).toEqual([])
  })

  // `EXECUTE` виводить платформа й для invoker-функції (декларація збереженої
  // теки, функція модуля виду): план відкличе типовий `PUBLIC` поза її
  // призначеннями, і правило те саме. Функція значень виміру invoker бути не
  // може (`rights.dimension-function-signature`), тож тут — декларація.
  // Мутація: відсіювати не-definer функції раніше за функції з виведеним `EXECUTE`
  it("an invoker function with a kept declaration and the default PUBLIC: introspect.execute-narrowed", async () => {
    const invoker =
      "CREATE FUNCTION public.rpc(p_id uuid) RETURNS void LANGUAGE plpgsql STABLE SET search_path = '' AS $$ BEGIN NULL; END $$;"
    const existing = withRoles()
    existing.set("sql/public/rpc.sql", `${invoker}\n`)
    existing.set(
      "sql/public/rpc.functions.json",
      JSON.stringify({
        functions: [
          { id: uuid(700_900), function: { name: "rpc" }, callers: ["user"] },
        ],
      })
    )
    const result = await reverseGenerate(
      model(invoker),
      options(existing, facts(fact("rpc", { grants: ["PUBLIC"] })))
    )
    expect(
      warning(result, "introspect.execute-narrowed").map((d) => d.params)
    ).toEqual(
      ["anon", "service_role", PLATFORM_ROLES.command].map((role) => ({
        function: "public.rpc",
        role,
        reason: role === "anon" ? "anonymous" : "outside-assignments",
      }))
    )
  })

  // Чужий грант на форму не губиться з пропуском декларації.
  // Мутація: форма метаданих обходить перевірку чужих грантів
  it("a grant on the set function to a role outside the profile is introspect.definer-foreign-grant", async () => {
    const result = await reverseGenerate(
      model(
        `CREATE FUNCTION public.team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' ${pinnedSettingsClause()} AS $$ SELECT gen_random_uuid() $$;`
      ),
      options(
        withRoles(teamScopeKind()),
        facts(fact("team_ids", { grants: ["app_reader"] }))
      )
    )
    expect(
      result.diagnostics
        .filter((d) => d.code === "introspect.definer-foreign-grant")
        .map((d) => d.params?.role)
    ).toEqual(["app_reader"])
  })

  // Форма метаданих фактів не вимагає, але за наявним фактом звуження
  // називає те саме правило: `anon` поза призначеннями функції множини.
  // Мутація: форма метаданих пропускається до звірки з фактом
  it("the live EXECUTE of the set function beyond its assignments: introspect.execute-narrowed", async () => {
    const result = await reverseGenerate(
      model(
        `CREATE FUNCTION public.team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' ${pinnedSettingsClause()} AS $$ SELECT gen_random_uuid() $$;`
      ),
      options(
        withRoles(teamScopeKind()),
        facts(fact("team_ids", { grants: ["PUBLIC"] }))
      )
    )
    expect(
      warning(result, "introspect.execute-narrowed").map((d) => d.params)
    ).toEqual([
      { function: "public.team_ids", role: "anon", reason: "anonymous" },
    ])
  })

  const scopeGrants = [
    {
      name: "a grant to a role of the application",
      sql: "GRANT EXECUTE ON FUNCTION public.team_ids() TO app_reader;",
    },
    {
      name: "a grant with the grant option",
      sql: "GRANT EXECUTE ON FUNCTION public.team_ids() TO authenticated WITH GRANT OPTION;",
    },
  ]
  it.each(scopeGrants)(
    "$name on the set function is only generated-grant, nothing is written",
    async (c) => {
      const result = await reverseGenerate(
        model(
          `CREATE FUNCTION public.team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' ${pinnedSettingsClause()} AS $$ SELECT gen_random_uuid() $$;\n` +
            c.sql
        ),
        options(withRoles(teamScopeKind()), undefined)
      )
      expect(
        codes(result.diagnostics).filter(
          (code) =>
            code.startsWith("sql.generated-grant") ||
            code.startsWith("introspect.definer")
        )
      ).toEqual(["sql.generated-grant"])
      expect(result.changes).toEqual([])
    }
  )
})

describe("a subscription handler whose name holds a dot", () => {
  it('does not hide the definer function a."b.c" behind the handler "a.b".c', async () => {
    // `a.b.c` у неоднозначному об'єднанні через крапку ділився б на `a` і `b.c`
    const touch =
      "CREATE FUNCTION \"a.b\".c() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN RETURN NEW; END $$;"
    const existing = withRoles()
    for (const [path, text] of metaFiles({
      "catalogs/Currency/Currency.meta.json": catalog("Currency", {
        scope: "none",
      }),
      "event-subscriptions/Touch/Touch.meta.json": {
        id: uuid(990_001),
        kind: "EventSubscription",
        name: "Touch",
        physicalName: "touch",
        sources: [{ kind: "Catalog", name: "Currency" }],
        event: "beforeWrite",
        handler: { schema: "a.b", name: "c" },
      },
    }))
      existing.set(path, text)
    existing.set("sql/a.b/c.sql", `${touch}\n`)
    const compiled = await compile(existing)
    expect(compiled.diagnostics).toEqual([])
    const result = await reverseGenerate(
      {
        tables: catalogFromSnapshot(compiled.model!.physical).tables,
        enumTypes: [],
        units: units(
          `${touch}\n${guarded("rpc").replace("public.rpc(", 'a."b.c"(')}`
        ),
      },
      options(
        existing,
        facts(fact("b.c", { schema: "a", identityArguments: "p_id uuid" }))
      )
    )
    expect(errorsOf(result)).toEqual([])
    expect(
      [...result.files.keys()].filter((p) => p.endsWith(".functions.json"))
    ).toHaveLength(1)
  })
})

describe("names that differ only in where the dot sits", () => {
  const dotted = (qualified: string) =>
    guarded("rpc").replace("public.rpc(", `${qualified}(`)

  it("a foreign grant on the second of colliding names is an error", async () => {
    const sql = [
      dotted('"public.rpc".x'),
      dotted('public."rpc.x"'),
      'GRANT EXECUTE ON FUNCTION public."rpc.x"(uuid) TO app_reader;',
      'GRANT EXECUTE ON FUNCTION public."rpc.x"(uuid) TO authenticated;',
    ].join("\n")
    const result = await reverseGenerate(
      model(sql),
      options(
        FOLDER(),
        facts(
          fact("x", { schema: "public.rpc", identityArguments: "p_id uuid" }),
          fact("rpc.x", {
            identityArguments: "p_id uuid",
            grants: ["app_reader", "authenticated"],
          })
        )
      )
    )
    expect(
      result.diagnostics
        .filter((d) => d.code === "introspect.definer-foreign-grant")
        .map((d) => d.params?.role)
    ).toEqual(["app_reader"])
    expect(result.changes).toEqual([])
  })
})

describe("an overloaded definer function", () => {
  const both = [
    rpc("rpc", "NULL;"),
    rpc("rpc", "NULL;", "p_id uuid, p_other uuid"),
  ].join("\n")
  const first = { identityArguments: "p_id uuid" }
  const second = { identityArguments: "p_id uuid, p_other uuid" }

  it("a foreign grant on one overload is an error", async () => {
    const result = await reverseGenerate(
      model(both),
      options(
        FOLDER(),
        facts(
          fact("rpc", first),
          fact("rpc", { ...second, grants: ["app_reader"] })
        )
      )
    )
    expect(
      result.diagnostics
        .filter((d) => d.code === "introspect.definer-foreign-grant")
        .map((d) => [d.params?.function, d.params?.role])
    ).toEqual([["public.rpc(p_id uuid, p_other uuid)", "app_reader"]])
    expect(result.changes).toEqual([])
  })

  it("an overload without its fact is an error", async () => {
    const result = await reverseGenerate(
      model(both),
      options(FOLDER(), facts(fact("rpc", first)))
    )
    expect(
      result.diagnostics
        .filter((d) => d.code === "introspect.definer-acl-changed")
        .map((d) => d.params)
    ).toEqual([{ check: "fact", function: "public.rpc" }])
    expect(result.changes).toEqual([])
  })
})

describe("facts are required for a definer function", () => {
  it("no facts at all: an error, never 'no callers'", async () => {
    const result = await reverseGenerate(
      model(guarded("rpc")),
      options(FOLDER(), undefined)
    )
    expect(
      result.diagnostics
        .filter((d) => d.code === "introspect.definer-acl-changed")
        .map((d) => d.params)
    ).toEqual([{ check: "fact", function: "public.rpc" }])
    expect(result.changes).toEqual([])
  })

  it("facts of another function: an error", async () => {
    const result = await reverseGenerate(
      model(guarded("rpc")),
      options(FOLDER(), facts(fact("other", { grants: ["authenticated"] })))
    )
    expect(codes(errorsOf(result))).toContain("introspect.definer-acl-changed")
    expect(result.changes).toEqual([])
  })

  it("a function that is not definer needs no fact", async () => {
    const result = await reverseGenerate(
      model(
        "CREATE FUNCTION public.plain() RETURNS int LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT 1 $$;"
      ),
      options(FOLDER(), undefined)
    )
    expect(errorsOf(result)).toEqual([])
  })
})

describe("repeated adoption", () => {
  it("keeps the id of the function, the callers come from the new ACL", async () => {
    const first = await reverseGenerate(
      model(guarded("rpc")),
      options(
        FOLDER(),
        facts(fact("rpc", { grants: ["authenticated", "service_role"] }))
      )
    )
    const [before] = declarationsOf(first, RPC_FUNCTIONS)
    expect(before!.callers).toEqual(["user", "service"])
    const second = await reverseGenerate(
      model(guarded("rpc")),
      // Інший початок лічильника: збіг `id` не може бути випадковим
      options(
        first.files,
        facts(fact("rpc", { grants: ["authenticated"] })),
        800_000
      )
    )
    const [after] = declarationsOf(second, RPC_FUNCTIONS)
    expect(after!.id).toBe(before!.id)
    expect(after!.callers).toEqual(["user"])
    expect(errorsOf(second)).toEqual([])
  })

  it("a function that lost every caller loses its declaration file", async () => {
    const first = await reverseGenerate(
      model(rpc("rpc", "NULL;")),
      options(FOLDER(), facts(fact("rpc", { grants: ["service_role"] })))
    )
    const second = await reverseGenerate(
      model(rpc("rpc", "NULL;")),
      options(first.files, facts(fact("rpc")))
    )
    expect(second.files.has(RPC_FUNCTIONS)).toBe(false)
    expect(
      second.changes.map((c) => [c.path, c.content === null])
    ).toContainEqual([RPC_FUNCTIONS, true])
  })

  describe("a declaration of a kept file", () => {
    const KEPT_SQL = "catalogs/Item/Item.sql"
    const KEPT_FUNCTIONS = "catalogs/Item/Item.functions.json"
    const kept = (callers: string[]) => {
      const files = metaFiles({
        "project.meta.json": project({
          name: "Kept",
          defaultSchema: "public",
          naming: { attributeCase: "snake_case" },
        }),
        "catalogs/Item/Item.meta.json": {
          id: uuid(1),
          kind: "Catalog",
          name: "Item",
          physicalName: "item",
          kindLabel: "item",
          schema: "public",
          scope: "none",
          attributes: [],
        },
      })
      files.set(
        KEPT_SQL,
        "CREATE FUNCTION public.item_rpc() RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;\n"
      )
      files.set(
        KEPT_FUNCTIONS,
        JSON.stringify({
          functions: [{ id: uuid(2), function: { name: "item_rpc" }, callers }],
        })
      )
      return files
    }
    const run = (callers: string[], granted: string[]) =>
      reverseGenerate(
        model(
          "CREATE FUNCTION public.item_rpc() RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;"
        ),
        options(kept(callers), facts(fact("item_rpc", { grants: granted })))
      )

    it("callers equal to the database: no drift, the file is not rewritten", async () => {
      const result = await run(["service"], ["service_role"])
      expect(codes(errorsOf(result))).not.toContain(
        "introspect.definer-callers-drift"
      )
      expect(result.files.get(KEPT_FUNCTIONS)).toBe(
        kept(["service"]).get(KEPT_FUNCTIONS)
      )
    })

    it("a role without a session in the database of a kept declaration: a warning, no drift", async () => {
      const result = await run(["service"], ["service_role", "anon"])
      expect(
        result.diagnostics
          .filter((d) => d.code === "introspect.execute-narrowed")
          .map((d) => d.params)
      ).toEqual([
        { function: "public.item_rpc", role: "anon", reason: "anonymous" },
      ])
      expect(codes(errorsOf(result))).not.toContain(
        "introspect.definer-callers-drift"
      )
    })

    it("callers wider than the database: introspect.definer-callers-drift", async () => {
      // Відкликане в базі право не повертає застосування збереженої декларації
      const result = await run(["service", "user"], ["service_role"])
      expect(
        result.diagnostics
          .filter((d) => d.code === "introspect.definer-callers-drift")
          .map((d) => [d.file, d.params])
      ).toEqual([
        [
          KEPT_FUNCTIONS,
          {
            function: "public.item_rpc",
            declared: "service, user",
            actual: "service",
          },
        ],
      ])
      expect(result.changes).toEqual([])
    })
  })
})

describe("policy functions of debt (Р9, І6)", () => {
  // Таблиці фікстури функції політики — з фізичного знімка її теки; тека
  // зворотної генерації — прийом з нуля: лише проєкт
  const FOLDER_OF_POLICY = () =>
    policyFiles(POLICY_FUNCTION() + READ_POLICY() + DOCS_GRANT(), POLICY_DEBT())
  const policyTables = async () => {
    const physical = await compile(FOLDER_OF_POLICY())
    expect(physical.model, "the fixture folder compiles").toBeDefined()
    return catalogFromSnapshot(physical.model!.physical).tables
  }
  const policyProject = () =>
    new Map([
      ["project.meta.json", FOLDER_OF_POLICY().get("project.meta.json")!],
    ])
  const adopt = async (
    sql: string,
    executes: FactOptions,
    kept: Record<string, string> = {},
    others: readonly string[] = []
  ) => {
    const existing = new Map([...policyProject(), ...Object.entries(kept)])
    return reverseGenerate(
      {
        tables: await policyTables(),
        enumTypes: [],
        units: units(sql),
      },
      options(
        existing,
        facts(fact("f", executes), ...others.map((n) => fact(n, executes)))
      )
    )
  }
  const EXECUTE = [
    "REVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC;",
    "GRANT EXECUTE ON FUNCTION public.f() TO authenticated;",
  ].join("\n")
  const functionGrants = (files: ReadonlyMap<string, string>) =>
    [...files.values()].filter((text) =>
      text.includes("ON FUNCTION public.f()")
    )
  const functionFiles = (files: ReadonlyMap<string, string>) =>
    [...files.keys()].filter((p) => p.endsWith(".functions.json"))

  // Мутація: писати декларацію кожній definer-функції (без пропуску функції
  // політики) — декларація на форму платформи, `sql.declaration-platform-form`
  it("a policy function gets no declaration and no verbatim grant; the compile recognizes it the same", async () => {
    const result = await adopt(
      POLICY_FUNCTION() + READ_POLICY() + DOCS_GRANT() + EXECUTE,
      { grants: ["authenticated"] }
    )
    expect(errorsOf(result)).toEqual([])
    expect(codes(result.diagnostics)).not.toContain(
      "sql.definer-caller-unchecked"
    )
    expect(functionFiles(result.files)).toEqual([])
    expect(functionGrants(result.files)).toEqual([])
    // Тека виходу, скомпільована, визнає ту саму функцію функцією політики,
    // а живий `EXECUTE` ролі викликача відтворює генератор
    const policies = await formPolicies(result.files)
    expect(
      policies.functions.map((p) => `${p.function.schema}.${p.function.name}`)
    ).toEqual(["public.f"])
    const compiled = await compile(result.files)
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual(
      []
    )
    expect(
      compiled
        .model!.sqlUnits.filter(
          (u) => u.generator === "functionExecute" && u.sql.startsWith("GRANT")
        )
        .map((u) => u.sql)
    ).toEqual(["GRANT EXECUTE ON FUNCTION public.f() TO authenticated;"])
  })

  // Перелік боргу підсумкова тека пише заново, а зламаний збережений закрив би
  // стадію 3 чернетки й з нею розпізнавання: функцію задекларувало б, а
  // компіляція виходу визнала б її формою платформи.
  // Мутація: розпізнавати на чернетці зі збереженим переліком боргу
  it("a broken kept debt list does not hide the policy function", async () => {
    const result = await adopt(
      POLICY_FUNCTION() + READ_POLICY() + DOCS_GRANT() + EXECUTE,
      { grants: ["authenticated"] },
      { "sql-debt.json": "{ broken" }
    )
    expect(functionFiles(result.files)).toEqual([])
    expect(errorsOf(result)).toEqual([])
  })

  it("a function outside the form gets a declaration, the compile names sql.policy-helper-correlated", async () => {
    const volatile = POLICY_FUNCTION({
      shell: POLICY_SHELL.replace("STABLE", "VOLATILE"),
    })
    const result = await adopt(
      volatile + READ_POLICY() + DOCS_GRANT() + EXECUTE,
      {
        grants: ["authenticated"],
      }
    )
    expect(functionFiles(result.files)).toHaveLength(1)
    // Декларація — як у будь-якої definer-функції: без запобіжника в тілі
    // `check` немає, і компіляція просить його поруч із причиною форми
    expect(codes(errorsOf(result))).toEqual([
      "sql.declaration-check-missing",
      "sql.policy-helper-correlated",
    ])
    expect((await formPolicies(result.files)).functions).toEqual([])
  })

  // Генератор відкликає `EXECUTE` у ролі поза призначеннями; дослівний грант
  // їй — не похідний, тож лишається й називає себе, а не зникає мовчки.
  // Грант без названого отримувача роль профілю не доводить: він лишається й
  // називає себе, а не зникає мовчки.
  // Мутації: прибирати кожен грант функції політики; рахувати роллю профілю
  // грант, де частина отримувачів не названа
  it.each(["CURRENT_USER", "authenticated, CURRENT_USER"])(
    "a grant to %s stays verbatim: sql.generated-grant",
    async (role) => {
      const result = await adopt(
        POLICY_FUNCTION() +
          READ_POLICY() +
          DOCS_GRANT() +
          EXECUTE +
          `\nGRANT EXECUTE ON FUNCTION public.f() TO ${role};`,
        { grants: ["authenticated"] }
      )
      expect(functionFiles(result.files)).toEqual([])
      expect(functionGrants(result.files)).toEqual([
        expect.stringContaining(
          `GRANT EXECUTE ON FUNCTION public.f() TO ${role};`
        ),
      ])
      expect(
        functionGrants(result.files)[0]!.includes("TO authenticated;")
      ).toBe(false)
      expect(codes(errorsOf(result))).toEqual(["sql.generated-grant"])
      expect(result.changes).toEqual([])
    }
  )

  // Одне правило звуження (рішення архітекторки): роль профілю з дієвим
  // `EXECUTE`, якої виведені призначення не дають, — `introspect.execute-narrowed`,
  // хоч би як extract надрукував її право: одиницею гранту, типовими
  // привілеями провайдера (ACL без одиниці) чи типовим `PUBLIC`.
  // Мутація: порівнювати лише одиниці грантів, а не дієвий ACL фактів
  const narrowedOf = (result: ReverseResult) =>
    warning(result, "introspect.execute-narrowed").map((d) => d.params)
  const ALL_OUTSIDE = [
    { function: "public.f", role: "anon", reason: "anonymous" },
    // `service_role` не читає T (немає `SELECT`), тож призначень не має
    {
      function: "public.f",
      role: "service_role",
      reason: "outside-assignments",
    },
    {
      function: "public.f",
      role: PLATFORM_ROLES.command,
      reason: "outside-assignments",
    },
  ]
  it.each([
    {
      path: "a grant unit to anon",
      sql: `${EXECUTE}\nGRANT EXECUTE ON FUNCTION public.f() TO anon;`,
      grants: ["authenticated", "anon"],
      narrowed: [ALL_OUTSIDE[0]],
    },
    {
      path: "default privileges of anon (an ACL entry without a unit)",
      sql: EXECUTE,
      grants: ["authenticated", "anon"],
      narrowed: [ALL_OUTSIDE[0]],
    },
    {
      path: "a grant unit to PUBLIC",
      sql: `${EXECUTE}\nGRANT EXECUTE ON FUNCTION public.f() TO PUBLIC;`,
      grants: ["PUBLIC"],
      narrowed: ALL_OUTSIDE,
    },
    {
      path: "the default PUBLIC (no unit at all)",
      sql: "",
      grants: ["PUBLIC"],
      narrowed: ALL_OUTSIDE,
    },
  ])(
    "$path on a policy function: the grant is dropped, introspect.execute-narrowed",
    async (c) => {
      const result = await adopt(
        POLICY_FUNCTION() + READ_POLICY() + DOCS_GRANT() + c.sql,
        { grants: c.grants }
      )
      expect(errorsOf(result)).toEqual([])
      expect(functionFiles(result.files)).toEqual([])
      expect(functionGrants(result.files)).toEqual([])
      expect(narrowedOf(result)).toEqual(c.narrowed)
    }
  )

  // Роль без `USAGE` на схему функцію й так не кличе: відкликання її
  // `EXECUTE` дієвого доступу не звужує (рішення архітекторки: судимо дієвий ACL).
  // Мутація: прибрати умову `USAGE` у `narrowedRoles`
  it("a role with EXECUTE but without USAGE on the schema is not narrowed", async () => {
    const result = await adopt(
      POLICY_FUNCTION() + READ_POLICY() + DOCS_GRANT() + EXECUTE,
      { grants: ["authenticated", "anon"], noUsage: ["anon"] }
    )
    expect(narrowedOf(result)).toEqual([])
  })

  // Звуження судить факт саме цієї функції: перевантаження `f(uuid)` має
  // власний ACL, і його ролі не названі від імені функції політики `f()`, а
  // спільні ролі — по разу.
  // Мутація: звужувати за кожним фактом імені
  it("an overload beside the policy function: only the facts of f() narrow, once", async () => {
    const result = await reverseGenerate(
      {
        tables: await policyTables(),
        enumTypes: [],
        units: units(
          POLICY_FUNCTION() +
            READ_POLICY() +
            DOCS_GRANT() +
            "CREATE FUNCTION public.f(p uuid) RETURNS void LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT $$;"
        ),
      },
      options(
        policyProject(),
        facts(
          fact("f", { grants: ["PUBLIC"] }),
          fact("f", { grants: ["PUBLIC"], identityArguments: "p uuid" })
        )
      )
    )
    expect(narrowedOf(result)).toEqual(ALL_OUTSIDE)
  })

  it("only the derived role executes: nothing is narrowed", async () => {
    const result = await adopt(
      POLICY_FUNCTION() + READ_POLICY() + DOCS_GRANT() + EXECUTE,
      { grants: ["authenticated"] }
    )
    expect(narrowedOf(result)).toEqual([])
  })

  // Розпізнавання коштує стадію SQL чернетки: лише коли тека має і
  // definer-функцію, і політику, і раз на прийом.
  // Мутації: рахувати щоразу (без `policyFunctions` за потребою); рахувати
  // без політики; рахувати на кожну definer-функцію
  describe("the recognition runs only when it can find something", () => {
    beforeEach(() => {
      policyRuns.count = 0
    })
    it("no policy unit: no run", async () => {
      await reverseGenerate(
        model(guarded("rpc")),
        options(FOLDER(), facts(fact("rpc", { grants: ["authenticated"] })))
      )
      expect(policyRuns.count).toBe(0)
    })
    it("a policy but no definer function: no run", async () => {
      await adopt(READ_POLICY() + DOCS_GRANT(), {})
      expect(policyRuns.count).toBe(0)
    })
    it("two definer functions beside a policy: one run", async () => {
      await adopt(
        POLICY_FUNCTION() +
          POLICY_FUNCTION({ name: "g" }) +
          READ_POLICY() +
          DOCS_GRANT(),
        { grants: ["authenticated"] },
        {},
        ["g"]
      )
      expect(policyRuns.count).toBe(1)
    })
  })

  // Мутація: пропускати функцію політики до перевірки чужих ACL — грант ролі
  // застосунку мовчки губиться разом із пропуском
  it("a grant to a role outside the profile is introspect.definer-foreign-grant", async () => {
    const result = await adopt(
      POLICY_FUNCTION() +
        READ_POLICY() +
        DOCS_GRANT() +
        EXECUTE +
        "\nGRANT EXECUTE ON FUNCTION public.f() TO app_reader;",
      { grants: ["authenticated", "app_reader"] }
    )
    expect(
      result.diagnostics
        .filter((d) => d.code === "introspect.definer-foreign-grant")
        .map((d) => d.params?.role)
    ).toEqual(["app_reader"])
    expect(functionFiles(result.files)).toEqual([])
    expect(result.changes).toEqual([])
  })
})
