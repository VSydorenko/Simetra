// Ідентичність Better Auth тегованих цілей designer-а на стеку `postgres`
// (рішення Р17 плану ПГ-2b): у сталому порядку — гола ціль із шаблону
// кластера (`withTemplateTarget`), `withTargetIdentity`, план і застосування
// моделі, що посилається на ідентичність, `signUp` — ціль має той самий стан,
// що й база тестів після `db:pg:start`. Гола ціль — не тінь `inTarget`: у тіні
// pg-delta засіває заглушку `better_auth."user"` від ролі рушія, а справжня
// ціль засіву не має (розвилка 7, варіант Б). DB-рівень, бо власника таблиць,
// тригер провізії й гард прав вирішує сервер.
import { withDatabaseName } from "@supabase/pg-delta"
import pg from "pg"
import {
  canonicalSnapshot,
  compile,
  type CompiledModel,
} from "simetra/compiler"
import { PROVIDER_IDENTITY_SOURCES, PROVIDER_OWNER_ROLES } from "simetra/model"
import { buildPlan, desiredForApply, executePlan } from "simetra/schema"
import {
  afterAll,
  describe,
  expect,
  it,
  onTestFinished,
  TestRunner,
} from "vitest"
import { createApplyDatabase, createPgDeltaEngine } from "../schema-engine"
import { postgresBasePolicy } from "../schema-engine/pg-delta/policy"
import {
  authLoginRole,
  catalog,
  metaFiles,
  policyDomain,
  project,
  runtimeValuesLayer,
  signUp,
  superuserClient,
  testOwnerLoginUrl,
  useTestHooks,
} from "../../../simetra/test/support"
import {
  inTarget,
  seedRuntimeActor,
  withCopy,
  withTargetIdentity,
  withTemplateTarget,
} from "./support/db"

const OWNER = PROVIDER_OWNER_ROLES.postgres
const AUTH = authLoginRole()
const { schema, name } = PROVIDER_IDENTITY_SOURCES.postgres.table
const TABLE = `${schema}."${name}"`
const engine = createPgDeltaEngine()
const dbs = {
  reader: createApplyDatabase({ readOnly: true }),
  scratch: createApplyDatabase({ readOnly: false }),
}
const writer = createApplyDatabase({ readOnly: false })

// Бажаний стан тіні без SQL ідентичності: лише схема, якої модель не торкається
const BARE = "CREATE SCHEMA bare;"
const BARE_SCOPE = { schemas: ["bare"], provider: "postgres" } as const

let compiledModel: CompiledModel | undefined

/** Модель прав профілю `postgres`: «Користувачі» з тригером провізії. */
async function model(): Promise<CompiledModel> {
  if (compiledModel !== undefined) return compiledModel
  const files = policyDomain(runtimeValuesLayer())
  const project = JSON.parse(files.get("project.meta.json")!) as {
    database: { provider: string }
  }
  project.database.provider = "postgres"
  files.set("project.meta.json", JSON.stringify(project))
  const result = await compile(files)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  compiledModel = result.model!
  return compiledModel
}

const databaseOf = (url: string): string =>
  decodeURIComponent(new URL(url).pathname.slice(1))

/** Вхід власника до бази `url`: план і застосування вимагають `session_user = current_user`. */
const ownerLogin = (url: string): string =>
  withDatabaseName(testOwnerLoginUrl(), databaseOf(url))

/** Модель без ідентичності: один довідник, без FK на `better_auth`. */
async function plainModel(): Promise<CompiledModel> {
  const result = await compile(
    metaFiles({
      "project.meta.json": project({
        defaultSchema: "app",
        database: { provider: "postgres" },
      }),
      "catalogs/Party/Party.meta.json": catalog("Party"),
    })
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

/** План і застосування моделі на ціль `url` від входу власника. */
async function planAndApply(
  url: string,
  m: CompiledModel | undefined = undefined
): Promise<void> {
  m ??= await model()
  const target = { url: ownerLogin(url) }
  const outcome = await buildPlan(engine, dbs, m, { target }, [])
  if (outcome.status !== "planned")
    throw new Error(
      `${outcome.status}: ${outcome.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => `${d.code} ${d.message}`)
        .join("; ")}`
    )
  const artifact = outcome.artifact
  const applied = await executePlan(writer, target, artifact, {
    mode: "apply",
    planHash: artifact.planHash,
    allow: artifact.requiredPermissions,
    snapshot: canonicalSnapshot(m),
  })
  expect(applied.status).toBe("committed")
}

/** Власник таблиці ідентичності цілі `url`, читає суперкористувач. */
async function identityOwner(url: string): Promise<string | undefined> {
  const client = await superuserClient(databaseOf(url))
  try {
    const { rows } = await client.query<{ owner: string }>(
      `SELECT pg_catalog.pg_get_userbyid(relowner) AS owner FROM pg_catalog.pg_class
        WHERE oid = pg_catalog.to_regclass($1)`,
      [TABLE]
    )
    return rows[0]?.owner
  } finally {
    await client.end()
  }
}

async function withClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** `signUp` у закоміченій транзакції цілі: провізія дає рядок «Користувачів». */
async function signsUp(url: string): Promise<void> {
  await withClient(url, async (client) => {
    await client.query("BEGIN")
    try {
      const id = await signUp(client)
      const { rows } = await client.query(
        "SELECT id FROM public.users WHERE id = $1",
        [id]
      )
      expect(rows).toHaveLength(1)
    } finally {
      await client.query("ROLLBACK")
    }
  })
}

describe("Better Auth identity of a tagged target", () => {
  it("withTargetIdentity, then the plan with the provision trigger, then signUp", async () => {
    await withTemplateTarget(async (url) => {
      await withTargetIdentity(url)
      expect(await identityOwner(url)).toBe(AUTH)
      await planAndApply(url)
      await signsUp(url)
      expect(await identityOwner(url)).toBe(AUTH)
    })
  })

  it("the same on a copy of a bare target", async () => {
    await withTemplateTarget(async (url) => {
      await withCopy(`template "${databaseOf(url)}"`, async (copy) => {
        await withTargetIdentity(copy)
        await planAndApply(copy)
        await signsUp(copy)
        expect(await identityOwner(copy)).toBe(AUTH)
      })
    })
  })

  // Тінь `inTarget` несе заглушку засіву від ролі рушія, хоч би якого
  // бажаного стану: хелпер її не перевласнює й не наповнює
  it.each([
    ["without the identity", async () => ({ sql: BARE, scope: BARE_SCOPE })],
    [
      "of the model with the identity",
      async () => desiredForApply(await model()),
    ],
  ])(
    "refuses an inTarget shadow target, desired SQL %s, before the migration",
    async (_, desired) => {
      const { sql, scope } = await desired()
      await inTarget(sql, scope, async (url) => {
        await expect(withTargetIdentity(url)).rejects.toThrow(
          `${TABLE} of ${databaseOf(url)} is owned by ${OWNER}, not ${AUTH}`
        )
        expect(await identityOwner(url)).toBe(OWNER)
      })
    }
  )

  it("seedRuntimeActor passes the rights guard on a target after withTargetIdentity", async () => {
    await withTemplateTarget(async (url) => {
      await withTargetIdentity(url)
      await planAndApply(url)
      await withClient(url, async (owner) => {
        const actor = await seedRuntimeActor(owner)
        const { rows } = await owner.query(
          "SELECT 1 FROM public.org_member WHERE id = $1 AND user_id = $2",
          [actor.member, actor.user]
        )
        expect(rows).toHaveLength(1)
      })
    })
  })

  it("the owner login to the target database runs with session_user = current_user", async () => {
    await withTemplateTarget(async (url) => {
      await withClient(ownerLogin(url), async (client) => {
        const { rows } = await client.query(
          "SELECT session_user AS session, current_user AS current"
        )
        expect(rows).toEqual([{ session: OWNER, current: OWNER }])
      })
    })
  })
})

// Засів припущених схем живе лише в тіні (спека §4.2 «Тінь»): застосування
// плану на справжню ціль не створює ні `better_auth`, ні заглушок — інакше
// ціль мала б таблицю ідентичності від ролі рушія замість міграції Better Auth
describe("an engine apply onto a target from the template", () => {
  it("creates no assumed schema and no stub in the target", async () => {
    const assumed = postgresBasePolicy.assumedSchemas ?? []
    expect(assumed).toContain(schema)
    await withTemplateTarget(async (url) => {
      await planAndApply(url, await plainModel())
      const client = await superuserClient(databaseOf(url))
      try {
        const { rows } = await client.query<{ name: string }>(
          `SELECT n.nspname AS name FROM pg_catalog.pg_namespace n
            WHERE n.nspname = ANY($1::text[])
           UNION ALL
           SELECT n.nspname || '.' || c.relname FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = ANY($1::text[])`,
          [assumed]
        )
        expect(rows).toEqual([])
        // Застосування справді пройшло: модель стоїть на цілі
        const applied = await client.query(
          "SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'app'"
        )
        expect(applied.rows).toHaveLength(1)
      } finally {
        await client.end()
      }
    })
  })
})

// Живий шлях `superuserClient` → хуки setup-файлу: клієнт хелпера
// пов'язується з тестом, що його відкрив, і перевірка справді виконується
// по його завершенні (сама перевірка ролі — unit-тест `connection.test.ts`)
describe("a superuser client of a helper", () => {
  const ran: string[] = []
  let left: pg.Client | undefined

  afterAll(async () => {
    await left?.end()
  })

  it("binds its check to the test that opened it", async () => {
    const registered: (() => Promise<void>)[] = []
    useTestHooks({
      current: () => TestRunner.getCurrentTest(),
      onFinished: (check) => {
        registered.push(check)
        onTestFinished(async () => {
          ran.push("check")
          await check()
        })
      },
    })
    try {
      expect(TestRunner.getCurrentTest()).toBeDefined()
      left = await superuserClient()
      expect(registered).toHaveLength(1)
    } finally {
      // Хуки setup-файлу назад: наступні тести файлу йдуть під ними
      useTestHooks({
        current: () => TestRunner.getCurrentTest(),
        onFinished: (check) => onTestFinished(check),
      })
    }
  })

  it("the check ran at the end of that test, on the client still open", () => {
    expect(ran).toEqual(["check"])
    expect(left).toBeDefined()
  })
})
