import type { Node } from "libpg-query"
import {
  KIND_REGISTRY,
  PROVIDER_EVENT_SOURCES,
  standardLogicalName,
  type MetadataRef,
  type StandardColumnDef,
} from "simetra/model"
import type { CompiledModel } from "../../compile"
import { standardRefTargets, standardTargetRefs } from "../../stages/model"
import {
  compareStrings,
  diagnostic,
  toPointer,
  type Diagnostic,
} from "../../diagnostics"
import { closedShellProblem, firstDynamicSqlLine } from "../../sql/closed-forms"
import { queryFunctionShape } from "../../sql/query-shape"
import {
  textCalls,
  unitCalls,
  unitRelations,
  unitTypes,
  type ReferencedName,
} from "../../sql/dependencies"
import { relationNameText, type SqlParser } from "../../sql/parse"
import type { PlpgsqlParser } from "../../sql/plpgsql"
import { rewriteFunction } from "../../sql/rewrite/function"
import {
  applyEdits,
  type RenameMap,
  type TableRename,
  type TextEdit,
} from "../../sql/rewrite/renames"
import {
  unitSubjectKeys,
  unitTargets,
  type UnitTarget,
} from "../../sql/unit-target"
import {
  functionIdentity,
  readSqlUnits,
  statementPositions,
  type SqlUnit,
} from "../../sql/units"
import type { PromoteInput } from "../inputs"
import { cut, mergeDeletions } from "../text-edits"
import type { QualifiedTable } from "./gates"
import type { ConversionSubject } from "./mapping"
import type { PromotionRecord } from "./record"

/** Дослівна одиниця моделі: місце у файлі в неї є завжди. */
export type FileUnit = SqlUnit & { file: string; line: number }

/** Таблиця одиниці промоції до промоції: об'єкт і фізичне ім'я. */
export interface UnitSqlTable extends QualifiedTable {
  objectId: string
}

/** Предмет класу конверсії — SQL-одиниця з рядком у файлі. */
export type UnitSubject = ConversionSubject & { line: number }

/**
 * Доля SQL-одиниць промоції (спека промоції §6, §7.1): класифіковані знімаються
 * (`removed`), функції в закритій оболонці з модуля переїжджають (`moved`),
 * `candidates` — надмножинний відбір функцій для переписувача (обсяг
 * правок визначає його резолв). `bindings` — таблиці, до яких тригери й
 * підписки прив'язують функцію до промоції, за ідентичністю функції.
 */
export interface UnitPlan {
  removed: FileUnit[]
  /**
   * `to` — фінальне місце; `staged` — місце функції-запиту на проміжній
   * компіляції (`sql/<схема>/<ім'я>.sql`): зі старими іменами в модулі виду
   * її судив би суддя голів, а виправляє імена лише переписувач.
   */
  moved: { unit: FileUnit; to: string; staged?: string }[]
  candidates: FileUnit[]
  subjects: UnitSubject[]
  problems: Diagnostic[]
  /**
   * Функції з динамічним SQL поза кандидатами (`rewrite.dynamic-sql-unscoped`):
   * межа статичного аналізу, не відмова; `line` — рядок першого динамічного
   * оператора у файлі до промоції.
   */
  unscoped: { unit: FileUnit; line: number }[]
  bindings: ReadonlyMap<string, readonly QualifiedTable[]>
}

/** Контекст планування: парсери й шлях закритого модуля виду. */
export interface PlanContext {
  parse: SqlParser
  plpgsql: PlpgsqlParser
  /** `<тека виду>/<Ім'я>/<Ім'я>.sql` нового об'єкта. */
  kindModule: string
}

const key = (schema: string, name: string) => `${schema}.${name}`

const isFileUnit = (unit: SqlUnit): unit is FileUnit =>
  unit.file !== undefined && unit.line !== undefined

/** Класи, тіла яких переписує переписувач, а не відмова тексту боргу. */
const REWRITTEN_CLASSES: ReadonlySet<string> = new Set([
  "function",
  "procedure",
])

/** Цілі, що називають таблицю (а не функцію, схему чи publication). */
const TABLE_TARGETS: ReadonlySet<UnitTarget["kind"]> = new Set([
  "table",
  "column",
  "policy",
  "trigger",
  "other",
])

/** Ім'я як слово без урахування регістру: лише відбір кандидатів (спека промоції §6). */
function wordPattern(names: readonly string[]): RegExp {
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return new RegExp(`(?<![\\w$])(?:${escaped.join("|")})(?![\\w$])`, "i")
}

/**
 * Класифікація SQL-одиниць промотованих таблиць (спека
 * промоції §6, §7.1). Модуль прийнятої таблиці йде цілком: функція в
 * закритій оболонці у формі функції-запиту переїжджає в модуль виду, а інша
 * чи названа в `sharedFunctions` — у `sql/<схема>/<ім'я>.sql`; решта його одиниць
 * потребує класу. Одиниця деінде з ціллю — промотованою таблицею — теж
 * потребує класу; ціль упереміш з іншими об'єктами класом не знімається
 * (зняття зачепило б чуже) — це текст боргу. Не-функція деінде, що за
 * резолвом залежностей читає промотовану таблицю, — `promote.debt-text-reference`:
 * її текст не йде за промоцією, доки П3 не вміє зворотного читання.
 */
export function planUnits(
  model: CompiledModel,
  input: PromoteInput,
  tables: readonly UnitSqlTable[],
  o: PlanContext
): UnitPlan {
  const promoted = new Set(tables.map((t) => key(t.schema, t.name)))
  const objectIds = new Set(tables.map((t) => t.objectId))
  const units = model.sqlUnits.filter(isFileUnit)
  const plan: UnitPlan = {
    removed: [],
    moved: [],
    candidates: [],
    subjects: [],
    problems: [],
    unscoped: [],
    bindings: bindings(model, units, o.parse),
  }
  const classify = (unit: FileUnit) => {
    // Некваліфікована ціль одиниці модуля — у схемі її таблиці.
    const ownerSchema =
      tables.find((t) => t.objectId === unit.ownerObjectId)?.schema ??
      unit.schema
    plan.subjects.push({
      subject: unit.identity,
      file: unit.file,
      pointer: "",
      required: true,
      line: unit.line,
      objects: unitSubjectKeys(unit, o.parse, ownerSchema).map((key) => ({
        kind: "unit",
        ...key,
      })),
    })
    if (input.conversions[unit.identity] !== undefined) plan.removed.push(unit)
  }
  const debtText = (unit: FileUnit) =>
    plan.problems.push(
      diagnostic("promote.debt-text-reference", unit.file, "", {
        identity: unit.identity,
        line: unit.line,
      })
    )
  const reads = (refs: readonly ReferencedName[]) =>
    refs.some((r) =>
      r.schema === undefined
        ? tables.some((t) => t.name === r.name)
        : promoted.has(key(r.schema, r.name))
    )

  const shared = new Set(input.sharedFunctions)
  const moved = new Set<string>()
  for (const unit of units) {
    if (unit.ownerObjectId !== undefined && objectIds.has(unit.ownerObjectId)) {
      const closed =
        unit.class === "function" &&
        closedShellProblem(
          { tree: unit.tree as Node, sql: unit.sql },
          o.plpgsql
        ) === undefined
      if (!closed) {
        classify(unit)
        continue
      }
      moved.add(unit.identity)
      // Функцію модуля виду судять як голову (спека промоції §9.4): туди йде лише
      // функція-запит, решта закритих — у спільний файл, як `sharedFunctions`.
      const query =
        !shared.has(unit.identity) &&
        queryFunctionShape(unit, units, o.parse) === undefined
      const sharedFile = `sql/${unit.schema}/${unit.name}.sql`
      plan.moved.push(
        query
          ? { unit, to: o.kindModule, staged: sharedFile }
          : { unit, to: sharedFile }
      )
      continue
    }
    const targets = targetsOf(unit, o.parse)
    const touching = targets.filter(
      (t) =>
        TABLE_TARGETS.has(t.kind) &&
        t.object !== undefined &&
        promoted.has(key(t.schema, t.object))
    )
    if (touching.length > 0) {
      if (touching.length === targets.length) classify(unit)
      else debtText(unit)
      continue
    }
    if (
      !REWRITTEN_CLASSES.has(unit.class) &&
      (reads([...unitRelations(unit, o.parse), ...unitTypes(unit, o.parse)]) ||
        namesInText(unit.tree, tables))
    ) {
      debtText(unit)
    }
  }
  input.sharedFunctions.forEach((identity, i) => {
    if (moved.has(identity)) return
    plan.problems.push(
      diagnostic("promote.mapping-unknown", "", "", {
        at: toPointer(["sharedFunctions", String(i)]),
        detail:
          "it names no function in the closed shell of a module of the promoted tables",
      })
    )
  })

  // Кандидати — надмножина: переїжджає з модуля, прив'язана до промотованої
  // таблиці чи згадує її старе ім'я словом. Резолв переписувача вирішує, чи
  // є що правити.
  const removed = new Set(plan.removed.map((u) => u.identity))
  const word = wordPattern(tables.map((t) => t.name))
  for (const unit of units) {
    if (!REWRITTEN_CLASSES.has(unit.class) || removed.has(unit.identity)) {
      continue
    }
    const bound = (plan.bindings.get(unit.identity) ?? []).some((t) =>
      promoted.has(key(t.schema, t.name))
    )
    if (moved.has(unit.identity) || bound || word.test(unit.sql)) {
      plan.candidates.push(unit)
      continue
    }
    // Динамічний SQL поза кандидатами — межа статичного аналізу (рішення
    // 13): ім'я таблиці, зібране з частин, слово не знайде.
    const line = firstDynamicSqlLine(
      { tree: unit.tree as Node, sql: unit.sql },
      unit.line,
      o.plpgsql
    )
    if (line !== undefined) plan.unscoped.push({ unit, line })
  }
  return plan
}

/**
 * Рядок одиниці називає промотовану таблицю (`to_regclass('app.t')`,
 * неявний `regclass`-аргумент, аргумент тригера). Postgres резолвить таке
 * ім'я під час виконання, а текст боргу за промоцією не йде: мовчки
 * лишений, він повернув би `NULL` чи впав би вже після перейменування.
 * Ребра порядку створення такий рядок не дає, тож це окремий прохід, а не
 * посилання `dependencies.ts`.
 */
function namesInText(
  tree: unknown,
  tables: readonly QualifiedTable[]
): boolean {
  const names = (text: string) => {
    const parts = relationNameText(text)
    if (parts === undefined || parts.length > 3) return false
    const relname = parts.at(-1)
    const schema = parts.length >= 2 ? parts.at(-2) : undefined
    return tables.some(
      (t) => t.name === relname && (schema === undefined || t.schema === schema)
    )
  }
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit)
    if (typeof value !== "object" || value === null) return false
    const node = value as Record<string, unknown>
    const constant = node.A_Const as { sval?: { sval?: unknown } } | undefined
    const text = constant?.sval?.sval
    if (typeof text === "string" && names(text)) return true
    // Аргументи тригера — рядки без `A_Const`: функція читає їх як `TG_ARGV`.
    const trigger = node.CreateTrigStmt as { args?: unknown[] } | undefined
    for (const arg of trigger?.args ?? []) {
      const sval = (arg as { String?: { sval?: unknown } }).String?.sval
      if (typeof sval === "string" && names(sval)) return true
    }
    return Object.values(node).some(visit)
  }
  return visit(tree)
}

/** Цілі одиниці; `REPLICA IDENTITY` — ціль-таблиця самої одиниці. */
function targetsOf(unit: FileUnit, parse: SqlParser): UnitTarget[] {
  if (unit.class === "replicaIdentity") {
    return [{ schema: unit.schema, object: unit.name, kind: "table" }]
  }
  return unitTargets(unit, parse)
}

/**
 * Прив'язки функцій до таблиць до промоції (спека промоції §6): `CREATE TRIGGER`
 * (некваліфіковані імена — у схемі одиниці, як `unitTargets`) і джерела
 * підписок `EventSubscription` за їхнім обробником.
 */
function bindings(
  model: CompiledModel,
  units: readonly FileUnit[],
  parse: SqlParser
): Map<string, QualifiedTable[]> {
  const found = new Map<string, QualifiedTable[]>()
  const bind = (identity: string, table: QualifiedTable) => {
    const list = found.get(identity) ?? []
    if (!list.some((t) => t.schema === table.schema && t.name === table.name)) {
      list.push(table)
    }
    found.set(identity, list)
  }
  for (const unit of units) {
    const trigger = (unit.tree as { CreateTrigStmt?: Record<string, unknown> })
      .CreateTrigStmt
    if (trigger === undefined) continue
    const names = ((trigger.funcname ?? []) as Node[]).map((n) =>
      "String" in n ? (n.String.sval ?? "") : ""
    )
    const [target] = unitTargets(unit, parse)
    if (target?.object === undefined) continue
    bind(
      functionIdentity(names.at(-2) ?? unit.schema, names.at(-1) ?? "", []),
      { schema: target.schema, name: target.object }
    )
  }
  for (const object of model.objects) {
    const spec = KIND_REGISTRY[object.kind].subscription?.(object.data)
    if (spec === undefined) continue
    const identity = functionIdentity(
      spec.handler.schema ?? model.project.defaultSchema,
      spec.handler.name,
      []
    )
    for (const source of spec.sources) {
      if ("providerTable" in source) {
        bind(identity, {
          schema: source.providerTable.schema,
          name: source.providerTable.table,
        })
        continue
      }
      const table = mainTable(model, source.ref)
      if (table !== undefined) bind(identity, table)
    }
  }
  return found
}

function mainTable(
  model: CompiledModel,
  ref: MetadataRef
): QualifiedTable | undefined {
  const object = model.objects.find(
    (o) => o.kind === ref.kind && o.name === ref.name
  )
  const table = model.physical.tables.find(
    ({ origin }) =>
      origin.objectId === object?.id &&
      origin.part === undefined &&
      origin.tabularSectionId === undefined
  )
  return table === undefined
    ? undefined
    : { schema: table.schema, name: table.name }
}

/**
 * Мапа перейменувань переписувача (спека промоції §6) із запису промоції над
 * моделлю результату: `knownTables` — кожна таблиця моделі до промоції й
 * таблиці провайдера з колонками, які знає модель (джерела подій);
 * `columnsAfter` — колонки таблиці після промоції, разом із доданими видом.
 */
export function renameMap(
  before: CompiledModel,
  after: CompiledModel,
  record: Pick<PromotionRecord, "tables" | "columns">
): RenameMap {
  const knownTables = new Map<string, readonly string[]>()
  for (const t of PROVIDER_EVENT_SOURCES[before.project.database.provider]) {
    knownTables.set(key(t.schema, t.table), t.columns)
  }
  for (const t of before.physical.tables) {
    knownTables.set(
      key(t.schema, t.name),
      t.columns.map((c) => c.name)
    )
  }
  const tables: TableRename[] = record.tables.map((t) => {
    const now = after.physical.tables.find(
      (x) => x.schema === t.schema && x.name === t.to
    )
    if (now === undefined) throw new Error(`no table ${t.schema}.${t.to}`)
    return {
      schema: t.schema,
      from: t.from,
      to: t.to,
      columns: new Map(
        record.columns
          .filter((c) => c.schema === t.schema && c.table === t.to)
          .filter((c) => c.from !== c.to)
          .map((c) => [c.from, c.to])
      ),
      columnsAfter: new Set(now.columns.map((c) => c.name)),
    }
  })
  return { tables, knownTables }
}

/** Знахідки переписування кандидатів. */
export interface CandidateRewrite {
  /** Переписаний текст за ідентичністю — лише одиниці, що змінились. */
  texts: Map<string, string>
  problems: Diagnostic[]
  /** Зміни контракту з рядком і колонкою відносно тексту одиниці. */
  changes: {
    unit: FileUnit
    line: number
    column: number
    reason: string
    detail: string
  }[]
}

/**
 * Переписує кандидатів (спека промоції §6). Прив'язана таблиця, яку промоція
 * не зачіпає, іде тотожним перейменуванням: тоді `NEW.x` зі змішаною
 * прив'язкою відмовляє, а не переписується за однією з таблиць. Проблема —
 * діагностика у файлі одиниці з абсолютним рядком.
 */
export function rewriteCandidates(
  plan: UnitPlan,
  map: RenameMap,
  labels: readonly string[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): CandidateRewrite {
  const result: CandidateRewrite = {
    texts: new Map(),
    problems: [],
    changes: [],
  }
  for (const unit of plan.candidates) {
    const bound = plan.bindings.get(unit.identity)
    const triggerTables = bound?.map(
      (table): TableRename =>
        map.tables.find(
          (t) => t.schema === table.schema && t.from === table.name
        ) ?? {
          schema: table.schema,
          from: table.name,
          to: table.name,
          columns: new Map(),
          columnsAfter: new Set(
            map.knownTables.get(key(table.schema, table.name)) ?? []
          ),
        }
    )
    const rewritten = rewriteFunction(unit.sql, {
      parse,
      plpgsql,
      map,
      triggerTables,
      labels,
    })
    for (const p of rewritten.problems) {
      result.problems.push(
        diagnostic(p.code, unit.file, "", {
          function: unit.identity,
          line: unit.line + p.line - 1,
          column: p.column,
          detail: p.detail,
        })
      )
    }
    if (rewritten.problems.length > 0) continue
    if (rewritten.sql !== unit.sql)
      result.texts.set(unit.identity, rewritten.sql)
    for (const c of rewritten.contractChanges) {
      result.changes.push({ unit, ...c })
    }
  }
  return result
}

/** Де одиниця лежить після промоції: файл і рядок першого токена. */
export interface Placement {
  file: string
  line: number
}

/**
 * Тексти SQL-файлів після промоції: класифіковані одиниці вирізано разом із
 * завершальним `;` і порожнім рядком після, переписані — замінено на місці,
 * переїжджі — дописано в модуль виду чи спільний файл. Файли, що зникають
 * разом із прийнятими таблицями (`deleted`), не правляться; файл, у якому
 * лишились самі пробіли, видаляється (`undefined`). `placements` — де після
 * цього лежить кожна одиниця з `track` і кожна переїжджа.
 */
export function sqlFileTexts(
  files: ReadonlyMap<string, string>,
  plan: UnitPlan,
  texts: ReadonlyMap<string, string>,
  deleted: ReadonlySet<string>,
  parse: SqlParser,
  track: readonly FileUnit[] = [],
  staged = false
): {
  files: Map<string, string | undefined>
  placements: Map<string, Placement>
  problems: Diagnostic[]
} {
  const textOf = (unit: FileUnit) => texts.get(unit.identity) ?? unit.sql
  const problems: Diagnostic[] = []
  const conflict = (file: string, detail: string) =>
    problems.push(
      diagnostic("promote.text-conflict", file, "", { file, detail })
    )
  const positions = new Map<string, ReturnType<typeof statementPositions>>()
  const unitStart = (text: string, unit: FileUnit): number | undefined => {
    let list = positions.get(unit.file)
    if (list === undefined) {
      list = statementPositions(text, parse)
      positions.set(unit.file, list)
    }
    const found = list.find(
      (p) => p.line === unit.line && text.slice(p.start, p.end) === unit.sql
    )
    // Одиницю дав розбір цього ж тексту: розбіжність — гучна відмова, а не
    // виняток на вводі автора.
    if (found === undefined) {
      conflict(unit.file, `${unit.identity} is not found at line ${unit.line}`)
    }
    return found?.start
  }
  const edits = new Map<string, TextEdit[]>()
  const edit = (file: string, e: TextEdit) =>
    edits.set(file, [...(edits.get(file) ?? []), e])
  const movedIds = new Set(plan.moved.map((m) => m.unit.identity))
  for (const unit of plan.removed) {
    if (deleted.has(unit.file)) continue
    const text = files.get(unit.file)!
    const start = unitStart(text, unit)
    if (start === undefined) continue
    edit(unit.file, cut(text, start, start + unit.sql.length))
  }
  for (const unit of plan.candidates) {
    const replaced = texts.get(unit.identity)
    if (replaced === undefined) continue
    if (movedIds.has(unit.identity) || deleted.has(unit.file)) continue
    const text = files.get(unit.file)!
    const start = unitStart(text, unit)
    if (start === undefined) continue
    edit(unit.file, { start, end: start + unit.sql.length, text: replaced })
  }

  const result = new Map<string, string | undefined>()
  for (const [file, list] of edits) {
    const merged = mergeDeletions(files.get(file)!, list)
    const overlap = merged.findIndex(
      (e, i) => i > 0 && e.start < merged[i - 1]!.end
    )
    if (overlap > 0) {
      conflict(
        file,
        `edits [${merged[overlap - 1]!.start}, ${merged[overlap - 1]!.end}) and [${merged[overlap]!.start}, ${merged[overlap]!.end}) overlap`
      )
      continue
    }
    edits.set(file, merged)
    const text = applyEdits(files.get(file)!, merged)
    result.set(file, text.trim() === "" ? undefined : text)
  }
  const placements = new Map<string, Placement>()
  for (const unit of track) {
    if (movedIds.has(unit.identity) || deleted.has(unit.file)) continue
    const list = edits.get(unit.file) ?? []
    const start = unitStart(files.get(unit.file)!, unit)
    if (start === undefined) continue
    // Правки до початку одиниці зсувають її на різницю довжин.
    const shift = list
      .filter((e) => e.end <= start)
      .reduce((sum, e) => sum + e.text.length - (e.end - e.start), 0)
    const text = result.get(unit.file) ?? files.get(unit.file)!
    placements.set(unit.identity, {
      file: unit.file,
      line: lineAt(text, start + shift),
    })
  }

  // Переїжджі — у порядку файлу й рядка, кожна з `;` і порожнім рядком між ними.
  // Проміжний текст кладе функцію-запит у спільний файл (`staged`), а
  // фінальний — у модуль виду й прибирає проміжний файл.
  const byTarget = new Map<string, FileUnit[]>()
  for (const move of plan.moved) {
    const to = staged ? (move.staged ?? move.to) : move.to
    byTarget.set(to, [...(byTarget.get(to) ?? []), move.unit])
    if (!staged && move.staged !== undefined && !files.has(move.staged)) {
      result.set(move.staged, undefined)
    }
  }
  for (const [to, list] of byTarget) {
    list.sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line)
    const base = result.has(to)
      ? (result.get(to) ?? "")
      : deleted.has(to)
        ? ""
        : (files.get(to) ?? "")
    let out = base.trim() === "" ? "" : `${base.trimEnd()}\n\n`
    list.forEach((unit, i) => {
      if (i > 0) out += "\n"
      placements.set(unit.identity, { file: to, line: lineAt(out, out.length) })
      out += `${textOf(unit)};\n`
    })
    result.set(to, out)
  }
  return { files: result, placements, problems }
}

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i++) if (text[i] === "\n") line++
  return line
}

/**
 * Ідентичність переписаної одиниці: тип рядка промотованої таблиці в
 * аргументах змінює її (ідентичність несе типи аргументів).
 */
export function rewrittenIdentity(
  unit: FileUnit,
  sql: string,
  parse: SqlParser,
  known: readonly QualifiedTable[]
): string {
  const read = readSqlUnits(
    [{ file: unit.file, text: sql, schema: unit.schema }],
    parse,
    known
  )
  return read.units[0]?.identity ?? unit.identity
}

/**
 * Функції-викликачі, яких транзитивно зачіпає зміна сигнатури (спека промоції §6):
 * `RETURNS SETOF`/`%ROWTYPE` промотованої таблиці міняє форму результату
 * для кожного, хто кличе функцію. `via` — ланцюжок від викликача до
 * функції, чия сигнатура змінилась. Некваліфікований виклик збігається з
 * однойменною функцією будь-якої схеми: це попередження, і пропуск гірший
 * за зайвий рядок.
 */
export function callerChanges(
  units: readonly FileUnit[],
  origins: readonly string[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): { unit: FileUnit; via: string[] }[] {
  const functions = units.filter((u) => REWRITTEN_CLASSES.has(u.class))
  const callees = new Map(
    functions.map((u) => [u.identity, calls(u, parse, plpgsql)] as const)
  )
  const callsFunction = (caller: FileUnit, callee: FileUnit) =>
    (callees.get(caller.identity) ?? []).some(
      (c) =>
        c.name === callee.name &&
        (c.schema === undefined || c.schema === callee.schema)
    )
  const found: { unit: FileUnit; via: string[] }[] = []
  for (const origin of [...origins].sort(compareStrings)) {
    const start = functions.find((u) => u.identity === origin)
    if (start === undefined) continue
    const via = new Map<string, string[]>([[origin, []]])
    const queue: FileUnit[] = [start]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const caller of functions) {
        if (via.has(caller.identity) || !callsFunction(caller, current)) {
          continue
        }
        const chain = [current.identity, ...via.get(current.identity)!]
        via.set(caller.identity, chain)
        found.push({ unit: caller, via: chain })
        queue.push(caller)
      }
    }
  }
  return found
}

/** Виклики функції: дерево (`LANGUAGE sql`) і вирази тіла plpgsql. */
function calls(
  unit: FileUnit,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): ReferencedName[] {
  const found = unitCalls(unit, parse)
  const fn = (unit.tree as { CreateFunctionStmt?: unknown }).CreateFunctionStmt
  if (fn === undefined) return found
  const body = plpgsql(unit.sql)
  if (!body.ok || body.fn === undefined) return found
  for (const statement of body.fn.statements) {
    for (const e of statement.expressions) {
      // Режим 0 — оператор як є; 1–2 — вираз; 3–5 — присвоєння, права частина
      // після `:=`/`=` (ціль — імена, викликів не має).
      const assign = e.parseMode >= 3 ? assignedValue(e.query) : undefined
      const text = e.parseMode === 0 ? e.query : `SELECT ${assign ?? e.query}`
      found.push(...textCalls(text, parse))
    }
  }
  return found
}

function assignedValue(query: string): string {
  const i = query.indexOf(":=")
  if (i >= 0) return query.slice(i + 2)
  const j = query.indexOf("=")
  return j >= 0 ? query.slice(j + 1) : query
}

/**
 * Переклад міток споживача (спека промоції §9.11): поліморфні колонки `_type`
 * інших таблиць, ціллю пари яких є промотований об'єкт, знайдені статично
 * з моделі результату. Кроки перекладу будує П3.
 */
export function labelConsumers(
  after: CompiledModel,
  target: MetadataRef
): { schema: string; table: string; column: string }[] {
  const found = new Map<
    string,
    { schema: string; table: string; column: string }
  >()
  const add = (
    tables: CompiledModel["physical"]["tables"],
    match: (
      c: CompiledModel["physical"]["tables"][number]["columns"][number]
    ) => boolean
  ) => {
    for (const table of tables) {
      for (const column of table.columns.filter(match)) {
        const entry = {
          schema: table.schema,
          table: table.name,
          column: column.name,
        }
        found.set(`${entry.schema}.${entry.table}.${entry.column}`, entry)
      }
    }
  }
  for (const object of after.objects) {
    const def = KIND_REGISTRY[object.kind]
    const tables = after.physical.tables.filter(
      (t) => t.origin.objectId === object.id
    )
    for (const { ref, pointer, pair } of def.references(object.data)) {
      if (!pair || ref.kind !== target.kind || ref.name !== target.name) {
        continue
      }
      // Пару несе елемент, чий перелік цілей містить посилання; перелік на
      // корені об'єкта — це цілі стандартної колонки виду.
      const carrier = pointer.split("/").slice(0, -2).join("/")
      if (carrier !== "") {
        const element = at(object.data, carrier) as
          { id?: string; physicalName?: string } | undefined
        if (element?.id === undefined) continue
        add(
          tables,
          (c) =>
            c.origin.elementId === element.id &&
            c.name === `${element.physicalName}_type`
        )
        continue
      }
      for (const column of def.standardColumns(object.data)) {
        const targets = standardPairTargets(column, object.data)
        if (!targets.some((t) => t.kind === ref.kind && t.name === ref.name)) {
          continue
        }
        // `origin.standard` — ім'я в стилі проєкту результату, а не
        // канонічне camelCase визначення.
        const standard = standardLogicalName(
          column,
          after.project.naming.attributeCase
        )
        add(
          tables,
          (c) =>
            c.origin.standard === standard &&
            c.name === `${column.physicalName}_type`
        )
      }
    }
  }
  return [...found.values()].sort(
    (a, b) =>
      compareStrings(a.schema, b.schema) ||
      compareStrings(a.table, b.table) ||
      compareStrings(a.column, b.column)
  )
}

/**
 * Цілі пари стандартної колонки — з того самого джерела, з якого стадія 3
 * будує пару: перелік цілей типу (значення константи) чи цілі за `ref`
 * поліморфної колонки (власники, реєстратори). Не пара — цілей немає.
 */
function standardPairTargets(
  column: StandardColumnDef,
  data: unknown
): readonly MetadataRef[] {
  if (!("raw" in column.type) && column.type.allowedTypes !== undefined) {
    return column.type.allowedTypes
  }
  // Цілі від проєкту («Користувачі», учасник, «Ролі» рівня) парою не
  // бувають, тож тут вони не потрібні.
  return column.polymorphic !== undefined
    ? standardTargetRefs(
        column,
        data,
        standardRefTargets([], { membershipSources: [] })
      )
    : []
}

/** Значення за JSON Pointer (RFC 6901). */
function at(value: unknown, pointer: string): unknown {
  if (pointer === "") return value
  let current = value
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~")
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}
