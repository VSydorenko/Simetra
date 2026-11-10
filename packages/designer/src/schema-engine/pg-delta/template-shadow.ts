import {
  ShadowProvisionError,
  withDatabaseName,
  type CoLocatedShadow,
  type ProvisionCoLocatedShadowOptions,
} from "@supabase/pg-delta"
import pg from "pg"
import { quoteIdent } from "simetra/model"
import { ShadowTemplateMissingError } from "../errors"

/** Префікс імені тіні двигуна: той самий, що в `provisionCoLocatedShadow`, — за ним прибиральник упізнає тіні. */
const SHADOW_PREFIX = "pgdelta_shadow_"

function pool(url: string): pg.Pool {
  const p = new pg.Pool({ connectionString: url, max: 2 })
  // Помилка простого клієнта (рестарт сервера) не має валити процес
  p.on("error", () => {})
  return p
}

/**
 * Creates a throwaway shadow database on the cluster of `baseUrl` as a copy of
 * the sealed template database `template`, and returns its URL plus a cleanup
 * that drops it. Throws `ShadowProvisionError` when the connecting role lacks
 * CREATEDB and `ShadowTemplateMissingError` when the template is absent or not
 * sealed by a superuser.
 */
export async function provisionTemplateShadow(
  baseUrl: string,
  template: string,
  opts: ProvisionCoLocatedShadowOptions = {}
): Promise<CoLocatedShadow> {
  const suffix =
    opts.uniqueSuffix ??
    `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`
  const name = `${SHADOW_PREFIX}${suffix}`
  const maint = pool(baseUrl)
  try {
    const probe = await maint.query<{ can: boolean }>(
      "select (rolcreatedb or rolsuper) as can from pg_catalog.pg_roles where rolname = current_user"
    )
    if (probe.rows[0]?.can !== true)
      throw new ShadowProvisionError(
        "the connecting role lacks CREATEDB on the target cluster, so a shadow cannot be created"
      )
    // Шаблон, який не запечатав суперкористувач, міг підмінити інший: копія з
    // нього отримала б чужі об'єкти. Запечатаний — позначка, закрите
    // підключення й власник-суперкористувач (їх ставить `simetra roles`)
    const sealed = await maint.query<{ ok: boolean }>(
      `select (d.datistemplate and not d.datallowconn and o.rolsuper) as ok
         from pg_catalog.pg_database d
         join pg_catalog.pg_roles o on o.oid = d.datdba
        where d.datname = $1`,
      [template]
    )
    if (sealed.rows[0]?.ok !== true)
      throw new ShadowTemplateMissingError(template)
    await maint.query(
      `CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(template)}`
    )
  } finally {
    await maint.end()
  }
  return {
    url: withDatabaseName(baseUrl, name),
    name,
    cleanup: async () => {
      if (opts.keep === true) return
      const m = pool(baseUrl)
      try {
        await m.query(
          `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`
        )
      } catch {
        // Прибирання не маскує результат викликача
      } finally {
        await m.end()
      }
    },
  }
}
