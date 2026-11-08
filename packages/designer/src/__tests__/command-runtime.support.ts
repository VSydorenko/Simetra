import { randomUUID } from "node:crypto"
import pg from "pg"
import { expect } from "vitest"
import {
  buildRuntimeCatalog,
  compile,
  type CompiledModel,
} from "simetra/compiler"
import {
  PLATFORM_ROLES,
  type CommandError,
  type MetadataRef,
  type Operation,
  type RuntimeCatalog,
  type SessionClaims,
  CommandFailure,
} from "simetra/model"
import { desiredForApply } from "simetra/schema"
import {
  createCommandRuntime,
  readRoleOf,
  type CommandDatabase,
  type CommandRuntime,
  type CommandRuntimeOptions,
} from "simetra/server"
import {
  GAUGE_TABLE,
  policyDomain,
  runtimeValuesLayer,
} from "../../../simetra/test/support"
import {
  heldResource,
  inTarget,
  seedMarker,
  seedRuntimeActor,
  throughPoolerAs,
  withRuntimeLogin,
} from "./support/db"

/**
 * Спільна підготовка тестів рантайму команд над тінню рушія: ціль із бажаним
 * станом застосування, засів, дві ролі входу та їхні пули — прямий і через
 * пулер Supavisor.
 */

export const GAUGE: MetadataRef = { kind: "Catalog", name: "Gauge" }
export const GAUGE_LOG: MetadataRef = { kind: "Catalog", name: "GaugeLog" }
export const MODULE_KEY = "Catalog.Gauge"
export const REQUEST_ROLE = readRoleOf("supabase")!

/** Більше за 2^53: `number` такого цілого не втримав би. */
export const BIG = 2n ** 53n + 1n
/** 20 цифр цілої частини й 10 дробової — межа `Numeric(30,10)`. */
export const AMOUNT = "12345678901234567890.0123456789"

export interface Actor {
  org: string
  user: string
  session: SessionClaims
}

export interface Env {
  model: CompiledModel
  catalog: RuntimeCatalog
  owner: pg.Client
  /** Роль входу з членствами в ролі команд і ролі запиту. */
  login: string
  /** Роль входу лише з членством у ролі команд. */
  commandOnly: string
  direct: pg.Pool
  pooled: pg.Pool
  me: Actor
  other: Actor
  region: string
  /** Рядок `Gauge` чужого тенанта. */
  foreign: string
}

export const sessionOf = (user: string): SessionClaims => ({
  sub: user,
  role: REQUEST_ROLE,
})

/** Актор фікстури з сесією запиту від його користувача. */
export async function seedActor(owner: pg.Client): Promise<Actor> {
  const actor = await seedRuntimeActor(owner)
  return { ...actor, session: sessionOf(actor.user) }
}

export async function seedRow(
  owner: pg.Client,
  table: string,
  org: string
): Promise<string> {
  const id = randomUUID()
  await owner.query(
    `INSERT INTO public.${table} (id, org_id) VALUES ($1, $2)`,
    [id, org]
  )
  return id
}

/**
 * Тінь з бажаним станом застосування (модель і `simetra.marker`), засів і дві
 * ролі входу; тримається, доки `close` не відпустить колбек `inTarget`.
 */
export const heldEnv = () =>
  heldResource<Env>(async (use) => {
    const result = await compile(policyDomain(runtimeValuesLayer()))
    expect(result.diagnostics).toEqual([])
    const model = result.model!
    const desired = await desiredForApply(model)
    await inTarget(desired.sql, desired.scope, async (url) => {
      const owner = new pg.Client({ connectionString: url })
      await owner.connect()
      try {
        await seedMarker(owner, model.hash)
        const me = await seedActor(owner)
        const other = await seedActor(owner)
        const region = await seedRow(owner, "region", me.org)
        const foreign = await seedRow(owner, GAUGE_TABLE, other.org)
        await withRuntimeLogin(
          url,
          [PLATFORM_ROLES.command, REQUEST_ROLE],
          (login) =>
            withRuntimeLogin(
              url,
              [PLATFORM_ROLES.command],
              async (commandOnly) => {
                const direct = new pg.Pool({ connectionString: login })
                const pooled = new pg.Pool({
                  connectionString: throughPoolerAs(login),
                })
                try {
                  await use({
                    model,
                    catalog: buildRuntimeCatalog(model),
                    owner,
                    login,
                    commandOnly,
                    direct,
                    pooled,
                    me,
                    other,
                    region,
                    foreign,
                  })
                } finally {
                  await direct.end()
                  await pooled.end()
                }
              },
              "runtime_cmd"
            )
        )
      } finally {
        await owner.end()
      }
    })
  })

/** Відмова команди як `CommandError`; успіх — помилка тесту. */
export async function refusal(work: Promise<unknown>): Promise<CommandError> {
  try {
    await work
  } catch (error) {
    if (error instanceof CommandFailure) return error.error
    throw error
  }
  throw new Error("the command succeeded")
}

/** Реквізити шапки результату: читання без `tabularSections` ТЧ не повертає. */
export function header(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([k]) => k !== "tabularSections")
  )
}

/** Рантайм над портом `database` і каталогом цілі. */
export const runtimeOver = (
  env: Env,
  database: CommandDatabase,
  options: Partial<CommandRuntimeOptions> = {}
): Promise<CommandRuntime> =>
  createCommandRuntime({ database, catalog: env.catalog, ...options })

/** Створення `Gauge` в організації актора `me`. */
export const gaugeCreate = (
  env: Env,
  id: string,
  extra: Record<string, unknown> = {}
) =>
  ({
    action: "create",
    object: GAUGE,
    id,
    values: { org: env.me.org, ...extra },
  }) satisfies Operation
