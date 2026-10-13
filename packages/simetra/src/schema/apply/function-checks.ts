import { z } from "zod"
import type { EngineDiagnostic } from "../engine"
import { applyDiagnostic } from "./diagnostic"
import { ApplyDbError, type ApplyTransaction } from "./port"
import { RETRYABLE_SQLSTATES } from "./retry"

/**
 * Помилка тіла функції, яку дала перевірка. `relationOid` і `relation` —
 * таблиця тригера, з якою перевірено тригерну функцію; валідатор мови
 * перевіряє без таблиці, тож у нього обидва `null`.
 */
export interface FunctionError {
  oid: string
  /** Текст `regprocedure` під шляхом ревалідації. */
  signature: string
  relationOid: string | null
  relation: string | null
  sqlstate: string
  message: string
}

/** `total` — усі помилки, `errors` — не більше за `FUNCTION_ERROR_LIMIT`. */
export interface CheckResult {
  total: number
  errors: FunctionError[]
}

/**
 * Скільки помилок перевірка передає раннеру (рішення 3 плану П3-2b-1): до
 * клієнта ціло доходить і більше, а межа лишає запас. Більше з будь-якого
 * боку — порівняти не можна, і це відмова, а не тиша.
 */
export const FUNCTION_ERROR_LIMIT = 1000

/** Скільки функцій називають діагностики перевірки; решту дає лише `count`. */
export const FUNCTION_LIMIT = 10

/** SQLSTATE, яким DO-блок валідаторів завжди віддає свій результат. */
const RESULT_SQLSTATE = "SIMFE"

const SAVEPOINT = "simetra_revalidate"

const retryableList = RETRYABLE_SQLSTATES.map((s) => `'${s}'`).join(", ")

/**
 * Валідатори мов `sql` і `plpgsql` для кожної функції бази поза каталогом,
 * тимчасовими схемами й членами розширень (рішення 3). Валідатор
 * `proconfig` не застосовує, тож блок ставить налаштування функції сам —
 * кожне у власному вкладеному блоці, без `check_function_bodies`, а збій
 * налаштування (скажімо, суперкористувача) пропускає. Сторожовий виняток
 * `SIMOK` відкочує ці `set_config` разом із підтранзакцією. Повторювані
 * SQLSTATE летять далі, а не стають помилкою функції. Результат — нуль
 * об'єктів і нуль імен: блок завжди закінчується винятком `SIMFE` з JSON.
 */
const VALIDATOR_BLOCK = `DO $simetra$
DECLARE r record; kv text; errs text[] := '{}'; total int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proconfig, l.lanvalidator
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang AND l.lanname IN ('sql', 'plpgsql')
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname !~ '^pg_(temp|toast)'
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND d.objid = p.oid AND d.deptype = 'e')
      -- без EXECUTE функція сліпа (рішення 5), а її 42501 лише наближав би межу
      AND pg_catalog.has_function_privilege(p.oid, 'EXECUTE')
    ORDER BY p.oid
  LOOP
    BEGIN
      FOREACH kv IN ARRAY coalesce(r.proconfig, '{}') LOOP
        CONTINUE WHEN pg_catalog.split_part(kv, '=', 1) = 'check_function_bodies';
        BEGIN
          PERFORM pg_catalog.set_config(pg_catalog.split_part(kv, '=', 1),
            pg_catalog.substr(kv, pg_catalog.strpos(kv, '=') + 1), true);
        EXCEPTION WHEN OTHERS THEN
          IF SQLSTATE IN (${retryableList}) THEN RAISE; END IF;
        END;
      END LOOP;
      EXECUTE pg_catalog.format('SELECT %s($1)', r.lanvalidator::pg_catalog.regproc) USING r.oid;
      -- сторожовий виняток відкочує set_config вкладеного блоку
      RAISE EXCEPTION USING ERRCODE = 'SIMOK';
    EXCEPTION
      WHEN SQLSTATE 'SIMOK' THEN NULL;
      WHEN OTHERS THEN
        IF SQLSTATE IN (${retryableList}) THEN RAISE; END IF;
        total := total + 1;
        IF total <= ${FUNCTION_ERROR_LIMIT} THEN
          errs := errs || pg_catalog.jsonb_build_object('oid', r.oid::text,
            'signature', r.oid::pg_catalog.regprocedure::text,
            'sqlstate', SQLSTATE, 'message', SQLERRM)::text;
        END IF;
    END;
  END LOOP;
  RAISE EXCEPTION USING ERRCODE = '${RESULT_SQLSTATE}', MESSAGE = pg_catalog.jsonb_build_object(
    'total', total, 'errors', (SELECT coalesce(pg_catalog.jsonb_agg(x::jsonb), '[]') FROM pg_catalog.unnest(errs) AS x))::text;
END $simetra$`

const validatorResultSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  errors: z.array(
    z.strictObject({
      oid: z.string(),
      signature: z.string(),
      sqlstate: z.string(),
      message: z.string(),
    })
  ),
})

/**
 * Помилки валідаторів тіл у точці збереження: DO-блок, далі `ROLLBACK TO`.
 * Налаштування ревалідації ставить той, хто кличе (`withLocalSettings`).
 * Інший SQLSTATE (зокрема повторюваний) летить далі як є; нормальне
 * завершення блоку означало б зламаний SQL перевірки.
 */
export async function readValidatorErrors(
  tx: ApplyTransaction
): Promise<CheckResult> {
  await tx.query(`SAVEPOINT ${SAVEPOINT}`)
  try {
    await tx.query(VALIDATOR_BLOCK)
  } catch (error) {
    if (!(error instanceof ApplyDbError) || error.sqlstate !== RESULT_SQLSTATE)
      throw error
    await tx.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`)
    await tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`)
    const parsed = validatorResultSchema.parse(JSON.parse(error.message))
    return {
      total: parsed.total,
      errors: parsed.errors.map((e) => ({
        ...e,
        relationOid: null,
        relation: null,
      })),
    }
  }
  throw new Error("the function validator block ended without its result")
}

/** Та сама таблиця тригера: за oid або за текстом `regclass`; без таблиці — обидві без. */
const sameRelation = (a: FunctionError, b: FunctionError): boolean =>
  (a.relationOid === null && b.relationOid === null) ||
  (a.relationOid !== null && a.relationOid === b.relationOid) ||
  (a.relation !== null && a.relation === b.relation)

/**
 * Помилки «після», яких не було в базовій лінії (рішення 4 плану П3-2b-1).
 * Порівняння мультимножиною: кожна помилка базової лінії покриває одну
 * помилку «після». Функція — спершу за oid, далі (для решти) за текстом
 * `regprocedure`: двигун часто перестворює функцію з тією самою помилкою,
 * і oid тоді інший. Два проходи, а не один жадібний: інакше збіг за
 * сигнатурою міг би забрати елемент, який потрібен збігу за oid.
 */
export function newFunctionErrors(
  baseline: readonly FunctionError[],
  after: readonly FunctionError[]
): FunctionError[] {
  const used = new Set<number>()
  const matched = new Set<number>()
  const pass = (
    sameFunction: (a: FunctionError, b: FunctionError) => boolean
  ) =>
    after.forEach((a, i) => {
      if (matched.has(i)) return
      const j = baseline.findIndex(
        (b, k) =>
          !used.has(k) &&
          b.sqlstate === a.sqlstate &&
          b.message === a.message &&
          sameRelation(a, b) &&
          sameFunction(a, b)
      )
      if (j < 0) return
      used.add(j)
      matched.add(i)
    })
  pass((a, b) => a.oid === b.oid)
  pass((a, b) => a.signature === b.signature)
  return after.filter((_, i) => !matched.has(i))
}

const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

/**
 * Функції, яких перевірка тіл не бачить (рішення 5 плану П3-2b-1), — текст
 * `regprocedure`, відсортований. Обсяг той самий, що в валідаторів:
 * - функція іншої процедурної мови: її валідатор вантажить бібліотеку в
 *   процес сервера, а це стан поза транзакцією; `c` і `internal` тіла SQL не
 *   мають і сліпими не вважаються;
 * - `sql`/`plpgsql` без `EXECUTE` для ролі: валідатор дав би `42501` і до, і
 *   після;
 * - коли `plpgsql_check` є: подієва plpgsql-функція і тригерна без
 *   нетехнічного тригера — їх він не перевіряє.
 */
export async function readBlindFunctions(
  tx: ApplyTransaction,
  plpgsqlCheck: "available" | "unavailable"
): Promise<string[]> {
  const rows = await tx.query<{ signature: string }>(
    `SELECT p.oid::pg_catalog.regprocedure::text AS signature
     FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname !~ '^pg_(temp|toast)'
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
         WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
           AND d.objid = p.oid AND d.deptype = 'e')
       AND (
         l.lanname NOT IN ('sql', 'plpgsql', 'c', 'internal')
         OR (l.lanname IN ('sql', 'plpgsql')
           AND NOT pg_catalog.has_function_privilege(p.oid, 'EXECUTE'))
         OR ($1::boolean AND l.lanname = 'plpgsql' AND (
           p.prorettype = 'pg_catalog.event_trigger'::pg_catalog.regtype
           OR (p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
             AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
               WHERE t.tgfoid = p.oid AND NOT t.tgisinternal))))
       )`,
    [plpgsqlCheck === "available"]
  )
  return rows.map((r) => r.signature).sort(byCodeUnit)
}

/**
 * Попередження про функції, яких перевірка не бачить (рішення 5): вивід
 * плану й результат застосування чи репетиції. Немає — нічого.
 */
export function blindWarning(blind: readonly string[]): EngineDiagnostic[] {
  return blind.length === 0
    ? []
    : [
        applyDiagnostic("apply.function-check-blind", "warning", {
          count: blind.length,
          functions: blind.slice(0, FUNCTION_LIMIT).join(", "),
        }),
      ]
}
