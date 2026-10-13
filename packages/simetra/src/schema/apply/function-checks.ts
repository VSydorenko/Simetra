import { z } from "zod"
import { quoteIdent } from "simetra/model"
import type { EngineDiagnostic } from "../engine"
import { applyDiagnostic } from "./diagnostic"
import { ApplyDbError, type ApplyTransaction } from "./port"
import { isRetryable, RETRYABLE_SQLSTATES } from "./retry"

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

/**
 * `total` — усі помилки, які перевірка нарахувала; `errors` коротший за
 * `total` — перелік обрізано на межі (`FUNCTION_ERROR_LIMIT` записів
 * валідаторів чи груп `plpgsql_check`), і порівнювати його не можна.
 */
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
 * Обсяг перевірки тіл (рішення 3, 4 плану П3-2b-1) — один фрагмент `WHERE`
 * над `pg_proc p` і `pg_namespace n` для валідаторів, сліпих функцій і
 * `plpgsql_check`: розбіжність обсягів була б мовчазною втратою — функцію не
 * перевіряв би ніхто, а сліпою її теж ніхто б не назвав. Поза обсягом —
 * каталог, тимчасові й toast-схеми й члени розширень: розширення змінює
 * свої функції саме, не план.
 */
export const FUNCTION_SCOPE_SQL = `n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname !~ '^pg_(temp|toast)'
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND d.objid = p.oid AND d.deptype = 'e')`

/**
 * Ключі `proconfig`, яких DO-блок не застосовує перед валідатором функції.
 * Кожен — зі своєю причиною.
 */
export const UNAPPLIED_FUNCTION_SETTINGS: readonly string[] = [
  // Ревалідація вмикає перевірку тіл сама: з власним `off` функції
  // валідатор нічого б не перевірив
  "check_function_bodies",
  // Перевіркою керують тайм-аути раннера: власний `lock_timeout = 0`
  // функції чекав би на чужий замок до `statement_timeout`, і замість
  // повторюваного `55P03` вийшов би сирий `57014` (Review Focus 2)
  "lock_timeout",
  // З тієї самої причини: власний тайм-аут оператора функції обірвав би
  // очікування замка раніше за `lock_timeout` раннера чи зняв би межу зовсім
  "statement_timeout",
]

const unappliedList = UNAPPLIED_FUNCTION_SETTINGS.map((s) => `'${s}'`).join(
  ", "
)

/**
 * Валідатори мов `sql` і `plpgsql` для кожної функції бази поза каталогом,
 * тимчасовими схемами й членами розширень (рішення 3). Валідатор
 * `proconfig` не застосовує, тож блок ставить налаштування функції сам —
 * кожне у власному вкладеному блоці, крім `UNAPPLIED_FUNCTION_SETTINGS`, а
 * збій налаштування (скажімо, суперкористувача) пропускає. Сторожовий виняток
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
    WHERE ${FUNCTION_SCOPE_SQL}
      -- без EXECUTE функція сліпа (рішення 5), а її 42501 лише наближав би межу
      AND pg_catalog.has_function_privilege(p.oid, 'EXECUTE')
    ORDER BY p.oid
  LOOP
    BEGIN
      FOREACH kv IN ARRAY coalesce(r.proconfig, '{}') LOOP
        CONTINUE WHEN pg_catalog.split_part(kv, '=', 1) IN (${unappliedList});
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
 * Сліпі функції, розділені пресетом провайдера (рішення 5 плану П3-2b-1):
 * `blind` дають попередження, `expected` — функції базового стану провайдера
 * з його переліку, вивід плану лише називає їхню кількість. Обидва —
 * текст `regprocedure`, відсортований.
 */
export interface BlindFunctions {
  blind: string[]
  expected: string[]
}

/**
 * Функції, яких перевірка тіл не бачить (рішення 5 плану П3-2b-1). Обсяг
 * той самий, що в валідаторів і `plpgsql_check` (`FUNCTION_SCOPE_SQL`):
 * - функція іншої процедурної мови: її валідатор вантажить бібліотеку в
 *   процес сервера, а це стан поза транзакцією; `c` і `internal` тіла SQL не
 *   мають і сліпими не вважаються;
 * - `sql`/`plpgsql` без `EXECUTE` для ролі: валідатор дав би `42501` і до, і
 *   після;
 * - коли `plpgsql_check` є: подієва plpgsql-функція і тригерна без
 *   нетехнічного тригера — їх він не перевіряє.
 *
 * `expected` — ідентичності пресету провайдера
 * (`PROVIDER_EXPECTED_BLIND_FUNCTIONS`): `<схема>.<ім'я>(<oidvectortypes>)`
 * без лапок. Схема й ім'я функції кваліфіковані завжди, на відміну від
 * тексту `regprocedure`; типи аргументів `oidvectortypes` пише так само, як
 * `format_type`, — без схеми, коли тип видно в `search_path`. Тож від шляху
 * ідентичність не залежить лише для вбудованих типів аргументів (схема
 * `pg_catalog`); запис пресету з типом іншої схеми мусить бути таким, як його
 * друкує каталог під шляхом ревалідації.
 */
export async function readBlindFunctions(
  tx: ApplyTransaction,
  plpgsqlCheck: "available" | "unavailable",
  expected: readonly string[]
): Promise<BlindFunctions> {
  const rows = await tx.query<{ signature: string; expected: boolean }>(
    `SELECT p.oid::pg_catalog.regprocedure::text AS signature,
       (n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')')
         = ANY($2::text[]) AS expected
     FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE ${FUNCTION_SCOPE_SQL}
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
    [plpgsqlCheck === "available", [...expected]]
  )
  const signatures = (want: boolean) =>
    rows
      .filter((r) => r.expected === want)
      .map((r) => r.signature)
      .sort(byCodeUnit)
  return { blind: signatures(false), expected: signatures(true) }
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

/**
 * Як раннер бере `plpgsql_check` (рішення 4 плану П3-2b-1), під `planHash`:
 * - `installed` — розширення є в базі, роль має `USAGE` на його схему й
 *   `EXECUTE` на `plpgsql_check_function_tb`;
 * - `transient` — розширення доступне, і роль може поставити його в точці
 *   збереження на час перевірки;
 * - `unavailable` — інакше, зокрема встановлене без прав.
 */
export const PLPGSQL_CHECK_MODES = [
  "installed",
  "transient",
  "unavailable",
] as const

export type PlpgsqlCheckMode = (typeof PLPGSQL_CHECK_MODES)[number]

/** Розширення, яким перевірка тіл користується, коли воно є. */
const PLPGSQL_CHECK = "plpgsql_check"

/** Схема тимчасового розширення й точка збереження, у якій воно живе. */
const CHECK_SCHEMA = "simetra_plpgsql_check"

/** Факти цілі, з яких виводиться режим, і схема наявного розширення. */
type PlpgsqlCheckFacts = {
  installed: boolean
  /** Схема наявного розширення; `null` — його немає. */
  schema: string | null
  schemaUsage: boolean
  functionExecute: boolean
  available: boolean
  trusted: boolean
  superuser: boolean
  createOnDatabase: boolean
  /** Ім'я схеми тимчасового розширення вже зайняте. */
  checkSchemaTaken: boolean
}

const PLPGSQL_CHECK_FACTS_SQL = `SELECT e.oid IS NOT NULL AS installed,
  en.nspname AS schema,
  coalesce(pg_catalog.has_schema_privilege(e.extnamespace, 'USAGE'), false) AS "schemaUsage",
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc f
    WHERE f.pronamespace = e.extnamespace AND f.proname = 'plpgsql_check_function_tb'
      AND pg_catalog.has_function_privilege(f.oid, 'EXECUTE')) AS "functionExecute",
  a.name IS NOT NULL AS available,
  coalesce(v.trusted, false) AS trusted,
  coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) AS superuser,
  pg_catalog.has_database_privilege(pg_catalog.current_database(), 'CREATE') AS "createOnDatabase",
  EXISTS (SELECT 1 FROM pg_catalog.pg_namespace s WHERE s.nspname = '${CHECK_SCHEMA}') AS "checkSchemaTaken"
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_extension e ON e.extname = '${PLPGSQL_CHECK}'
LEFT JOIN pg_catalog.pg_namespace en ON en.oid = e.extnamespace
LEFT JOIN pg_catalog.pg_available_extensions a ON a.name = '${PLPGSQL_CHECK}'
LEFT JOIN pg_catalog.pg_available_extension_versions v
  ON v.name = a.name AND v.version = a.default_version`

async function readPlpgsqlCheckFacts(
  tx: ApplyTransaction
): Promise<PlpgsqlCheckFacts> {
  const [row] = await tx.query<PlpgsqlCheckFacts>(PLPGSQL_CHECK_FACTS_SQL)
  if (row === undefined)
    throw new Error("the plpgsql_check facts query returned no row")
  return row
}

/**
 * Режим за фактами. `transient` вимагає `CREATE` на базу (схема розширення)
 * і права поставити саме розширення: довірене, суперкористувач чи перелік
 * пресету провайдера (`installable`).
 */
function modeOf(
  f: PlpgsqlCheckFacts,
  installable: readonly string[]
): PlpgsqlCheckMode {
  if (f.installed)
    return f.schemaUsage && f.functionExecute ? "installed" : "unavailable"
  return f.available &&
    f.createOnDatabase &&
    (f.trusted || f.superuser || installable.includes(PLPGSQL_CHECK))
    ? "transient"
    : "unavailable"
}

/**
 * Розширення є в `pg_extension` цієї бази — незалежно від прав ролі на нього:
 * звірка цілі з планом `installed` (рішення 4) питає лише про наявність.
 */
export async function plpgsqlCheckInstalled(
  tx: ApplyTransaction
): Promise<boolean> {
  return (await readPlpgsqlCheckFacts(tx)).installed
}

/** Режим `plpgsql_check` цієї бази; `installable` — перелік пресету провайдера. */
export async function readPlpgsqlCheckMode(
  tx: ApplyTransaction,
  installable: readonly string[]
): Promise<PlpgsqlCheckMode> {
  return modeOf(await readPlpgsqlCheckFacts(tx), installable)
}

/**
 * Режим для плану й попередження чи відмова без розширення (рішення 4):
 * промоція без `plpgsql_check` — відмова (спека промоції §7.2), інший план —
 * попередження того самого коду, а валідатори мов перевіряють і далі.
 */
export async function planFunctionChecks(
  tx: ApplyTransaction,
  p: { promotion: boolean; installable: readonly string[] }
): Promise<{ mode: PlpgsqlCheckMode; diagnostics: EngineDiagnostic[] }> {
  const mode = await readPlpgsqlCheckMode(tx, p.installable)
  return {
    mode,
    diagnostics:
      mode === "unavailable"
        ? [
            applyDiagnostic(
              "plan.plpgsql-check-unavailable",
              p.promotion ? "error" : "warning",
              { on: "target" }
            ),
          ]
        : [],
  }
}

/**
 * `plpgsql_check` у цій базі взяти не вдалося, а план його чекає: створення
 * тимчасового розширення впало чи роль не має прав на наявне.
 */
export class PlpgsqlCheckUnavailable extends Error {
  constructor(
    readonly sqlstate: string,
    message: string
  ) {
    super(message)
    this.name = "PlpgsqlCheckUnavailable"
  }
}

/** Ім'я, потрібне перевірці в транзакції, уже зайняте об'єктом бази. */
export class CheckNameTaken extends Error {
  constructor(readonly taken: string) {
    super(`the name ${taken} is already taken`)
    this.name = "CheckNameTaken"
  }
}

/**
 * Помилки `plpgsql_check` групами (рішення 4): plpgsql-функції обсягу,
 * тригерна — з кожною таблицею нетехнічного тригера й таблицями переходу,
 * `fatal_errors => false` (наявна помилка не ховає нову в тій самій
 * функції), лише рівень `error`. Подієві й тригерні без тригера — сліпі.
 */
const plpgsqlCheckSql = (schema: string): string =>
  `SELECT p.oid::text AS oid, p.oid::pg_catalog.regprocedure::text AS signature,
  t.tgrelid::text AS "relationOid", t.tgrelid::pg_catalog.regclass::text AS relation,
  cs.sqlstate, cs.message, pg_catalog.count(*)::int AS n
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_language l ON l.oid = p.prolang AND l.lanname = 'plpgsql'
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN pg_catalog.pg_trigger t ON t.tgfoid = p.oid AND NOT t.tgisinternal
CROSS JOIN LATERAL ${quoteIdent(schema)}.plpgsql_check_function_tb(p.oid,
  coalesce(t.tgrelid, 0), fatal_errors => false,
  oldtable => t.tgoldtable, newtable => t.tgnewtable) cs
WHERE ${FUNCTION_SCOPE_SQL}
  AND p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
  AND (p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype OR t.tgrelid IS NOT NULL)
  AND cs.level = 'error'
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY 2, 4, 5, 6
LIMIT ${FUNCTION_ERROR_LIMIT + 1}`

type PlpgsqlErrorGroup = {
  oid: string
  signature: string
  relationOid: string | null
  relation: string | null
  sqlstate: string | null
  message: string
  n: number
}

/**
 * Помилки `plpgsql_check` цієї бази (рішення 4). Розширення раннер бере сам,
 * лише в точці збереження `simetra_plpgsql_check`, тож `ROLLBACK TO` прибирає
 * тимчасові схему й розширення разом із замками перевірки:
 * 1. є в базі — на місці;
 * 2. немає — `CREATE SCHEMA` і `CREATE EXTENSION` у точці збереження;
 *    зайняте ім'я схеми — `CheckNameTaken`;
 * 3. не вдалося (збій створення, немає прав на наявне) —
 *    `PlpgsqlCheckUnavailable`, точку збереження вже відкочено.
 *
 * План `unavailable` — перевірки немає: план уже попередив чи відмовив.
 * Група з `n` однакових рядків розгортається в `n` помилок; груп більше за
 * межу — `total` більший за `errors`, і порівняння відмовить («перелік
 * обрізано»). Збій самого запиту (зокрема повторюваний) летить далі як є.
 */
export async function readPlpgsqlErrors(
  tx: ApplyTransaction,
  planned: PlpgsqlCheckMode
): Promise<CheckResult | "skipped"> {
  if (planned === "unavailable") return "skipped"
  await tx.query(`SAVEPOINT ${CHECK_SCHEMA}`)
  const release = async () => {
    await tx.query(`ROLLBACK TO SAVEPOINT ${CHECK_SCHEMA}`)
    await tx.query(`RELEASE SAVEPOINT ${CHECK_SCHEMA}`)
  }
  const facts = await readPlpgsqlCheckFacts(tx)
  let schema: string
  if (facts.installed) {
    if (facts.schema === null)
      throw new Error("an installed plpgsql_check has no schema")
    schema = facts.schema
    if (!facts.schemaUsage || !facts.functionExecute) {
      await release()
      throw new PlpgsqlCheckUnavailable(
        "42501",
        `the applying role has no USAGE on schema ${schema} or no EXECUTE on plpgsql_check_function_tb`
      )
    }
  } else {
    if (facts.checkSchemaTaken) {
      await release()
      throw new CheckNameTaken(CHECK_SCHEMA)
    }
    try {
      await tx.query(`CREATE SCHEMA ${CHECK_SCHEMA}`)
      await tx.query(`CREATE EXTENSION ${PLPGSQL_CHECK} SCHEMA ${CHECK_SCHEMA}`)
    } catch (error) {
      if (!(error instanceof ApplyDbError) || isRetryable(error)) throw error
      await release()
      throw new PlpgsqlCheckUnavailable(
        error.sqlstate ?? "unknown",
        error.message
      )
    }
    schema = CHECK_SCHEMA
  }
  const groups = await tx.query<PlpgsqlErrorGroup>(plpgsqlCheckSql(schema))
  await release()
  const total = groups.reduce((sum, g) => sum + g.n, 0)
  const errors = groups.slice(0, FUNCTION_ERROR_LIMIT).flatMap((g) =>
    Array.from({ length: g.n }, (): FunctionError => ({
      oid: g.oid,
      signature: g.signature,
      relationOid: g.relationOid,
      relation: g.relation,
      sqlstate: g.sqlstate ?? "unknown",
      message: g.message,
    }))
  )
  return { total, errors }
}
