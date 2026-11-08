import { quoteIdent, type CatalogModel } from "simetra/model"
import {
  MECHANICS_FUNCTION,
  ROW_VERSION_COLUMN,
  ROW_VERSION_SEQUENCE,
  mechanicsTables,
  mechanicsTriggerName,
  type CompiledModel,
} from "simetra/compiler"
import { stepId, type PlanStep } from "./steps"
import { tableKey } from "./table-key"

const SEQUENCE = `${quoteIdent(ROW_VERSION_SEQUENCE.schema)}.${quoteIdent(ROW_VERSION_SEQUENCE.name)}`

/** Таблиця в бажаних іменах, як у кроків двигуна. */
export interface TableRef {
  schema: string
  name: string
}

/** Placeholder: Task 6 розширить типом таблиці, чиї колонки переписав двигун. */
export type RewrittenTable = TableRef

export interface RowVersionInput {
  sequenceFresh: boolean
  epochExists: boolean
  mechanicsTables: readonly TableRef[]
  entering: readonly TableRef[]
  rewritten: readonly RewrittenTable[]
}

const SEQUENCE_ID = `sequence:${ROW_VERSION_SEQUENCE.schema}.${ROW_VERSION_SEQUENCE.name}`

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
 * епохи ще немає. Підвищення версії переписаних таблиць — Task 6.
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
  engineSteps: readonly Pick<PlanStep, "produces" | "destroys">[]
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
  const desired = mechanicsTables(
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
      mechanicsTables: desired.filter((t) => mechanical.has(keyOf(t))),
      entering: desired.filter(
        (t) => present.has(keyOf(t)) && !mechanical.has(keyOf(t))
      ),
      rewritten: [],
    },
    p.offset
  )
}
