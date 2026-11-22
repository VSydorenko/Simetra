import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  PROVIDER_OWNER_ROLES,
  type DatabaseProvider,
} from "simetra/model"
import {
  canonicalSnapshot,
  compile,
  type CompiledModel,
} from "simetra/compiler"
import {
  buildPlan,
  compareWithDesired,
  desiredForApply,
  executePlan,
  folderReference,
  reverseGenerate,
  type DbConnection,
  type ExecuteFacts,
  type ReverseResult,
} from "simetra/schema"
import { createApplyDatabase } from ".."
import { extractWithExecuteFacts } from "../pg-delta/adapter"
import { withRoles } from "../../../../simetra/src/compiler/__tests__/fixtures/rights"
import {
  DOCS_GRANT,
  POLICY_FUNCTION,
  READ_POLICY,
} from "../../../../simetra/src/compiler/__tests__/fixtures/policy-function"
import {
  superuserClient,
  testProvider,
  testRoleFor,
  testRoleName,
  testSuperuserUrl,
} from "../../../../simetra/test/support"
import { dropRoles, query } from "../../__tests__/support/db"
import {
  call,
  ENV,
  errors as toolErrors,
  freshProject,
  inTarget as appTarget,
  introspectInput,
  options as toolOptions,
  useDatabaseToolsCleanup,
} from "../../__tests__/database-tools.support"
import {
  engine,
  errors,
  inTarget,
  parser,
  schemaPath,
  useRoundTrip,
} from "./round-trip.support"

/**
 * Прийом definer-функцій наскрізь на живому каталозі (спека декларацій функцій
 * §3 рядок Д3, §5.5; план Д3, інваріанти Б1, Б2, Б7): ціль — бажаний стан теки
 * прав плюс функція, створена окремим SQL; факти `EXECUTE` і extract — одним
 * знімком, як в `introspect`; далі зворотна генерація над наявною текою,
 * компіляція, звірка з тінню й застосування. Спільне для файлів обох профілів:
 * ролі профілю різні, а вимоги однакові.
 */

const reader = createApplyDatabase({ readOnly: true })
const writer = createApplyDatabase({ readOnly: false })

const API = PROVIDER_API_ROLES[testProvider()]
const OWNERS_ROLE = (p: DatabaseProvider): string[] =>
  [...Object.values(PROVIDER_API_ROLES[p]), PLATFORM_ROLES.command].filter(
    (r): r is string => typeof r === "string"
  )

/** Ролі профілю прогону, що мають сесію чи значення (без `null`). */
const profileRoles = (): string[] => OWNERS_ROLE(testProvider())

const RPC = "public.rpc(uuid)"
const GUARD = "PERFORM simetra.rights_require('read', 'task', p_id);"
const SCOPE_GUARD =
  "PERFORM simetra.rights_require_scope('create', 'task', p_id);"

/** definer-RPC у закритій оболонці з вмістом `body`. */
const rpc = (body: string, shell = "SET search_path = ''"): string =>
  `CREATE FUNCTION public.rpc(p_id uuid) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER ${shell} AS $$ BEGIN ${body} END $$;`

/** Лише власник: `PUBLIC` і ролі профілю (типові привілеї провайдера) відкликано. */
const ONLY_OWNER = [
  `REVOKE EXECUTE ON FUNCTION ${RPC} FROM PUBLIC;`,
  ...profileRoles().map(
    (r) => `REVOKE EXECUTE ON FUNCTION ${RPC} FROM "${r}";`
  ),
].join("\n")

const grantTo = (...roles: string[]): string =>
  roles.map((r) => `GRANT EXECUTE ON FUNCTION ${RPC} TO "${r}";`).join("\n")

const task = { kind: "Document", name: "Task" }

/** Тека прав із видом `task`; профіль — прогону. */
function folder(o: { appSchema?: boolean } = {}): Map<string, string> {
  const files = withRoles()
  if (o.appSchema === true)
    // Схема `app` входить у межу моделі через звичайну (не definer) функцію:
    // грантів на об'єкти в ній немає, тож `USAGE` ролям платформа не дає, а
    // `PUBLIC` у новій схемі `USAGE` не має (на відміну від `public`)
    files.set(
      "sql/app/helper.sql",
      "CREATE FUNCTION app.helper() RETURNS int LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT 1 $$;\n"
    )
  files.set(
    "project.meta.json",
    JSON.stringify({
      ...JSON.parse(files.get("project.meta.json")!),
      database: { provider: testProvider() },
    })
  )
  // Функції запобіжника компілятор породжує з перевірок, які теки вже
  // оголошено: база з двома відомими функціями має їх у тому вигляді, який
  // дасть і тека прийому, тож порожня звірка не залежить від першого
  // застосування установки запобіжника
  const known = (name: string, guard: string, check: object, id: string) => {
    files.set(
      `sql/public/${name}.sql`,
      `${rpc(guard).replace("public.rpc", `public.${name}`)}\n`
    )
    files.set(
      `sql/public/${name}.functions.json`,
      JSON.stringify({
        functions: [{ id, function: { name }, callers: [], check }],
      })
    )
  }
  known(
    "known_row",
    GUARD,
    { action: "read", object: task, row: "p_id" },
    "7a000000-0000-4000-8000-000000000001"
  )
  known(
    "known_scope",
    SCOPE_GUARD,
    { action: "create", object: task, scope: "p_id" },
    "7a000000-0000-4000-8000-000000000002"
  )
  return files
}

interface Ctx {
  target: DbConnection
  existing: Map<string, string>
  model: CompiledModel
}

/**
 * Ціль: застосований бажаний стан теки й `sql` поверх нього (власником). Тека
 * `existing` — те, що користувач уже має до прийому функції.
 */
async function inAdoptedTarget(
  sql: string,
  fn: (ctx: Ctx) => Promise<void>,
  existing: Map<string, string> = folder()
): Promise<void> {
  const compiled = await compile(existing)
  expect(errors(compiled.diagnostics)).toEqual([])
  const model = compiled.model!
  const desired = await desiredForApply(model)
  await inTarget(desired.sql, desired.scope, async (target) => {
    await query(target.url, sql)
    await fn({ target, existing, model })
  })
}

const projectOf = (model: CompiledModel) => ({
  name: model.project.name,
  defaultSchema: model.project.defaultSchema,
  attributeCase: model.project.naming.attributeCase,
  databaseProvider: model.project.database.provider,
})

/**
 * `introspect` над цілею без запису на диск: той самий знімок extract і фактів,
 * еталон теки, зворотна генерація. Межа — межа моделі теки.
 */
async function adopt(
  { target, model }: Ctx,
  existing: ReadonlyMap<string, string>
): Promise<ReverseResult & { facts: ExecuteFacts }> {
  // Межа `introspect` — схеми застосунку: схему платформи він не читає
  const full = await desiredForApply(model)
  const scope = {
    ...full.scope,
    schemas: full.scope.schemas.filter((s) => s !== "simetra"),
  }
  const read = await extractWithExecuteFacts(target, scope)
  const reference = await folderReference(engine, reader, { target }, existing)
  expect(errors(reference.diagnostics)).toEqual([])
  expect(errors(read.extracted.diagnostics)).toEqual([])
  const reversed = await reverseGenerate(read.extracted.model, {
    project: projectOf(model),
    existing,
    newId: () => randomUUID(),
    schemaPath,
    parse: parser(),
    executeFacts: read.facts,
    ...(reference.catalog === undefined
      ? {}
      : { reference: reference.catalog }),
  })
  return { ...reversed, facts: read.facts }
}

/** Компіляція теки прийому: помилки й модель. */
async function compiledFolder(files: ReadonlyMap<string, string>) {
  const compiled = await compile(new Map(files))
  return {
    errors: errors(compiled.diagnostics).map((d) => d.code),
    model: compiled.model,
  }
}

/** Звірка цілі з бажаним станом моделі теки: порожня чи ні, і дії плану. */
async function comparison(target: DbConnection, model: CompiledModel) {
  const desired = await desiredForApply(model)
  const compared = await compareWithDesired(
    engine,
    { target },
    desired.sql,
    desired.scope,
    desired.diagnostics
  )
  if (compared.status !== "compared")
    throw new Error(JSON.stringify(compared.diagnostics))
  return {
    empty: compared.empty,
    actions: compared.plan.actions.map((a) => a.sql),
    differences: compared.differences,
  }
}

/** План моделі над ціллю й його застосування без дозволів; результат — `committed`. */
async function apply(
  target: DbConnection,
  model: CompiledModel,
  permitted: readonly string[] = []
) {
  const outcome = await buildPlan(
    engine,
    { reader, scratch: createApplyDatabase({ readOnly: false }) },
    model,
    { target },
    []
  )
  expect({
    status: outcome.status,
    errors: errors(outcome.diagnostics),
  }).toEqual({ status: "planned", errors: [] })
  if (outcome.status !== "planned") throw new Error("plan refused")
  const artifact = outcome.artifact
  // Дозвіл просять рівно кроки, названі тестом (перший рядок їхнього SQL)
  expect(
    artifact.steps
      .filter((s) => artifact.requiredPermissions.includes(s.id))
      .map((s) => s.sql.split("\n")[0])
  ).toEqual([...permitted])
  const applied = await executePlan(writer, target, artifact, {
    mode: "apply",
    planHash: artifact.planHash,
    allow: artifact.requiredPermissions,
    snapshot: canonicalSnapshot(model),
  })
  expect({
    status: applied.status,
    errors: errors(applied.diagnostics),
  }).toEqual({ status: "committed", errors: [] })
  return artifact
}

/** Одержувачі `EXECUTE` функції (без власника): `PUBLIC` чи ім'я ролі. */
async function executeAcl(url: string, signature: string): Promise<string[]> {
  const rows = await query<{ grantee: string }>(
    url,
    `select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee
       from pg_proc p,
            aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = $1::regprocedure
        and a.privilege_type = 'EXECUTE'
        and a.grantee <> p.proowner`,
    [signature]
  )
  return rows.map((r) => r.grantee.replaceAll('"', "")).sort()
}

const byCode = (r: ReverseResult, code: string) =>
  r.diagnostics.filter((d) => d.code === code)
/** Файл декларацій прийнятої функції `rpc`; відомі функції теки — не він. */
const RPC_FILE = (r: { files: ReadonlyMap<string, string> }): string => {
  const found = [...r.files.keys()].filter(
    (p) => p.endsWith(".functions.json") && /\/rpc/.test(p)
  )
  expect(found).toHaveLength(1)
  return found[0]!
}
const declarations = (
  r: { files: ReadonlyMap<string, string> },
  path: string
) =>
  (JSON.parse(r.files.get(path)!) as { functions: Record<string, unknown>[] })
    .functions

export function describeDefinerAdoption(): void {
  useRoundTrip()

  describe("adoption of definer functions over a live catalog", () => {
    it("a function with a guard and no EXECUTE for anyone but the owner: a declaration without callers, an empty plan", async () => {
      await inAdoptedTarget(`${rpc(GUARD)}\n${ONLY_OWNER}`, async (ctx) => {
        const adopted = await adopt(ctx, ctx.existing)
        expect(errors(adopted.diagnostics)).toEqual([])
        expect(declarations(adopted, RPC_FILE(adopted))).toMatchObject([
          {
            function: { schema: "public", name: "rpc" },
            callers: [],
            check: { action: "read", object: task, row: "p_id" },
          },
        ])
        // Дослівних грантів декларованої функції в теці немає
        expect(
          [...adopted.files.keys()].some((p) => p.includes("grant__"))
        ).toBe(false)
        const prepared = await compiledFolder(adopted.files)
        expect(prepared.errors).toEqual([])
        expect(await comparison(ctx.target, prepared.model!)).toMatchObject({
          empty: true,
          actions: [],
        })
      })
    })

    it("only the owner and no guard: no declaration, the REVOKE stays verbatim, the compile asks for the guard", async () => {
      await inAdoptedTarget(`${rpc("NULL;")}\n${ONLY_OWNER}`, async (ctx) => {
        const adopted = await adopt(ctx, ctx.existing)
        // Клас ремонту: функція без запобіжника й без викликачів лишається
        // недекларованою, а компіляція просить закрити виклик
        expect(errors(adopted.diagnostics).map((d) => d.code)).toEqual([
          "sql.definer-caller-unchecked",
        ])
        expect(
          [...adopted.files.keys()].filter(
            (p) => /\/rpc/.test(p) && p.endsWith(".functions.json")
          )
        ).toEqual([])
        // `REVOKE` лишається дослівним: одиниця гранту з ціллю `public.rpc`
        expect(
          [...adopted.files].some(
            ([path, text]) =>
              path.includes("grant__") &&
              /REVOKE EXECUTE ON FUNCTION "?public"?\."?rpc"?/.test(text)
          )
        ).toBe(true)
      })
    })

    it("a function without a guard: introspect.definer-check-unknown; with the check and the guard added and applied, the plan is empty", async () => {
      await inAdoptedTarget(
        `${rpc("NULL;")}\n${ONLY_OWNER}\n${grantTo(API.user)}`,
        async (ctx) => {
          const adopted = await adopt(ctx, ctx.existing)
          expect(
            byCode(adopted, "introspect.definer-check-unknown").map(
              (d) => d.params?.function
            )
          ).toEqual(["public.rpc"])
          // Клас ремонту: декларація без `check` — єдина помилка, тека пишеться
          expect(errors(adopted.diagnostics).map((d) => d.code)).toEqual([
            "sql.declaration-check-missing",
          ])
          const path = RPC_FILE(adopted)
          const [entry] = declarations(adopted, path)
          expect(entry).toMatchObject({ callers: ["user"] })
          expect(entry).not.toHaveProperty("check")

          // Правка людини: `check` у декларації й запобіжник у тілі
          const files = new Map(adopted.files)
          files.set(
            path,
            JSON.stringify({
              functions: [
                {
                  ...entry,
                  check: { action: "read", object: task, row: "p_id" },
                },
              ],
            })
          )
          const sqlPath = path.replace(/\.functions\.json$/, ".sql")
          const text = files.get(sqlPath)!
          expect(text).toContain("NULL;")
          files.set(sqlPath, text.replace("NULL;", GUARD))
          const prepared = await compiledFolder(files)
          expect(prepared.errors).toEqual([])
          // Тіло змінено, тож до застосування план не порожній
          expect((await comparison(ctx.target, prepared.model!)).empty).toBe(
            false
          )
          // Заміна тіла на запобіжне — єдиний крок, що просить дозволу
          await apply(ctx.target, prepared.model!, [
            "CREATE OR REPLACE FUNCTION public.rpc(p_id uuid)",
          ])
          expect(await comparison(ctx.target, prepared.model!)).toMatchObject({
            empty: true,
            actions: [],
          })
          expect(await executeAcl(ctx.target.url, RPC)).toEqual([API.user])
        }
      )
    })

    it("EXECUTE for PUBLIC: user and command callers, introspect.execute-narrowed (anonymous); after the apply the plan is empty and the ACL is the derived one", async () => {
      // Типовий ACL: `PUBLIC` (і ролі API типовими привілеями провайдера)
      await inAdoptedTarget(rpc(GUARD), async (ctx) => {
        const adopted = await adopt(ctx, ctx.existing)
        expect(errors(adopted.diagnostics)).toEqual([])
        const [entry] = declarations(adopted, RPC_FILE(adopted))
        expect(entry!.callers).toEqual(
          testProvider() === "supabase"
            ? ["user", "service", "command"]
            : ["user", "command"]
        )
        expect(
          byCode(adopted, "introspect.execute-narrowed").map((d) => d.params)
        ).toEqual([
          { function: "public.rpc", role: API.anonymous, reason: "anonymous" },
        ])
        const prepared = await compiledFolder(adopted.files)
        expect(prepared.errors).toEqual([])
        // План відкличе `PUBLIC` і роль без сесії: до застосування не порожній
        expect((await comparison(ctx.target, prepared.model!)).empty).toBe(
          false
        )
        await apply(ctx.target, prepared.model!)
        expect(await comparison(ctx.target, prepared.model!)).toMatchObject({
          empty: true,
          actions: [],
        })
        expect(await executeAcl(ctx.target.url, RPC)).toEqual(
          [
            API.user,
            ...(testProvider() === "supabase" ? [API.service] : []),
            PLATFORM_ROLES.command,
          ]
            .filter((r): r is string => typeof r === "string")
            .sort()
        )
      })
    })

    it("a scope guard gives check.scope, and the plan is empty", async () => {
      await inAdoptedTarget(
        `${rpc(SCOPE_GUARD)}\n${ONLY_OWNER}\n${grantTo(API.user)}`,
        async (ctx) => {
          const adopted = await adopt(ctx, ctx.existing)
          expect(errors(adopted.diagnostics)).toEqual([])
          expect(declarations(adopted, RPC_FILE(adopted))).toMatchObject([
            {
              callers: ["user"],
              check: { action: "create", object: task, scope: "p_id" },
            },
          ])
          const prepared = await compiledFolder(adopted.files)
          expect(prepared.errors).toEqual([])
          expect(await comparison(ctx.target, prepared.model!)).toMatchObject({
            empty: true,
            actions: [],
          })
        }
      )
    })
  })

  describe("EXECUTE of the default privileges and USAGE of the schema (Б1)", () => {
    // Типові привілеї провайдера на `public`, як на справжньому Supabase: тестова
    // база їх не має, тож задаються тут, до створення функції
    const ADP = `ALTER DEFAULT PRIVILEGES FOR ROLE "${PROVIDER_OWNER_ROLES[testProvider()]}" IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${[API.anonymous, API.user, API.service].map((r) => `"${r}"`).join(", ")};`
    const inApp = (body: string): string =>
      body.replace("public.rpc", "app.rpc")

    it.skipIf(testProvider() !== "postgres")(
      "PUBLIC EXECUTE without USAGE on the schema: the user role is no caller, after the apply it has neither EXECUTE nor USAGE",
      async () => {
        await inAdoptedTarget(
          `${inApp(rpc(GUARD))}\n${profileRoles()
            .map((r) => `REVOKE USAGE ON SCHEMA app FROM "${r}";`)
            .join("\n")}`,
          async (ctx) => {
            const adopted = await adopt(ctx, ctx.existing)
            expect(errors(adopted.diagnostics)).toEqual([])
            const [entry] = declarations(adopted, RPC_FILE(adopted))
            // `PUBLIC` має `EXECUTE`, а роль користувача не має `USAGE` на `app`
            expect(entry).toMatchObject({
              function: { schema: "app", name: "rpc" },
            })
            expect(entry!.callers).toEqual([])
            const prepared = await compiledFolder(adopted.files)
            expect(prepared.errors).toEqual([])
            await apply(ctx.target, prepared.model!)
            expect(await comparison(ctx.target, prepared.model!)).toMatchObject(
              { empty: true, actions: [] }
            )
            // Не лише роль користувача: жодна роль профілю не отримує ні
            // `EXECUTE`, ні `USAGE`
            for (const role of profileRoles()) {
              const [has] = await query<{ fn: boolean; usage: boolean }>(
                ctx.target.url,
                `select has_function_privilege($1, 'app.rpc(uuid)', 'EXECUTE') as fn,
                        has_schema_privilege($1, 'app', 'USAGE') as usage`,
                [role]
              )
              expect({ role, ...has }).toEqual({
                role,
                fn: false,
                usage: false,
              })
            }
          },
          folder({ appSchema: true })
        )
      }
    )

    // Типові привілеї провайдера на `public` дають EXECUTE ролям API навіть
    // після `REVOKE … FROM PUBLIC`
    it.skipIf(testProvider() !== "supabase")(
      "provider default privileges on public: callers user and service, anonymous dropped; after the apply the ACL is the derived one",
      async () => {
        await inAdoptedTarget(
          `${ADP}\n${rpc(GUARD)}\nREVOKE EXECUTE ON FUNCTION ${RPC} FROM PUBLIC;`,
          async (ctx) => {
            const adopted = await adopt(ctx, ctx.existing)
            expect(errors(adopted.diagnostics)).toEqual([])
            const [entry] = declarations(adopted, RPC_FILE(adopted))
            expect(entry!.callers).toEqual(["user", "service"])
            expect(
              byCode(adopted, "introspect.execute-narrowed").map(
                (d) => d.params
              )
            ).toEqual([
              {
                function: "public.rpc",
                role: API.anonymous,
                reason: "anonymous",
              },
            ])
            const prepared = await compiledFolder(adopted.files)
            expect(prepared.errors).toEqual([])
            await apply(ctx.target, prepared.model!)
            expect(await comparison(ctx.target, prepared.model!)).toMatchObject(
              { empty: true, actions: [] }
            )
            expect(await executeAcl(ctx.target.url, RPC)).toEqual(
              [API.user, API.service].sort()
            )
          }
        )
      }
    )

    it.skipIf(testProvider() !== "supabase")(
      "the same function outside public has no default privileges: no declaration",
      async () => {
        await inAdoptedTarget(
          // `USAGE` на схему ролям API дано: без декларації лишається одна
          // причина — типових привілеїв поза `public` немає, тож `EXECUTE`
          // ролям API не відкрито
          `${ADP}\n${inApp(rpc("NULL;"))}\nGRANT USAGE ON SCHEMA app TO ${[API.anonymous, API.user, API.service].map((r) => `"${r}"`).join(", ")};\nREVOKE EXECUTE ON FUNCTION app.rpc(uuid) FROM PUBLIC;`,
          async (ctx) => {
            const adopted = await adopt(ctx, ctx.existing)
            expect(
              [...adopted.files.keys()].filter(
                (p) => /\/rpc/.test(p) && p.endsWith(".functions.json")
              )
            ).toEqual([])
            expect(byCode(adopted, "introspect.execute-narrowed")).toEqual([])
          },
          folder({ appSchema: true })
        )
      }
    )
  })

  // Функція політики (спека §5.8): `EXECUTE` виводять політики-викликачі, а
  // прямий грант ролі команд поза призначеннями прийом прибирає з теки й
  // називає звуженням. Що його справді відкликає план (ACL-різниця двигуна,
  // а не `executeGrants`, який відкликає лише ролі API), — доводить живий ACL
  // після застосування. Актор `auth.uid()` — лише профіль `supabase`.
  describe("a policy function of debt", () => {
    // Тека без видів скоупу: прийняті таблиці не мусять оголошувати скоуп
    const onlyProject = () =>
      new Map([
        [
          "project.meta.json",
          JSON.stringify({
            name: "TestApp",
            database: { provider: testProvider() },
          }),
        ],
      ])
    it.skipIf(testProvider() !== "supabase")(
      "a direct grant to the command role: introspect.execute-narrowed, and the plan revokes it",
      async () => {
        const command = PLATFORM_ROLES.command
        const sql = [
          "CREATE TABLE public.docs (id uuid PRIMARY KEY, team_id uuid NOT NULL);",
          "CREATE TABLE public.members (id uuid PRIMARY KEY, team_id uuid NOT NULL, user_id uuid NOT NULL);",
          "ALTER TABLE public.docs ENABLE ROW LEVEL SECURITY;",
          DOCS_GRANT(),
          POLICY_FUNCTION(),
          READ_POLICY(),
          `REVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC, "${API.anonymous}", "${API.service}";`,
          `GRANT EXECUTE ON FUNCTION public.f() TO "${API.user}";`,
          `GRANT EXECUTE ON FUNCTION public.f() TO "${command}";`,
        ].join("\n")
        await inAdoptedTarget(
          sql,
          async (ctx) => {
            const adopted = await adopt(ctx, ctx.existing)
            expect(errors(adopted.diagnostics)).toEqual([])
            expect(
              byCode(adopted, "introspect.execute-narrowed").map(
                (d) => d.params
              )
            ).toEqual([
              {
                function: "public.f",
                role: command,
                reason: "outside-assignments",
              },
            ])
            const prepared = await compiledFolder(adopted.files)
            expect(prepared.errors).toEqual([])
            expect(await executeAcl(ctx.target.url, "public.f()")).toEqual(
              [API.user, command].sort()
            )
            await apply(ctx.target, prepared.model!)
            expect(await executeAcl(ctx.target.url, "public.f()")).toEqual([
              API.user,
            ])
          },
          onlyProject()
        )
      }
    )
  })

  // Б2: грант, якого декларація не відтворює, не зникає мовчки — нічого не
  // записано, помилка називає роль і причину
  describe("a grant the declaration cannot carry is refused (Б2)", () => {
    useDatabaseToolsCleanup()
    const own = testRoleName("own")
    const FN = `
      CREATE SCHEMA app;
      CREATE TABLE app.note (id uuid PRIMARY KEY);
      CREATE FUNCTION app.rpc() RETURNS int LANGUAGE sql SECURITY DEFINER
        SET search_path = '' AS $$ SELECT 1 $$;
      REVOKE EXECUTE ON FUNCTION app.rpc() FROM PUBLIC;
    `
    const OPEN_SHELL = FN.replace(" SET search_path = ''", "")

    async function refused(
      sql: string,
      prepare: (url: string) => Promise<void>
    ): Promise<{ code: string; role: unknown; reason: unknown }[]> {
      let found: { code: string; role: unknown; reason: unknown }[] = []
      await appTarget(sql, ["app"], async (url) => {
        await prepare(url)
        const dir = await freshProject()
        const r = await call(
          "introspect",
          introspectInput,
          toolOptions(dir, { [ENV]: url })
        )
        expect(r.ok).toBe(false)
        expect(r.written).toBe(false)
        expect(r.changes).toEqual([])
        expect(existsSync(dir)).toBe(false)
        found = toolErrors(r)
          .filter((d) => d.code === "introspect.definer-foreign-grant")
          .map((d) => ({
            code: d.code,
            role: d.params?.role,
            reason: d.params?.reason,
          }))
      })
      return found
    }

    it.each([
      ["a closed shell", FN],
      ["a function outside the closed shell", OPEN_SHELL],
    ])("a role outside the profile with EXECUTE: %s", async (_name, sql) => {
      await dropRoles(own)
      await query(testSuperuserUrl(), `create role "${own}" nologin`)
      try {
        const found = await refused(sql, (url) =>
          query(url, `GRANT EXECUTE ON FUNCTION app.rpc() TO "${own}"`).then(
            () => {}
          )
        )
        expect(found).toEqual([
          {
            code: "introspect.definer-foreign-grant",
            role: own,
            reason: "the role is not a role of the provider profile",
          },
        ])
      } finally {
        await dropRoles(own)
      }
    })

    it("WITH GRANT OPTION to a role of the profile", async () => {
      const found = await refused(FN, (url) =>
        query(
          url,
          `GRANT EXECUTE ON FUNCTION app.rpc() TO "${API.user}" WITH GRANT OPTION`
        ).then(() => {})
      )
      expect(found).toEqual([
        {
          code: "introspect.definer-foreign-grant",
          role: API.user,
          reason: "with grant option",
        },
      ])
    })

    it("a grant made by a grantee with the grant option, not by the owner", async () => {
      const found = await refused(FN, async (url) => {
        await query(
          url,
          `GRANT EXECUTE ON FUNCTION app.rpc() TO "${API.user}" WITH GRANT OPTION`
        )
        // Грантор — роль з опцією передачі: `SET LOCAL ROLE` у транзакції,
        // ціль у дозволеній формі `testRoleFor(…)` (охоронець перемикань ролі)
        const client = await superuserClient(new URL(url).pathname.slice(1))
        try {
          await client.query("BEGIN")
          await client.query(`GRANT USAGE ON SCHEMA app TO "${API.user}"`)
          await client.query(`SET LOCAL ROLE ${testRoleFor("user")}`)
          await client.query(
            `GRANT EXECUTE ON FUNCTION app.rpc() TO "${PLATFORM_ROLES.command}"`
          )
          await client.query("COMMIT")
        } finally {
          await client.end()
        }
      })
      expect(found.map((f) => [f.role, f.reason])).toContainEqual([
        PLATFORM_ROLES.command,
        expect.stringMatching(/^granted by .+, not by the owner$/),
      ])
    })
  })

  // Б7: повторний прийом не повертає право, відкликане в базі
  describe("repeated adoption over a kept declaration (Б7)", () => {
    // Збережений файл (не згенерований шлях): функція об'єктного `.sql` —
    // `LANGUAGE sql`, тож запобіжника в ній нема, і декларація з викликачем
    // `user` лишається в класі ремонту (`sql.declaration-check-missing`), а
    // тека прийому все одно читається
    const KEPT = `CREATE FUNCTION public.kept_user() RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;`
    const keptFolder = (): Map<string, string> => {
      const files = folder()
      files.set("documents/Task/Task.sql", `${KEPT}\n`)
      files.set(
        "documents/Task/Task.functions.json",
        JSON.stringify({
          functions: [
            {
              id: "7a000000-0000-4000-8000-000000000003",
              function: { name: "kept_user" },
              callers: ["user"],
            },
          ],
        })
      )
      return files
    }
    const onlyUser = [
      `REVOKE EXECUTE ON FUNCTION public.kept_user() FROM PUBLIC;`,
      ...profileRoles().map(
        (r) => `REVOKE EXECUTE ON FUNCTION public.kept_user() FROM "${r}";`
      ),
      `GRANT EXECUTE ON FUNCTION public.kept_user() TO "${API.user}";`,
    ]

    it("callers equal to the database: no drift, the kept file is untouched", async () => {
      const existing = keptFolder()
      await inAdoptedTarget(`${KEPT}\n${onlyUser.join("\n")}`, async (ctx) => {
        const adopted = await adopt(ctx, existing)
        expect(errors(adopted.diagnostics).map((d) => d.code)).toEqual([
          "sql.declaration-check-missing",
        ])
        expect(adopted.files.get("documents/Task/Task.functions.json")).toBe(
          existing.get("documents/Task/Task.functions.json")
        )
      })
    })

    it("EXECUTE of the user role revoked in the database: introspect.definer-callers-drift", async () => {
      const existing = keptFolder()
      await inAdoptedTarget(
        `${KEPT}\n${onlyUser.slice(0, -1).join("\n")}`,
        async (ctx) => {
          const adopted = await adopt(ctx, existing)
          expect(
            errors(adopted.diagnostics)
              .map((d) => [d.code, d.file])
              .sort()
          ).toEqual([
            [
              "introspect.definer-callers-drift",
              "documents/Task/Task.functions.json",
            ],
            [
              "sql.declaration-check-missing",
              "documents/Task/Task.functions.json",
            ],
          ])
          expect(
            byCode(adopted, "introspect.definer-callers-drift").map(
              (d) => d.params
            )
          ).toEqual([
            { function: "public.kept_user", declared: "user", actual: "none" },
          ])
        }
      )
    })
  })
}
