import { withDatabaseName } from "@supabase/pg-delta"
import pg from "pg"
import {
  canonicalSnapshot,
  compile,
  IDENTITY_TRIGGERS,
  type CompiledModel,
} from "simetra/compiler"
import { PROVIDER_LOGIN_ROLES, quoteIdent } from "simetra/model"
import {
  buildPlan,
  ensurePostgresCluster,
  executePlan,
  PROVIDER_INSTALLABLE_EXTENSIONS,
  readPlpgsqlCheckMode,
  type PlanArtifact,
  type PostgresClusterSet,
} from "simetra/schema"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  catalog,
  dropTaggedCluster,
  metaFiles,
  migrateBetterAuth,
  project,
  readReferenceDomain,
  roleUrl,
  setTestPasswords,
  taggedClusterSet,
  testSuperuserUrl,
} from "../../../../simetra/test/support"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import { readCensus } from "../census-read"

/**
 * Наскрізний план і застосування на профілі `postgres` (спека профілю §4.2).
 * DB-рівень, бо тінь з шаблону, тригери провізії на таблиці Better Auth,
 * гранти `roles` і режим `plpgsql_check` вирішує сервер, а профіль pg-delta
 * (чого план НЕ видає на шаблонній тіні) доводить лише справжній план.
 */
const set: PostgresClusterSet = taggedClusterSet("planpg")
const superuserUrl = testSuperuserUrl()
const engine = createPgDeltaEngine()
const dbs = {
  reader: createApplyDatabase({ readOnly: true }),
  scratch: createApplyDatabase({ readOnly: false }),
}
const writer = createApplyDatabase({ readOnly: false })
const targetDb = (): string => withDatabaseName(superuserUrl, set.database)
const target = () => ({ url: roleUrl(set, set.owner) })

async function admin<T>(
  url: string,
  fn: (c: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

beforeAll(async () => {
  const roles = async () => {
    const result = await ensurePostgresCluster(
      writer,
      {
        maintenance: { url: withDatabaseName(superuserUrl, "postgres") },
        target: { url: targetDb() },
        template: { url: withDatabaseName(superuserUrl, set.template) },
      },
      set
    )
    if (!result.ok)
      throw new Error(`roles refused: ${result.error.map((d) => d.code)}`)
  }
  await roles()
  await setTestPasswords(set)
  // Гранти на таблицю ідентичності дає повторний `roles` після міграції
  await migrateBetterAuth(roleUrl(set, set.auth))
  await roles()
  // Таблиця сервера авторизації агентів від ролі `auth`, як її створює крок
  // налаштування бази шаблону: зовнішній ключ на таблицю ідентичності
  await admin(roleUrl(set, set.auth), (c) =>
    c.query(
      `create table agent_oauth.agent_grants (
         grant_id text primary key,
         user_id uuid not null references better_auth."user" (id) on delete cascade,
         payload jsonb not null)`
    )
  )
  // Рядок цілі, якого в копії доказу бути не має
  await admin(targetDb(), (c) =>
    c.query(
      `insert into better_auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values (gen_random_uuid(), 'Target', 'target@example.test', false, now(), now())`
    )
  )
})

afterAll(() => dropTaggedCluster(set))

async function modelOf() {
  const files = readReferenceDomain()
  const project = JSON.parse(files.get("project.meta.json")!) as {
    database: { provider: string }
  }
  project.database.provider = "postgres"
  files.set("project.meta.json", JSON.stringify(project))
  const compiled = await compile(files)
  expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return compiled.model!
}

const shadowOptions = () => ({
  target: target(),
  // Шаблон набору, а не `simetra_template` стека: права на `extensions` у
  // шаблоні стека видано ролі `simetra_owner`, а не тегованому власнику
  shadowTemplate: set.template,
})

describe("plan and apply on the postgres profile", () => {
  // Один сценарій: кожен крок спирається на попередній (ціль, план, застосування)
  it("plans from a template shadow, applies, and leaves only the provision triggers outside the boundary", async () => {
    const model = await modelOf()
    const outcome = await buildPlan(engine, dbs, model, shadowOptions(), [])
    if (outcome.status !== "planned")
      throw new Error(
        `${outcome.status}: ${outcome.diagnostics
          .filter((d) => d.severity === "error")
          .map((d) => `${d.code} ${d.message}`)
          .join("; ")}`
      )
    const artifact: PlanArtifact = outcome.artifact

    // Review Focus 3: шаблон уже має `extensions`, а гранти `roles` на
    // `better_auth` не належать бажаному стану
    const text = artifact.steps.map((s) => s.sql).join("\n")
    expect(text).not.toMatch(/CREATE SCHEMA\s+"?extensions"?/i)
    expect(text).not.toMatch(/REVOKE[^;]*better_auth/i)
    expect(text).toMatch(/CREATE TRIGGER[^;]*"?better_auth"?\."?user"?/is)
    expect(artifact.plpgsqlCheck).toBe("installed")
    // Схема агентів поза межею плану: ні `DROP`, ні гранту, ні згадки
    expect(text).not.toMatch(/agent_oauth/i)

    // Таблиця `agent_oauth` між планом і застосуванням — не дрейф цілі
    await admin(roleUrl(set, set.auth), (c) =>
      c.query(
        "create table agent_oauth.models (id text primary key, payload jsonb not null)"
      )
    )

    const applied = await executePlan(writer, target(), artifact, {
      mode: "apply",
      planHash: artifact.planHash,
      allow: artifact.requiredPermissions,
      snapshot: canonicalSnapshot(model),
    })
    expect(applied.status).toBe("committed")

    await admin(targetDb(), async (c) => {
      const triggers = await c.query(
        `select tgname from pg_trigger
          where tgrelid = 'better_auth."user"'::regclass and not tgisinternal`
      )
      expect(triggers.rowCount).toBeGreaterThan(0)
      // Гейт бачить у чужих схемах лише тригери провізії, і то лише з
      // функцією в схемі межі: без схем межі чужого в ній немає, а з межею
      // плану тригерів рівно стільки, скільки на таблицях межі й провізії
      const census = (schemas: readonly string[]) =>
        readCensus(c, { schemas, provider: "postgres" })
      expect(await census([])).toEqual([])
      const own = await c.query(
        `select 1 from pg_trigger t join pg_class r on r.oid = t.tgrelid
          where not t.tgisinternal
            and r.relnamespace::regnamespace::text = any($1::text[])`,
        [artifact.scope.schemas]
      )
      expect(
        (await census(artifact.scope.schemas)).find(
          (x) => x.class === "trigger"
        )?.count
      ).toBe(own.rowCount! + triggers.rowCount!)
      const grants = await c.query<{ usage: boolean }>(
        `select has_schema_privilege($1, 'better_auth', 'USAGE') as usage`,
        [set.owner]
      )
      expect(grants.rows[0]?.usage).toBe(true)
    })

    // Копія доказу: той самий режим `plpgsql_check`, без рядків цілі
    const extracted = await engine.extract(target(), artifact.scope)
    const clone = await engine.withTargetClone(
      shadowOptions(),
      extracted,
      artifact.scope,
      async (db) => ({
        mode: await dbs.reader.transaction(db, "rollback", (tx) =>
          readPlpgsqlCheckMode(tx, PROVIDER_INSTALLABLE_EXTENSIONS.postgres)
        ),
        users: await admin(
          withDatabaseName(superuserUrl, new URL(db.url).pathname.slice(1)),
          async (c) =>
            (await c.query(`select count(*)::int as n from better_auth."user"`))
              .rows[0]?.n as number
        ),
      })
    )
    expect(clone.status).toBe("loaded")
    if (clone.status === "loaded") {
      expect(clone.value.mode).toBe("installed")
      expect(clone.value.users).toBe(0)
    }
  })
})

describe("identity table gate on the postgres profile", () => {
  // Свій набір: ціль без міграції Better Auth і з відкликаними грантами,
  // а набір сценарію вище мусить лишитися повним
  const gate: PostgresClusterSet = taggedClusterSet("idgate")
  const gateDb = (): string => withDatabaseName(superuserUrl, gate.database)
  const identity = `${quoteIdent(gate.identity.schema)}.${quoteIdent(gate.identity.name)}`
  const gateRoles = async () => {
    const result = await ensurePostgresCluster(
      writer,
      {
        maintenance: { url: withDatabaseName(superuserUrl, "postgres") },
        target: { url: gateDb() },
        template: { url: withDatabaseName(superuserUrl, gate.template) },
      },
      gate
    )
    if (!result.ok)
      throw new Error(`roles refused: ${result.error.map((d) => d.code)}`)
  }

  beforeAll(async () => {
    await gateRoles()
    await setTestPasswords(gate)
  })

  afterAll(() => dropTaggedCluster(gate))

  const refusalOf = async (model: Awaited<ReturnType<typeof modelOf>>) => {
    const outcome = await buildPlan(
      engine,
      dbs,
      model,
      {
        target: { url: roleUrl(gate, gate.owner) },
        shadowTemplate: gate.template,
      },
      []
    )
    // Жодного кроку: відмова без артефакту, і ціль не отримала ні стану, ні
    // ledger
    await admin(gateDb(), async (c) => {
      const found = await c.query<{ found: string | null }>(
        "select to_regclass('simetra.marker')::text as found"
      )
      expect(found.rows[0]?.found).toBeNull()
    })
    return outcome
  }

  const refused = (reason: "table" | "privilege") => ({
    status: "refused",
    diagnostics: [
      expect.objectContaining({
        code: "plan.identity-table-missing",
        severity: "error",
        params: { table: identity, reason },
      }),
    ],
  })

  // Один сценарій: кожен стан цілі будується з попереднього (схема без
  // таблиці, без схеми, таблиця без TRIGGER, без USAGE)
  it("refuses a plan without the identity table or its grants, before any step", async () => {
    const model = await modelOf()

    // Ціль без міграції Better Auth: схема є, таблиці немає
    expect(await refusalOf(model)).toEqual(refused("table"))

    // Без схеми: `has_schema_privilege` за іменем кинув би 3F000
    await admin(gateDb(), (c) =>
      c.query(`drop schema ${quoteIdent(gate.identity.schema)}`)
    )
    expect(await refusalOf(model)).toEqual(refused("table"))

    // Схему вертає `roles`, таблицю — міграція, гранти на неї — повторний
    // `roles`
    await gateRoles()
    await migrateBetterAuth(roleUrl(gate, gate.auth))
    await gateRoles()

    // Таблиця є, `TRIGGER` відкликано
    await admin(gateDb(), (c) =>
      c.query(`revoke trigger on ${identity} from ${quoteIdent(gate.owner)}`)
    )
    expect(await refusalOf(model)).toEqual(refused("privilege"))

    // `TRIGGER` повернуто, `USAGE` на схему відкликано: `to_regclass` тут
    // кинув би 42501, а не дав відмову
    await gateRoles()
    await admin(gateDb(), (c) =>
      c.query(
        `revoke usage on schema ${quoteIdent(gate.identity.schema)} from ${quoteIdent(gate.owner)}`
      )
    )
    expect(await refusalOf(model)).toEqual(refused("privilege"))
  })
})

describe("identity trigger lock on the postgres profile", () => {
  // Свій набір: сценарій застосовує й змінює тригери провізії
  const lock: PostgresClusterSet = taggedClusterSet("trglock")
  const lockDb = (): string => withDatabaseName(superuserUrl, lock.database)
  const table = `${quoteIdent(lock.identity.schema)}.${quoteIdent(lock.identity.name)}`
  const [provision] = IDENTITY_TRIGGERS as [string]
  const options = () => ({
    target: { url: roleUrl(lock, lock.owner) },
    shadowTemplate: lock.template,
  })
  const lockRoles = async () => {
    const result = await ensurePostgresCluster(
      writer,
      {
        maintenance: { url: withDatabaseName(superuserUrl, "postgres") },
        target: { url: lockDb() },
        template: { url: withDatabaseName(superuserUrl, lock.template) },
      },
      lock
    )
    if (!result.ok)
      throw new Error(`roles refused: ${result.error.map((d) => d.code)}`)
  }

  beforeAll(async () => {
    await lockRoles()
    await setTestPasswords(lock)
    await migrateBetterAuth(roleUrl(lock, lock.auth))
    await lockRoles()
  })

  afterAll(() => dropTaggedCluster(lock))

  /** Мала модель профілю: з «Користувачами» (тригери провізії) чи без. */
  async function smallModel(users: boolean): Promise<CompiledModel> {
    const compiled = await compile(
      metaFiles({
        "project.meta.json": project({ database: { provider: "postgres" } }),
        ...(users
          ? {
              "catalogs/Users/Users.meta.json": catalog("Users", {
                role: "users",
                scope: "none",
              }),
            }
          : { "catalogs/Items/Items.meta.json": catalog("Items") }),
      })
    )
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual(
      []
    )
    return compiled.model!
  }

  const plannedOf = async (model: CompiledModel): Promise<PlanArtifact> => {
    const outcome = await buildPlan(engine, dbs, model, options(), [])
    if (outcome.status !== "planned")
      throw new Error(
        `${outcome.status}: ${outcome.diagnostics
          .filter((d) => d.severity === "error")
          .map((d) => `${d.code} ${d.message}`)
          .join("; ")}`
      )
    return outcome.artifact
  }

  const apply = async (artifact: PlanArtifact, model: CompiledModel) => {
    const outcome = await executePlan(writer, options().target, artifact, {
      mode: "apply",
      planHash: artifact.planHash,
      allow: artifact.requiredPermissions,
      snapshot: canonicalSnapshot(model),
    })
    expect(outcome.status).toBe("committed")
  }

  /** Живі нетехнічні тригери таблиці ідентичності: ім'я → визначення. */
  const liveTriggers = () =>
    admin(lockDb(), async (c) => {
      const rows = await c.query<{ name: string; def: string }>(
        `select tgname as name, pg_get_triggerdef(oid) as def from pg_trigger
          where tgrelid = $1::regclass and not tgisinternal order by tgname`,
        [table]
      )
      return new Map(rows.rows.map((r) => [r.name, r.def]))
    })

  // Один сценарій: застосування, підміна живого тригера, повернення його
  // кроком CREATE OR REPLACE від власника, далі справжнє зняття
  it("returns a changed provision trigger with CREATE OR REPLACE, refuses its removal and re-enabling", async () => {
    const withUsers = await smallModel(true)
    await apply(await plannedOf(withUsers), withUsers)
    const applied = await liveTriggers()
    const desired = applied.get(provision)
    expect(desired).toMatch(/ AFTER INSERT ON /)

    // Підміна поза Simetra: та сама назва, інша подія. Від суперкористувача:
    // роль `auth`, власник таблиці, не має USAGE на схему функції провізії
    await admin(lockDb(), (c) =>
      c.query(
        desired!
          .replace(/^CREATE TRIGGER /, "CREATE OR REPLACE TRIGGER ")
          .replace(" AFTER INSERT ON ", " AFTER INSERT OR UPDATE ON ")
      )
    )
    expect((await liveTriggers()).get(provision)).toMatch(
      / AFTER INSERT OR UPDATE ON /
    )

    // Рушій дає DROP + CREATE; план зливає їх в один крок без зняття
    const back = await plannedOf(withUsers)
    const onTrigger = back.steps.filter((s) =>
      [...s.produced, ...s.destroyed].some(
        (r) => r.kind === "trigger" && r.name === provision
      )
    )
    expect(onTrigger.map((s) => [s.verb, s.destroyed])).toEqual([
      ["create", []],
    ])
    expect(onTrigger[0]!.sql).toMatch(/^CREATE OR REPLACE TRIGGER /)
    expect(back.steps.some((s) => /^DROP TRIGGER/i.test(s.sql))).toBe(false)
    // Власник має лише TRIGGER, не власність таблиці
    await apply(back, withUsers)
    expect(await liveTriggers()).toEqual(applied)

    // Модель без «Користувачів» знімає тригери провізії: це може лише
    // власник таблиці, тож відмова до будь-якого кроку
    const outcome = await buildPlan(
      engine,
      dbs,
      await smallModel(false),
      options(),
      []
    )
    expect(outcome.status).toBe("refused")
    const locked = outcome.diagnostics.filter((d) => d.severity === "error")
    expect(locked.map((d) => d.code)).toEqual(
      [...applied.keys()].map(() => "plan.identity-trigger-locked")
    )
    expect(locked.map((d) => d.params)).toEqual(
      [...applied.keys()].sort().map((trigger) => ({
        trigger,
        table,
        login: PROVIDER_LOGIN_ROLES.postgres[0],
        reason: "removed",
      }))
    )
    expect(await liveTriggers()).toEqual(applied)

    // Тригер провізії вимкнено поза Simetra: рушій дає ENABLE TRIGGER, а це
    // теж лише власник таблиці — відмова плану замість 42501 застосування
    await admin(lockDb(), (c) =>
      c.query(`alter table ${table} disable trigger ${quoteIdent(provision)}`)
    )
    const enabledOf = () =>
      admin(lockDb(), async (c) => {
        const rows = await c.query<{ enabled: string }>(
          `select tgenabled as enabled from pg_trigger
            where tgrelid = $1::regclass and tgname = $2`,
          [table, provision]
        )
        return rows.rows.map((r) => r.enabled)
      })
    expect(await enabledOf()).toEqual(["D"])
    const disabled = await buildPlan(engine, dbs, withUsers, options(), [])
    expect(disabled.status).toBe("refused")
    expect(
      disabled.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => [d.code, d.params])
    ).toEqual([
      [
        "plan.identity-trigger-locked",
        {
          trigger: provision,
          table,
          login: PROVIDER_LOGIN_ROLES.postgres[0],
          reason: "disabled",
        },
      ],
    ])
    expect(await enabledOf()).toEqual(["D"])
    expect(await liveTriggers()).toEqual(applied)
  })
})
