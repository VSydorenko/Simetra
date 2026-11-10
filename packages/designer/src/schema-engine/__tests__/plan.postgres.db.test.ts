import { withDatabaseName } from "@supabase/pg-delta"
import pg from "pg"
import { canonicalSnapshot, compile } from "simetra/compiler"
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
  dropTaggedCluster,
  prepareStackIdentity,
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
  await setTestPasswords(set)
  // У ПГ-3 ці гранти дасть `roles`; до того їх ставить тест
  await prepareStackIdentity({
    superuserUrl: targetDb(),
    authUrl: roleUrl(set, set.auth),
    auth: set.auth,
    owner: set.owner,
  })
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
      // Гейт бачить у чужих схемах лише розширення й тригери провізії
      const census = await readCensus(c, {
        schemas: [],
        provider: "postgres",
      })
      expect(census.map((x) => x.class).sort()).toEqual(["trigger"])
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
