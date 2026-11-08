import { quoteIdent } from "simetra/model"
import {
  ROW_VERSION_COLUMN,
  ROW_VERSION_SEQUENCE,
  mechanicsTables,
  type CompiledModel,
} from "simetra/compiler"

const SEQUENCE = `${quoteIdent(ROW_VERSION_SEQUENCE.schema)}.${quoteIdent(ROW_VERSION_SEQUENCE.name)}`

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
 * → `setval(…, максимум, true)`. Обидва замки йдуть під `lock_timeout`
 * застосування. `setval` ставиться лише коли максимум не менший за наступне
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
