import { PROVIDER_SCHEMAS, quoteIdent } from "simetra/model"
import type { EngineDiagnostic, EngineScope } from "../engine"
import { applyDiagnostic } from "./diagnostic"
import type { ApplyTransaction } from "./port"

/** Мови, визначення яких тінь приймає дослівно без перевірки тіла. */
const SEEDABLE_LANGUAGES: ReadonlySet<string> = new Set(["sql", "plpgsql"])

/** Схеми, що є в кожній базі кластера: їхні функції засівати не треба. */
const AMBIENT_SCHEMAS = ["pg_catalog", "information_schema"]

export type ShadowEnvironment =
  | { ok: true; statements: string[] }
  | { ok: false; diagnostics: EngineDiagnostic[] }

/**
 * Середовище тіні й копії, яке двигун має застати до засіву (спека профілю
 * postgres §4.2): функції тригерів на таблицях провайдера, що лежать поза
 * межею. Такий тригер — зовнішня інтеграція, межа його виключає, але засів
 * припущених схем двигуна переносить його з цілі, а залежність, яку
 * обрізала політика межі, вважає наявною в кластері — і `CREATE TRIGGER`
 * падав би без функції. Тож функцію беруть з цілі дослівно
 * (`pg_get_functiondef`), а не заглушкою: тінь бачить ту саму функцію. Поза
 * межею її не витягують, тож ні план, ні звірка її не бачать. Мова, тіло
 * якої тінь не прийме без перевірки, — кодована відмова: сирий збій засіву
 * поради не дає.
 */
export async function readShadowEnvironment(
  tx: ApplyTransaction,
  scope: EngineScope
): Promise<ShadowEnvironment> {
  const provider = PROVIDER_SCHEMAS[scope.provider]
  const rows = await tx.query<{
    schema: string
    name: string
    language: string
    def: string
  }>(
    `SELECT DISTINCT n.nspname AS schema, p.proname AS name,
            l.lanname AS language, pg_catalog.pg_get_functiondef(p.oid) AS def
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace
       JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_catalog.pg_language l ON l.oid = p.prolang
      WHERE NOT t.tgisinternal
        AND cn.nspname = ANY($1::text[])
        AND NOT n.nspname = ANY($2::text[])
      ORDER BY 1, 2`,
    [[...provider], [...scope.schemas, ...provider, ...AMBIENT_SCHEMAS]]
  )
  const refusals = rows
    .filter((r) => !SEEDABLE_LANGUAGES.has(r.language))
    .map((r) =>
      applyDiagnostic("plan.trigger-function-unseedable", "error", {
        function: `${r.schema}.${r.name}`,
        language: r.language,
      })
    )
  if (refusals.length > 0) return { ok: false, diagnostics: refusals }
  const schemas = [...new Set(rows.map((r) => r.schema))]
  return {
    ok: true,
    statements: [
      ...schemas.map((s) => `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)}`),
      ...rows.map((r) => r.def),
    ],
  }
}
