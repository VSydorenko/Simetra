import pg from "pg"
import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { engineScope, readFingerprint, type EngineScope } from "simetra/schema"
import {
  acceptDebt,
  metaFiles,
  project,
  testProvider,
} from "../../../../simetra/test/support"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import { readCensus } from "../census-read"
import { asSuperuser, inTarget, query } from "../../__tests__/support/db"

/**
 * Межа тригера на таблиці провайдера — одне правило (платформна спека §6.9,
 * `providerTriggerInBoundarySql`) у кожному читачі: політиці двигуна
 * (витяг), переписі, відбитку дрейфу й діагностиці оголошеного тригера
 * (`engine.out-of-scope`). Повна матриця {де функція тригера} × {від чого
 * залежить умова `WHEN`} проганяє кожен вхід через усіх читачів і звіряє з
 * оракулом правила: розбіжність читачів — червоний рядок, а не знахідка
 * рев'ю.
 */

const engine = createPgDeltaEngine()
const reader = createApplyDatabase({ readOnly: true })
const scope: EngineScope = { schemas: ["app"], provider: testProvider() }

/** Таблиця користувачів провайдера, її текстова колонка й власна схема. */
const SURFACE = {
  postgres: { table: 'better_auth."user"', column: "name", own: "better_auth" },
  supabase: { table: "auth.users", column: "email", own: "auth" },
}[testProvider()]

/** Де лежить функція: `builtin` залежності не записує. */
type Location = "app" | "extension" | "provider" | "outside" | "builtin"

const EXECUTE: Record<Location, string> = {
  app: "app.on_user()",
  extension: "extensions.triggered_change_notification()",
  provider: `${SURFACE.own}.simetra_probe_on_user()`,
  outside: "private.on_user()",
  builtin: "suppress_redundant_updates_trigger()",
}

const value = `new.${SURFACE.column}`
const WHEN: Record<Location | "none", string | undefined> = {
  none: undefined,
  app: `app.ok(${value})`,
  extension: `extensions.soundex(${value}) <> ''`,
  provider: `${SURFACE.own}.simetra_probe_ok(${value})`,
  outside: `private.ok(${value})`,
  builtin: `pg_catalog.length(${value}) > 0`,
}

const FUNCTIONS = (schema: string) =>
  `create function ${schema}.on_user() returns trigger language plpgsql as $$ begin return new; end $$;
   create function ${schema}.ok(text) returns boolean language sql immutable as $$ select true $$;`

/** Ціль: схеми, розширення й функції застосунку й `private` — роллю сесії. */
const SETUP = `create schema app; create schema private;
  create schema if not exists extensions;
  create extension tcn with schema extensions;
  create extension fuzzystrmatch with schema extensions;
  ${FUNCTIONS("app")}
  ${FUNCTIONS("private")}`

/** Функції власної схеми провайдера: писати туди може лише суперкористувач. */
const PROVIDER_FUNCTIONS = `create function ${SURFACE.own}.simetra_probe_on_user() returns trigger language plpgsql as $$ begin return new; end $$;
  create function ${SURFACE.own}.simetra_probe_ok(text) returns boolean language sql immutable as $$ select true $$;`

/** Оракул правила за розташуваннями функцій-залежностей. */
function inBoundary(deps: readonly Location[]): boolean {
  const recorded = deps.filter((d) => d !== "builtin")
  return (
    (recorded.length === 0 ||
      recorded.includes("app") ||
      recorded.includes("extension")) &&
    !recorded.includes("provider")
  )
}

const triggerSql = (execute: Location, when: Location | "none") => {
  // Вбудована функція тригера — `suppress_redundant_updates_trigger`, вона
  // працює лише як `BEFORE UPDATE`
  const timing = execute === "builtin" ? "before update" : "after update"
  const condition = WHEN[when]
  return `create trigger simetra_probe ${timing} on ${SURFACE.table} for each row${
    condition === undefined ? "" : ` when (${condition})`
  } execute function ${EXECUTE[execute]}`
}

const ROWS = (Object.keys(EXECUTE) as Location[]).flatMap((execute) =>
  (Object.keys(WHEN) as (Location | "none")[]).map((when) => ({
    execute,
    when,
  }))
)

async function triggerCount(url: string): Promise<number> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return (
      (await readCensus(client, scope)).find((c) => c.class === "trigger")
        ?.count ?? 0
    )
  } finally {
    await client.end()
  }
}

/**
 * Коди помилок компілятора для оголошеного тригера (спека прав §5.3, §6.1):
 * тригер на джерелі ідентичностей лише `AFTER` (Р4а), а `EXECUTE FUNCTION` і
 * `WHEN` кличуть лише вбудовані, функції моделі й поіменні функції провайдера
 * (Р6) — `tcn` і функції провайдера в перелік не входять.
 */
function expectedCompilerErrors(
  execute: Location,
  when: Location | "none"
): string[] {
  const codes = [
    ...(execute === "builtin" ? ["sql.kind-table-verbatim"] : []),
    ...(execute === "extension" || execute === "provider"
      ? ["sql.expression-call-not-allowed"]
      : []),
    ...(when === "provider" ? ["sql.expression-call-not-allowed"] : []),
  ]
  return codes.sort()
}

/**
 * Оголошений тригер: модель з функціями застосунку й `private` (тож
 * `private` — схема застосунку) і з тригером дослівною одиницею. Повертає
 * коди помилок компілятора й, коли помилок немає, чи лежить тригер поза межею
 * двигуна. Межу двигуна для форм, яких компілятор не пропускає, тримає
 * прямий тест `out-of-scope.test.ts` у `simetra`.
 */
async function declaredTrigger(
  sql: string
): Promise<{ errors: string[]; outOfScope: boolean | undefined }> {
  const result = await compile(
    await acceptDebt(
      metaFiles({
        "project.meta.json": project({
          defaultSchema: "app",
          database: { provider: testProvider() },
        }),
        "sql/app/functions.sql": FUNCTIONS("app"),
        "sql/private/functions.sql": FUNCTIONS("private"),
        "sql/app/extensions.sql":
          "CREATE EXTENSION IF NOT EXISTS tcn WITH SCHEMA extensions;\nCREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA extensions;\n",
        "sql/app/probe.sql": `${sql};\n`,
      })
    )
  )
  const errors = result.diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => d.code)
    .sort()
  if (result.model === undefined) return { errors, outOfScope: undefined }
  const { diagnostics } = await engineScope(result.model)
  return {
    errors,
    outOfScope: diagnostics.some(
      (d) =>
        d.code === "engine.out-of-scope" &&
        String(d.params.object).startsWith("trigger:")
    ),
  }
}

export function provenBoundaryMatrix(): void {
  describe.concurrent("provider trigger boundary", () => {
    it.each(ROWS)(
      "judges EXECUTE $execute with WHEN $when the same in every reader",
      async ({ execute, when }) => {
        const deps = [execute, ...(when === "none" ? [] : [when])]
        const expected = inBoundary(deps)
        const sql = triggerSql(execute, when)
        await inTarget(SETUP, scope, async (url) => {
          await query(asSuperuser(url), PROVIDER_FUNCTIONS)
          const fingerprint = () =>
            reader.transaction({ url }, "rollback", (tx) =>
              readFingerprint(tx, scope)
            )
          const before = {
            fp: await fingerprint(),
            count: await triggerCount(url),
          }
          await query(asSuperuser(url), sql)
          const policy = (
            await engine.extract({ url }, scope)
          ).model.units.some(
            (u) => u.class === "trigger" && u.name === "simetra_probe"
          )
          const census = (await triggerCount(url)) - before.count === 1
          const fp =
            (await fingerprint()).sections.triggers !==
            before.fp.sections.triggers
          expect({ policy, census, fingerprint: fp }).toEqual({
            policy: expected,
            census: expected,
            fingerprint: expected,
          })
        })
        const declared = await declaredTrigger(sql)
        expect(declared.errors).toEqual(expectedCompilerErrors(execute, when))
        // Принята форма: статична межа за схемою функції. На `supabase`
        // `extensions` — власна схема провайдера, тож `WHEN` з функцією
        // розширення в ній статично поза межею, хоч читачі бази (член
        // розширення) тримають тригер у межі.
        if (declared.errors.length === 0)
          expect(declared.outOfScope).toBe(
            deps.includes("provider") ||
              (testProvider() === "supabase" && when === "extension")
          )
      }
    )
  })
}
