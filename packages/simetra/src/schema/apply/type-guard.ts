import type { AlterTableCmd, Node, TypeName } from "libpg-query"
import type { SqlParser } from "simetra/compiler"
import { quoteIdent, type CatalogModel, type CatalogTable } from "simetra/model"
import type { EngineDiagnostic } from "../engine"
import { applyDiagnostic } from "./diagnostic"
import { ApplyDbError, type ApplyTransaction } from "./port"
import type { PlanStep } from "./steps"

/**
 * Тип колонки без масиву: ім'я з `pg_catalog.` для вбудованих і
 * модифікатори (`varchar(n)`, `numeric(p,s)`).
 */
export interface ColumnType {
  name: string
  mods: number[]
}

export function stringsOf(items: readonly Node[] | undefined): string[] {
  return (items ?? []).flatMap((item) =>
    "String" in item && item.String.sval !== undefined ? [item.String.sval] : []
  )
}

/** Цілі модифікатори типу; не число — `undefined`. */
function modsOf(typeName: TypeName): number[] | undefined {
  const mods: number[] = []
  for (const mod of typeName.typmods ?? []) {
    // `A_Const` нуля не має поля `ival.ival`
    if (!("A_Const" in mod) || mod.A_Const.ival === undefined) return undefined
    mods.push(mod.A_Const.ival.ival ?? 0)
  }
  return mods
}

/**
 * Тип з дерева. Некваліфіковане ім'я — вбудований тип: адаптер читає
 * `format_type()` під `search_path = pg_catalog`, тож користувацькі типи
 * (домени, енами) там завжди кваліфіковані. Масив і модифікатор, що не є
 * числом, дають `undefined`: такий перехід у переліку без втрат не буває.
 */
export function typeOf(typeName: TypeName | undefined): ColumnType | undefined {
  if (typeName === undefined || (typeName.arrayBounds?.length ?? 0) > 0)
    return undefined
  const names = stringsOf(typeName.names)
  const mods = modsOf(typeName)
  if (mods === undefined) return undefined
  return {
    name: names.length === 1 ? `pg_catalog.${names[0]}` : names.join("."),
    mods,
  }
}

const INT_WIDENING: Readonly<Record<string, readonly string[]>> = {
  "pg_catalog.int2": ["pg_catalog.int4", "pg_catalog.int8"],
  "pg_catalog.int4": ["pg_catalog.int8"],
}

/**
 * Перехід, що зберігає кожне значення (платформна спека §6.6). `bpchar →
 * text` сюди не входить: приведення відкидає кінцеві пробіли.
 */
export function isLossless(from: ColumnType, to: ColumnType): boolean {
  if (INT_WIDENING[from.name]?.includes(to.name) === true)
    return from.mods.length === 0 && to.mods.length === 0
  if (from.name === "pg_catalog.varchar") {
    if (to.name === "pg_catalog.text") return to.mods.length === 0
    if (to.name !== "pg_catalog.varchar" || from.mods.length !== 1) return false
    return to.mods.length === 0 || to.mods[0]! >= from.mods[0]!
  }
  if (from.name === "pg_catalog.numeric" && to.name === "pg_catalog.numeric") {
    if (from.mods.length === 0) return false
    if (to.mods.length === 0) return true
    const [precision, scale = 0] = from.mods
    const [toPrecision, toScale = 0] = to.mods
    return toPrecision! >= precision! && toScale === scale
  }
  return false
}

/** Дерево типу з рядка `format_type()` моделі тим самим парсером, що й крок. */
export function parseType(
  type: string,
  parse: SqlParser
): TypeName | undefined {
  const result = parse(`SELECT NULL::${type}`)
  if (!result.ok || result.statements.length !== 1) return undefined
  const stmt = result.statements[0]!.stmt
  const target =
    "SelectStmt" in stmt ? stmt.SelectStmt.targetList?.[0] : undefined
  const value =
    target !== undefined && "ResTarget" in target
      ? target.ResTarget.val
      : undefined
  return value !== undefined && "TypeCast" in value
    ? value.TypeCast.typeName
    : undefined
}

/**
 * Повністю кваліфікований текст типу, незалежний від `search_path`:
 * некваліфіковане ім'я — вбудований тип (див. `typeOf`), модифікатори —
 * числами в загальній формі `ім'я(m, …)`, яку приймає `typmodin` кожного
 * типу (`interval day` дає `pg_catalog."interval"(8)`). `SETOF`, `%TYPE` і
 * нечисловий модифікатор — `undefined`.
 */
function renderType(typeName: TypeName | undefined): string | undefined {
  if (
    typeName === undefined ||
    typeName.setof === true ||
    typeName.pct_type === true
  )
    return undefined
  const names = stringsOf(typeName.names)
  const mods = modsOf(typeName)
  if (names.length === 0 || mods === undefined) return undefined
  const qualified = names.length === 1 ? ["pg_catalog", names[0]!] : names
  return (
    qualified.map(quoteIdent).join(".") +
    (mods.length > 0 ? `(${mods.join(",")})` : "") +
    "[]".repeat(typeName.arrayBounds?.length ?? 0)
  )
}

/** Причини, з яких сторожа не побудувати (платформна спека §6.6). */
export type GuardProblem = "using" | "oldType" | "newType" | "composite"

/** Одна зміна типу колонки в кроці. */
export interface TypeChange {
  step: string
  schema: string
  table: string
  column: string
  /** Повністю кваліфіковані тексти типів. */
  from: string
  to: string
  /** Перехід із переліку без втрат: сторож не потрібен. */
  lossless: boolean
}

interface Inspection {
  changes: TypeChange[]
  problem: GuardProblem | undefined
}

const findTable = (
  tables: readonly CatalogTable[],
  schema: string | undefined,
  name: string
): CatalogTable | undefined =>
  tables.find(
    (t) => t.name === name && (schema === undefined || t.schema === schema)
  )

/**
 * Зміни типу колонок у кроці. Таблиця й новий тип — з дерева кроку, старий
 * тип — з моделі вихідного стану: оператор його не несе.
 */
function inspect(
  step: Pick<PlanStep, "id" | "sql">,
  source: CatalogModel,
  parse: SqlParser
): Inspection {
  const result = parse(step.sql)
  // Нерозібраний крок план відмовляє раніше (`plan.unparsable-step`)
  if (!result.ok)
    throw new Error(`plan step ${step.id} does not parse: ${result.message}`)
  const changes: TypeChange[] = []
  for (const { stmt } of result.statements) {
    if (!("AlterTableStmt" in stmt)) continue
    const { relation, cmds, objtype } = stmt.AlterTableStmt
    for (const node of cmds ?? []) {
      if (
        !("AlterTableCmd" in node) ||
        node.AlterTableCmd.subtype !== "AT_AlterColumnType"
      )
        continue
      // `ALTER TYPE … ALTER ATTRIBUTE … TYPE` змінює всі типізовані таблиці
      // одразу, а модель їх не зв'язує з типом
      if (objtype === "OBJECT_TYPE") return { changes, problem: "composite" }
      const change = columnChange(
        step.id,
        relation?.schemaname,
        relation?.relname,
        node.AlterTableCmd,
        source,
        parse
      )
      if ("problem" in change) return { changes, problem: change.problem }
      changes.push(change)
    }
  }
  return { changes, problem: undefined }
}

function columnChange(
  step: string,
  schema: string | undefined,
  relname: string | undefined,
  cmd: AlterTableCmd,
  source: CatalogModel,
  parse: SqlParser
): TypeChange | { problem: GuardProblem } {
  const def =
    cmd.def !== undefined && "ColumnDef" in cmd.def
      ? cmd.def.ColumnDef
      : undefined
  const column = cmd.name
  const table =
    relname === undefined
      ? undefined
      : findTable(source.tables, schema, relname)
  const fromType =
    table === undefined || column === undefined
      ? undefined
      : table.columns.find((c) => c.name === column)?.type
  const fromTree =
    fromType === undefined ? undefined : parseType(fromType, parse)
  const from = renderType(fromTree)
  if (table === undefined || column === undefined || from === undefined)
    return { problem: "oldType" }
  const to = renderType(def?.typeName)
  if (to === undefined) return { problem: "newType" }
  // Сторож перевіряє рівно `<колонка>::<новий>`: інший вираз `USING` він
  // не відтворює, тож і збереження значень не доводить
  if (!isPlainUsing(def?.raw_default, column, to)) return { problem: "using" }
  const fromColumnType = typeOf(fromTree)
  const toType = typeOf(def?.typeName)
  return {
    step,
    schema: table.schema,
    table: table.name,
    column,
    from,
    to,
    lossless:
      fromColumnType !== undefined &&
      toType !== undefined &&
      isLossless(fromColumnType, toType),
  }
}

/**
 * `USING` відсутній або рівно `<та сама колонка>::<новий тип>`; типи
 * порівнюються в кваліфікованому тексті, тож і масиви теж.
 */
function isPlainUsing(
  using: Node | undefined,
  column: string,
  to: string
): boolean {
  if (using === undefined) return true
  if (!("TypeCast" in using)) return false
  const { arg, typeName } = using.TypeCast
  if (arg === undefined || !("ColumnRef" in arg)) return false
  const fields = arg.ColumnRef.fields ?? []
  return (
    fields.length === 1 &&
    stringsOf(fields)[0] === column &&
    renderType(typeName) === to
  )
}

const qualifiedTable = (schema: string, table: string): string =>
  `${quoteIdent(schema)}.${quoteIdent(table)}`

/**
 * SQL сторожа однієї колонки. Без `ONLY`: `ALTER TABLE` без `ONLY` рекурсує
 * в партиції й нащадків, тож сторож бачить і їхні рядки.
 */
function guardSql(change: TypeChange): string {
  const column = quoteIdent(change.column)
  return `SELECT count(*) AS lost FROM ${qualifiedTable(change.schema, change.table)} WHERE ${column} IS NOT NULL AND (${column}::${change.to})::${change.from} IS DISTINCT FROM ${column}`
}

/**
 * Сторожі кроку разом зі змінами типу, з яких їх побудовано (зокрема без
 * втрат — їх теж питає детектор залежних): один розбір кроку на обидва.
 */
export type GuardResult =
  { guards: string[]; changes: TypeChange[] } | { refusal: EngineDiagnostic }

/**
 * Сторожі звуження типу кроку (платформна спека §6.6): кожна зміна типу
 * колонки поза переліком без втрат дає запит, що рахує значення, які
 * приведення туди й назад не зберігає. Явне приведення до `varchar(n)`
 * обрізає мовчки, тож без сторожа дозвіл на `destructive` означав би «обріж»,
 * а не «може впасти на даних».
 */
export function typeGuards(
  step: Pick<PlanStep, "id" | "sql">,
  source: CatalogModel,
  parse: SqlParser
): GuardResult {
  const { changes, problem } = inspect(step, source, parse)
  if (problem !== undefined)
    return {
      refusal: applyDiagnostic("plan.type-guard-unsupported", "error", {
        step: step.id,
        reason: problem,
      }),
    }
  return { guards: changes.filter((c) => !c.lossless).map(guardSql), changes }
}

/**
 * Таблиця й колонка сторожа — для діагностики раннера. Сторож будує лише
 * `guardSql`, тож форма дерева відома; чужа форма — дефект артефакту.
 */
export function guardTarget(
  sql: string,
  parse: SqlParser
): { table: string; column: string } {
  const result = parse(sql)
  const stmt = result.ok ? result.statements[0]?.stmt : undefined
  const select =
    stmt !== undefined && "SelectStmt" in stmt ? stmt.SelectStmt : undefined
  const from = select?.fromClause?.[0]
  const where = select?.whereClause
  const test =
    where !== undefined && "BoolExpr" in where
      ? where.BoolExpr.args?.[0]
      : undefined
  const arg =
    test !== undefined && "NullTest" in test ? test.NullTest.arg : undefined
  if (
    from === undefined ||
    !("RangeVar" in from) ||
    arg === undefined ||
    !("ColumnRef" in arg)
  )
    throw new Error(`not a type guard: ${sql}`)
  const { schemaname, relname } = from.RangeVar
  return {
    table: [schemaname, relname].filter((n) => n !== undefined).join("."),
    column: stringsOf(arg.ColumnRef.fields).join("."),
  }
}

/**
 * SQLSTATE, якими аналіз виразу сторожа каже «оператора чи приведення для
 * цих типів немає», і причина відмови для кожного: `42883` — немає
 * оператора (рівності), `42846` — немає приведення. Один перелік для
 * сторожа зміни типу й сторожа приведення кроку даних: на цих кодах той
 * бере текстову форму (спека промоції §7.2), а решта — не про пару типів.
 */
export const GUARD_PAIR_SQLSTATES: ReadonlyMap<string, "equality" | "cast"> =
  new Map([
    ["42883", "equality"],
    ["42846", "cast"],
  ])

/** Ім'я підготовленого оператора проби; префікс платформи — щоб не зачепити чужого. */
const probeName = (index: number): string => `simetra_guard_probe_${index}`

/**
 * Обидва приведення сторожа й рівність старого типу на копії (платформна
 * спека §6.6): `PREPARE` з параметром старого типу лише розбирає й аналізує вираз
 * сторожа, нічого не обчислюючи, тож `NOT NULL` домену, на якому падала б
 * NULL-константа, відмови не дає. Пара без приведення (`42846`) чи старий тип
 * без оператора рівності (`42883`, `json`) інакше впали б лише в раннері, на
 * цілі. Точка збереження — щоб одна невдала пара не обірвала решту.
 * Підготовлений оператор живе в сесії поза транзакцією, тож `DEALLOCATE`
 * обов'язковий: відкат його не прибирає.
 */
export async function checkGuardCasts(
  tx: ApplyTransaction,
  casts: readonly { step: string; from: string; to: string }[]
): Promise<EngineDiagnostic[]> {
  const out: EngineDiagnostic[] = []
  for (const [index, cast] of casts.entries()) {
    const name = probeName(index)
    await tx.query("SAVEPOINT simetra_guard_cast")
    try {
      await tx.query(
        `PREPARE ${name}(${cast.from}) AS SELECT (($1::${cast.to})::${cast.from}) IS DISTINCT FROM $1`
      )
    } catch (error) {
      // Лише «для пари типів немає оператора чи приведення» — відмова; решта
      // (тайм-аут, повторюваний збій, права) летить як є, а не стає «cast»
      const reason =
        error instanceof ApplyDbError
          ? GUARD_PAIR_SQLSTATES.get(error.sqlstate ?? "")
          : undefined
      if (reason === undefined) throw error
      await tx.query("ROLLBACK TO SAVEPOINT simetra_guard_cast")
      out.push(
        applyDiagnostic("plan.type-guard-unsupported", "error", {
          step: cast.step,
          // Без рівності сторож не порівняє значення, хоч приведення й є:
          // порада тут інша, ніж для пари без приведення
          reason,
        })
      )
      continue
    }
    await tx.query(`DEALLOCATE ${name}`)
    await tx.query("RELEASE SAVEPOINT simetra_guard_cast")
  }
  return out
}

/** Об'єкт, що залежить від колонки зі зміною типу. */
export interface TypeChangeDependent {
  /** Крок зміни типу колонки. */
  step: string
  kind: "trigger" | "function" | "procedure"
  schema: string
  /** Таблиця тригера; у функції її немає. */
  table?: string
  name: string
  /** Текст для відмови: `trigger app.t.name`, `function app.f(args)`. */
  text: string
}

/**
 * Тригери (`WHEN`, `UPDATE OF`) і SQL-функції з тілом `BEGIN ATOMIC`, що
 * залежать від колонок зі зміною типу (платформна спека §6.6): двигун їх не перебудовує,
 * і `ALTER … TYPE` падає. Залежність колонки — `pg_depend` з `refobjsubid` =
 * `attnum`; колонки нащадків і партицій — теж, бо `ALTER TABLE` без `ONLY`
 * рекурсує в них.
 */
export async function readTypeChangeDependents(
  tx: ApplyTransaction,
  columns: readonly {
    step: string
    schema: string
    table: string
    column: string
  }[]
): Promise<TypeChangeDependent[]> {
  if (columns.length === 0) return []
  const rows = await tx.query<{
    step: string
    kind: TypeChangeDependent["kind"]
    schema: string
    table: string | null
    name: string
    text: string
  }>(
    `WITH RECURSIVE input AS (
       SELECT i.step, c.oid AS relid, i."column"
       FROM jsonb_to_recordset($1::jsonb) AS i(step text, "schema" text, "table" text, "column" text)
       JOIN pg_catalog.pg_namespace n ON n.nspname = i."schema"
       JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = i."table"
     ), rel AS (
       SELECT step, relid, "column" FROM input
       UNION
       SELECT rel.step, h.inhrelid, rel."column"
       FROM rel JOIN pg_catalog.pg_inherits h ON h.inhparent = rel.relid
     ), col AS (
       SELECT rel.step, a.attrelid, a.attnum
       FROM rel JOIN pg_catalog.pg_attribute a
         ON a.attrelid = rel.relid AND a.attname = rel."column" AND NOT a.attisdropped
     )
     SELECT DISTINCT col.step, 'trigger' AS kind, n.nspname AS "schema", c.relname AS "table", t.tgname AS name,
       format('trigger %s.%s.%s', quote_ident(n.nspname), quote_ident(c.relname), quote_ident(t.tgname)) AS text
     FROM col
     JOIN pg_catalog.pg_depend d
       ON d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = col.attrelid AND d.refobjsubid = col.attnum
       AND d.classid = 'pg_catalog.pg_trigger'::regclass
     JOIN pg_catalog.pg_trigger t ON t.oid = d.objid
     JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     UNION
     SELECT DISTINCT col.step, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, n.nspname, NULL, p.proname,
       format('%s %s.%s(%s)', CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, quote_ident(n.nspname), quote_ident(p.proname), pg_catalog.pg_get_function_identity_arguments(p.oid))
     FROM col
     JOIN pg_catalog.pg_depend d
       ON d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = col.attrelid AND d.refobjsubid = col.attnum
       AND d.classid = 'pg_catalog.pg_proc'::regclass
     JOIN pg_catalog.pg_proc p ON p.oid = d.objid AND p.prosqlbody IS NOT NULL
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace`,
    [
      JSON.stringify(
        columns.map(({ step, schema, table, column }) => ({
          step,
          schema,
          table,
          column,
        }))
      ),
    ]
  )
  return rows.map(({ table, ...row }) =>
    table === null ? row : { ...row, table }
  )
}

/**
 * Залежний об'єкт, який крок, що стоїть строго до кроку зміни типу, уже
 * знімає: на момент `ALTER … TYPE` його немає, а пізніше відтворення
 * компілюється вже під новий тип. Лише точна ідентичність і лише тригер:
 * ідентичність функції двигуна не несе сигнатури, тож знята перевантажена
 * функція могла бути іншою — така лишається відмовою.
 */
function droppedBefore(
  dependent: TypeChangeDependent,
  steps: readonly Pick<PlanStep, "id" | "destroyed">[]
): boolean {
  if (dependent.kind !== "trigger") return false
  const at = steps.findIndex((s) => s.id === dependent.step)
  return steps
    .slice(0, Math.max(at, 0))
    .some((s) =>
      s.destroyed.some(
        (d) =>
          d.kind === "trigger" &&
          d.schema === dependent.schema &&
          d.table === dependent.table &&
          d.name === dependent.name
      )
    )
}

/**
 * Відмови плану зі змінами типу, що їх видно лише на базі (платформна спека §6.6):
 * залежні тригери й функції `BEGIN ATOMIC`, яких попередні кроки плану не
 * знімають, і пари типів, яким сторожа не виконати. `tx` — транзакція на
 * копії: план без промоції питає копію доказу до прогону, план із
 * промоцією — копію після наміру. `steps` — кроки плану в порядку виконання.
 */
export async function typeChangeRefusals(
  tx: ApplyTransaction,
  changes: readonly TypeChange[],
  steps: readonly Pick<PlanStep, "id" | "destroyed">[]
): Promise<EngineDiagnostic[]> {
  if (changes.length === 0) return []
  const blocking = (await readTypeChangeDependents(tx, changes))
    .filter((d) => !droppedBefore(d, steps))
    .map((d) => d.text)
  // Порядок кодових одиниць, а не колації бази: текст відмови детермінований
  const dependents = [...new Set(blocking)].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  )
  const casts = await checkGuardCasts(
    tx,
    changes.filter((c) => !c.lossless)
  )
  return [
    ...(dependents.length > 0
      ? [
          applyDiagnostic("plan.type-change-dependent", "error", {
            objects: dependents.join(", "),
          }),
        ]
      : []),
    ...casts,
  ]
}
