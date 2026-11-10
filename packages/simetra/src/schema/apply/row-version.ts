import { quoteIdent, type CatalogModel } from "simetra/model"
import {
  MECHANICS_FUNCTION,
  ROW_VERSION_COLUMN,
  ROW_VERSION_SEQUENCE,
  mechanicsTables,
  mechanicsTriggerName,
  type CompiledModel,
  type SqlParser,
} from "simetra/compiler"
import type { DataTable } from "./promotion/data"
import { stepId, type PlanStep } from "./steps"
import { tableKey } from "./table-key"

const SEQUENCE = `${quoteIdent(ROW_VERSION_SEQUENCE.schema)}.${quoteIdent(ROW_VERSION_SEQUENCE.name)}`

/** Таблиця в бажаних іменах, як у кроків двигуна. */
export interface TableRef {
  schema: string
  name: string
}

/**
 * Таблиця з механікою, чиї колонки читання переписав двигун. `triggers` — з
 * моделі бажаної тіні: раннер звіряє їх з живими вже після кроків двигуна.
 */
export type RewrittenTable = TableRef & { triggers: DataTable["triggers"] }

export interface RowVersionInput {
  sequenceFresh: boolean
  epochExists: boolean
  mechanicsTables: readonly TableRef[]
  entering: readonly TableRef[]
  rewritten: readonly RewrittenTable[]
}

/** Ідентичність одиниці послідовності версій у моделі двигуна. */
export const SEQUENCE_ID = `sequence:${ROW_VERSION_SEQUENCE.schema}.${ROW_VERSION_SEQUENCE.name}`

/** Чи є послідовність версій у моделі живої цілі. */
export const hasRowVersionSequence = (model: CatalogModel): boolean =>
  model.units.some((u) => u.identity === SEQUENCE_ID)

/**
 * Таблиці з живим тригером механіки: рішення — за тригером, що виконує
 * `MECHANICS_FUNCTION`, а не за іменами колонок (у живій моделі немає
 * `origin.standard`, а прийнята таблиця може мати власні `version` і
 * `updated_at`).
 */
export function liveMechanicsTables(model: CatalogModel): TableRef[] {
  const triggers = new Map(
    model.units.filter((u) => u.class === "trigger").map((u) => [u.identity, u])
  )
  const fn = new RegExp(
    `EXECUTE\\s+(?:FUNCTION|PROCEDURE)\\s+"?${MECHANICS_FUNCTION.schema}"?\\."?${MECHANICS_FUNCTION.name}"?\\s*\\(`,
    "i"
  )
  return model.tables
    .filter((t) => {
      const unit = triggers.get(
        `trigger:${t.schema}.${t.name}.${mechanicsTriggerName(t.name)}`
      )
      return unit !== undefined && fn.test(unit.sql)
    })
    .map((t) => ({ schema: t.schema, name: t.name }))
}

const qualify = (t: TableRef): string =>
  `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`

/**
 * Блок кроків `versions` (рішення Р6, Р7): засів — коли послідовність нова
 * (над усіма таблицями механіки й тими, що входять у неї) або лише таблиці
 * входять у механіку (над ними); епоха — коли послідовність нова чи рядка
 * епохи ще немає. Між ними — підвищення версії переписаних двигуном таблиць
 * (Р10): `updated_at` не чіпаємо, тож тригери кроку вимикає раннер.
 */
export function rowVersionSteps(
  input: RowVersionInput,
  offset: number
): PlanStep[] {
  const seeded = input.sequenceFresh
    ? [...input.mechanicsTables, ...input.entering]
    : [...input.entering]
  const unique = [
    ...new Map(seeded.map((t) => [tableKey(t.schema, t.name), t])).values(),
  ].sort((a, b) => {
    const x = qualify(a)
    const y = qualify(b)
    return x < y ? -1 : x > y ? 1 : 0
  })
  const base = {
    origin: "versions" as const,
    verb: "alter" as const,
    transactionality: "transactional" as const,
    newSegmentBefore: false,
    produces: [],
    consumes: [],
    destroys: [],
    produced: [],
    destroyed: [],
    consumed: [],
    dataLoss: false,
    rewriteRisk: false,
    guards: [],
  }
  const steps: Omit<PlanStep, "id">[] = []
  if (unique.length > 0)
    steps.push({
      ...base,
      sql: `DO $simetra$\n${rowVersionSeedBlock(
        unique.map(qualify),
        input.sequenceFresh ? "fresh" : "entering"
      )}\n$simetra$`,
      class: "validationScan",
      lockClass: "share",
      lockedTables: unique.map((t) => ({ schema: t.schema, name: t.name })),
    })
  for (const t of [...input.rewritten].sort((a, b) => {
    const x = qualify(a)
    const y = qualify(b)
    return x < y ? -1 : x > y ? 1 : 0
  }))
    steps.push({
      ...base,
      sql: `UPDATE ${qualify(t)} SET ${quoteIdent(ROW_VERSION_COLUMN)} = GREATEST(nextval('${SEQUENCE}'), ${quoteIdent(ROW_VERSION_COLUMN)} + 1)`,
      class: "dataStep",
      lockClass: "shareRowExclusive",
      lockedTables: [{ schema: t.schema, name: t.name }],
      rewriteRisk: true,
      triggers: t.triggers,
    })
  if (input.sequenceFresh || !input.epochExists)
    steps.push({
      ...base,
      sql: `INSERT INTO ${quoteIdent(ROW_VERSION_SEQUENCE.schema)}.${quoteIdent("version_epoch")} DEFAULT VALUES ON CONFLICT (singleton) DO UPDATE SET epoch = gen_random_uuid()`,
      class: "catalogOnly",
      lockClass: "none",
      lockedTables: [],
    })
  return steps.map((s, i) => ({ ...s, id: stepId(offset + i) }))
}

const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

/** Ключ об'єкта двигуна за структурною формою (схема, таблиця, ім'я). */
const refKey = (r: { schema: string; table?: string; name: string }): string =>
  JSON.stringify([r.schema, r.table ?? null, r.name])

/**
 * Таблиці (в іменах кроків двигуна), чиї колонки двигун переписує (Р10):
 * `ALTER COLUMN … TYPE` і пара «знищено й створено» тієї самої ідентичності
 * `column:` — так pg-delta замінює зміну виразу генерованої колонки
 * (`generatedExpr: "replace"`). Таблиця, яку план сам знищує чи створює,
 * не рахується: її рядки нові, а знищені колонки — лише наслідок. Вираз
 * читається з кроків, а не з різниці знімків: різниця тексту виразу між
 * версіями платформи давала б хибне переписування. Таблиця кроку заповнення
 * перед `NOT NULL` (платформна спека §6.6) — теж переписана: двигун може
 * зняти тригер механіки до заповнення й створити його пізніше, тож заповнені
 * рядки інакше лишилися б зі старою версією. Підвищуються всі рядки таблиці:
 * зайве перечитування клієнтом безпечне, пропущене — ні.
 */
export function rewrittenByEngine(
  steps: readonly Pick<
    PlanStep,
    "sql" | "produced" | "destroyed" | "backfill"
  >[],
  parse: SqlParser
): TableRef[] {
  const found = new Map<string, TableRef>()
  const note = (schema: string, name: string) =>
    found.set(JSON.stringify([schema, name]), { schema, name })
  const replaced = new Set<string>()
  for (const step of steps) {
    for (const r of [...step.produced, ...step.destroyed])
      if (r.kind === "table") replaced.add(refKey(r))
    if (step.backfill !== undefined) {
      note(step.backfill.table.schema, step.backfill.table.name)
      continue
    }
    const result = parse(step.sql)
    if (!result.ok) continue
    for (const { stmt } of result.statements) {
      if (!("AlterTableStmt" in stmt)) continue
      const { relation, cmds, objtype } = stmt.AlterTableStmt
      if (
        objtype === "OBJECT_TYPE" ||
        relation?.schemaname === undefined ||
        relation.relname === undefined
      )
        continue
      if (
        (cmds ?? []).some(
          (n) =>
            "AlterTableCmd" in n &&
            n.AlterTableCmd.subtype === "AT_AlterColumnType"
        )
      )
        note(relation.schemaname, relation.relname)
    }
  }
  const created = new Set(
    steps.flatMap((s) =>
      s.produced.filter((r) => r.kind === "column").map(refKey)
    )
  )
  for (const step of steps)
    for (const r of step.destroyed)
      if (
        r.kind === "column" &&
        r.table !== undefined &&
        created.has(refKey(r))
      )
        note(r.schema, r.table)
  return [...found.values()].filter(
    (t) => !replaced.has(refKey({ schema: t.schema, name: t.name }))
  )
}

/**
 * Тригери таблиці в моделі бажаної тіні (бажані імена): режим моделі завжди
 * `O` (інший режим модель не мапить), порядок — як у `readUserTriggers`.
 */
export function modelTriggers(
  model: CatalogModel,
  table: TableRef
): DataTable["triggers"] {
  const prefix = `trigger:${table.schema}.${table.name}.`
  return model.units
    .filter((u) => u.class === "trigger" && u.identity.startsWith(prefix))
    .map((u) => ({
      name: u.identity.slice(prefix.length),
      enabled: "O" as const,
    }))
    .sort((a, b) => byCodeUnit(a.name, b.name))
}

/**
 * Відмова Р11: кроки даних на таблиці з живою механікою, коли послідовності
 * ще немає. `tables` — імена цілі (старі).
 */
export function rowVersionFirstTables(
  live: CatalogModel,
  tables: readonly TableRef[]
): string[] {
  if (hasRowVersionSequence(live)) return []
  const mech = new Set(
    liveMechanicsTables(live).map((t) => tableKey(t.schema, t.name))
  )
  return tables.filter((t) => mech.has(tableKey(t.schema, t.name))).map(qualify)
}

/**
 * Таблиці засіву — ті самі, що дістають тригер механіки: рішення читається з
 * того самого місця, що й генератор, а не виводиться з імен колонок.
 */
export function rowVersionTables(
  model: Pick<CompiledModel, "project" | "physical">
): string[] {
  return mechanicsTables(model.physical, model.project.naming.attributeCase)
    .map((t) => `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Режим засіву (рішення Р6). `fresh` — послідовність щойно створена чи
 * пересоздана: порівнювати нема з чим, одразу замки. `entering` — послідовність
 * жива, а таблиці лише отримують механіку: спершу без замка перевірити, чи
 * засів потрібен, бо послідовність лише росте і «не треба» лишається правдою.
 */
export type RowVersionSeedMode = "fresh" | "entering"

/**
 * Єдиний рендерер засіву послідовності версій (Р6), спільний для кроку
 * застосування і `reset_row_version_epoch()`: тіло блоку plpgsql
 * `DECLARE … BEGIN … END`, яке викликач вкладає у `DO` чи у функцію.
 * Порядок: (за `entering`) перевірка без замка → `LOCK TABLE … IN SHARE MODE`
 * кожної таблиці (блокує запис до коміту: у першій міграції паралельні
 * транзакції ще виконують старий тригер `+1`) і `ALTER SEQUENCE … NO CYCLE`
 * (`ShareRowExclusiveLock`, блокує `nextval`) → повторне сканування максимуму
 * → `setval(…, максимум, true)`. Крок `versions` бере обидва замки під
 * `lock_timeout` застосування; `reset_row_version_epoch()` — під таймаутом
 * сесії викликача, тож процедуру запускають при зупиненому застосунку.
 * `setval` ставиться лише коли максимум не менший за наступне
 * значення — послідовність ніколи не опускається. Наступне значення —
 * `CASE WHEN is_called THEN last_value + 1 ELSE last_value END`.
 * Без таблиць механіки сіяти нема чого. `after` — оператори, що йдуть у тій
 * самій транзакції під тими самими замками.
 */
export function rowVersionSeedBlock(
  tables: readonly string[],
  mode: RowVersionSeedMode,
  after: readonly string[] = []
): string {
  const pad = (lines: readonly string[], by: string) =>
    lines.map((l) => `${by}${l}`)
  const scan = [
    "SELECT coalesce(max(m), 0) INTO v_max FROM (",
    ...pad(
      tables.flatMap((t, i) => [
        ...(i === 0 ? [] : ["UNION ALL"]),
        `SELECT max(${quoteIdent(ROW_VERSION_COLUMN)}) AS m FROM ${t}`,
      ]),
      "  "
    ),
    ") s;",
    `SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END INTO v_next FROM ${SEQUENCE};`,
  ]
  // Замки, повторне сканування й `setval` лише вгору: під замками максимум
  // остаточний, а умова гарантує, що послідовність не опускається
  const reseed = [
    ...tables.map((t) => `LOCK TABLE ${t} IN SHARE MODE;`),
    `ALTER SEQUENCE ${SEQUENCE} NO CYCLE;`,
    ...scan,
    "IF v_max >= v_next THEN",
    `  PERFORM setval('${SEQUENCE}', v_max, true);`,
    "END IF;",
  ]
  const seed =
    tables.length === 0
      ? []
      : mode === "fresh"
        ? reseed
        : [...scan, "IF v_max >= v_next THEN", ...pad(reseed, "  "), "END IF;"]
  return [
    "DECLARE",
    "  v_max bigint;",
    "  v_next bigint;",
    "BEGIN",
    ...pad(seed, "  "),
    ...pad(after, "  "),
    "END",
  ].join("\n")
}

/**
 * Кроки `versions` плану з вхідних фактів: жива модель цілі, стан, таблиці
 * механіки бажаної моделі (бажані імена), кроки двигуна. `liveName` —
 * ім'я таблиці на цілі, коли воно інше (промоція: старі імена).
 */
export function planRowVersionSteps(p: {
  live: CatalogModel
  epochExists: boolean
  model: Pick<CompiledModel, "project" | "physical">
  /** Модель бажаної тіні: з неї тригери кроків підвищення. */
  desired: CatalogModel
  engineSteps: readonly Pick<
    PlanStep,
    "sql" | "produces" | "destroys" | "produced" | "destroyed" | "backfill"
  >[]
  parse: SqlParser
  offset: number
  liveName?: (t: TableRef) => TableRef
}): PlanStep[] {
  const liveName = p.liveName ?? ((t: TableRef) => t)
  const sequenceFresh =
    !hasRowVersionSequence(p.live) ||
    p.engineSteps.some(
      (s) =>
        s.produces.includes(SEQUENCE_ID) || s.destroys.includes(SEQUENCE_ID)
    )
  const wanted = mechanicsTables(
    p.model.physical,
    p.model.project.naming.attributeCase
  ).map((t): TableRef => ({ schema: t.schema, name: t.name }))
  const mechanical = new Set(
    liveMechanicsTables(p.live).map((t) => tableKey(t.schema, t.name))
  )
  const present = new Set(p.live.tables.map((t) => tableKey(t.schema, t.name)))
  const keyOf = (t: TableRef) => {
    const l = liveName(t)
    return tableKey(l.schema, l.name)
  }
  return rowVersionSteps(
    {
      sequenceFresh,
      epochExists: p.epochExists,
      mechanicsTables: wanted.filter((t) => mechanical.has(keyOf(t))),
      entering: wanted.filter(
        (t) => present.has(keyOf(t)) && !mechanical.has(keyOf(t))
      ),
      // Лише таблиці, що мали механіку на цілі й мають її в бажаній моделі
      rewritten: rewrittenByEngine(p.engineSteps, p.parse)
        .filter(
          (t) =>
            mechanical.has(keyOf(t)) &&
            wanted.some(
              (w) => tableKey(w.schema, w.name) === tableKey(t.schema, t.name)
            )
        )
        .map((t) => ({ ...t, triggers: modelTriggers(p.desired, t) })),
    },
    p.offset
  )
}
