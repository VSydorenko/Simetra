import { withDatabaseName } from "@supabase/pg-delta"
import pg from "pg"
import { quoteIdent } from "simetra/model"
import { ensurePostgresCluster, type PostgresClusterSet } from "simetra/schema"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  dropTaggedCluster,
  roleUrl,
  runTag,
  setTestPasswords,
  taggedClusterSet,
  testDatabaseName,
  testSuperuserUrl,
} from "../../../../simetra/test/support"
import { provisionedShadows } from "../../__tests__/support/shadows"
import { classifyDatabaseError } from "../../io/database"
import { createApplyDatabase } from ".."
import { provisionTemplateShadow } from "../pg-delta/template-shadow"
import { ShadowTemplateMissingError } from "../errors"

/**
 * Тінь профілю `postgres` з шаблону (спека профілю §4.2). DB-рівень, бо
 * `CREATE DATABASE … TEMPLATE`, права `CREATEDB`, позначку шаблону і
 * паралельне копіювання з нього вирішує Postgres.
 */
const set: PostgresClusterSet = taggedClusterSet("tplshadow")
const extra: string[] = []
const superuserUrl = testSuperuserUrl()

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: superuserUrl })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const exists = (name: string): Promise<boolean> =>
  admin(
    async (c) =>
      (await c.query("select 1 from pg_database where datname = $1", [name]))
        .rowCount === 1
  )

beforeAll(async () => {
  const url = testSuperuserUrl()
  const result = await ensurePostgresCluster(
    createApplyDatabase({ readOnly: false }),
    {
      maintenance: { url: withDatabaseName(url, "postgres") },
      target: { url: withDatabaseName(url, set.database) },
      template: { url: withDatabaseName(url, set.template) },
    },
    set
  )
  if (!result.ok)
    throw new Error(`roles refused: ${result.error.map((d) => d.code)}`)
  await setTestPasswords(set)
})

afterAll(async () => {
  // Позначку шаблону знімає тест-власник цієї бази: позначену `DROP` не бере
  for (const name of extra)
    await admin((c) =>
      c.query(`alter database ${quoteIdent(name)} is_template false`)
    ).catch(() => undefined)
  await dropTaggedCluster(set, extra)
})

const ownerUrl = (): string => roleUrl(set, set.owner)

describe("provisionTemplateShadow", () => {
  it("copies the template for the owner role, with the engine's name, accounting and cleanup", async () => {
    const shadow = await provisionTemplateShadow(ownerUrl(), set.template)
    try {
      expect(shadow.name).toMatch(/^pgdelta_shadow_/)
      expect(shadow.name).toContain(runTag())
      expect(provisionedShadows()).toContain(shadow.name)
      const { rows } = await (async () => {
        const inShadow = new pg.Client({
          connectionString: withDatabaseName(superuserUrl, shadow.name),
        })
        await inShadow.connect()
        try {
          return await inShadow.query(
            "select 1 from pg_extension where extname = 'plpgsql_check'"
          )
        } finally {
          await inShadow.end()
        }
      })()
      expect(rows).toHaveLength(1)
      expect(await exists(shadow.name)).toBe(true)
    } finally {
      await shadow.cleanup()
    }
    expect(await exists(shadow.name)).toBe(false)
  })

  it.each([
    {
      case: "a database that is not marked as a template",
      mark: false,
      owner: false,
    },
    {
      case: "a template owned by a role that is not a superuser",
      mark: true,
      owner: true,
    },
  ])("refuses $case with the advice to run roles", async (c) => {
    const name = testDatabaseName("tplbad")
    extra.push(name)
    await admin(async (client) => {
      await client.query(
        `create database ${quoteIdent(name)}${c.owner ? ` owner ${quoteIdent(set.owner)}` : ""}`
      )
      if (c.mark)
        await client.query(
          `alter database ${quoteIdent(name)} is_template true`
        )
      await client.query(
        `alter database ${quoteIdent(name)} allow_connections false`
      )
    })
    const error = await provisionTemplateShadow(ownerUrl(), name).catch(
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(ShadowTemplateMissingError)
    const classified = classifyDatabaseError(error, { target: "t" })
    expect(classified.kind).toBe("refusal")
    expect(classified.kind === "refusal" ? classified.message : "").toContain(
      "simetra roles"
    )
  })

  it("makes two shadows from one template at the same time", async () => {
    const [a, b] = await Promise.all([
      provisionTemplateShadow(ownerUrl(), set.template),
      provisionTemplateShadow(ownerUrl(), set.template),
    ])
    try {
      expect(a.name).not.toBe(b.name)
      expect(await exists(a.name)).toBe(true)
      expect(await exists(b.name)).toBe(true)
    } finally {
      await Promise.all([a.cleanup(), b.cleanup()])
    }
  })
})
