import type { Node } from "libpg-query"
import {
  unitSubjectKeys,
  valueAt,
  type CompiledModel,
  type PromotionObject,
  type PromotionRecord,
  type SqlParser,
} from "simetra/compiler"
import {
  KIND_REGISTRY,
  type CatalogModel,
  type MetadataKind,
} from "simetra/model"
import type { EngineDiagnostic } from "../../engine"
import { applyDiagnostic } from "../diagnostic"
import type { EquivalenceObject } from "./equivalence"

/** Колонка бажаної моделі: схема, таблиця й колонка в нових іменах. */
export interface ColumnName {
  schema: string
  table: string
  column: string
}

/**
 * Колонки бажаної моделі, що є `Ref` на вид зі значеннями-елементами
 * (перерахування за М15 — `text` + `CHECK`, без таблиці й FK). Вид цілі
 * розпізнає реєстр (`valueElements`), а не ім'я виду; колонку — ідентичність
 * елемента (`origin.elementId`), а не ім'я.
 */
export function valueElementColumns(
  model: Pick<CompiledModel, "objects" | "references" | "physical">
): ColumnName[] {
  const data = new Map(model.objects.map((o) => [o.id, o.data]))
  const elements = new Set<string>()
  for (const r of model.references) {
    if (r.role !== "attribute.ref") continue
    const kind = r.to.kind
    if (
      !Object.hasOwn(KIND_REGISTRY, kind) ||
      !KIND_REGISTRY[kind as MetadataKind].valueElements
    )
      continue
    // Посилання реквізиту — `<елемент>/ref`: ідентичність несе сам елемент
    const element = valueAt(
      data.get(r.from.objectId),
      r.from.pointer.replace(/\/ref$/, "")
    ) as { id?: unknown } | undefined
    if (typeof element?.id === "string") elements.add(element.id)
  }
  return model.physical.tables.flatMap((t) =>
    t.columns
      .filter(
        (c) =>
          c.origin.elementId !== undefined && elements.has(c.origin.elementId)
      )
      .map((c) => ({ schema: t.schema, table: t.name, column: c.name }))
  )
}

/** Усе, з чим форма заміни порівнює прийнятий об'єкт. */
interface Context {
  shadow: readonly EquivalenceObject[]
  desired: CatalogModel
  labels: readonly ColumnName[]
  parse: SqlParser
  /** Нове ім'я таблиці одиниці за старим (`record.tables`). */
  newTable(schema: string, table: string): string
}

/**
 * Предмет класу `platform`: структурний об'єкт уже зіставлено з копією після
 * наміру (там нові імена таблиці й колонок у визначенні), одиниця — ключем
 * запису в старих іменах.
 */
type Subject =
  | { of: "structural"; adopted: EquivalenceObject }
  | { of: "unit"; key: Extract<PromotionObject, { kind: "unit" }> }
  | { of: "other" }

/**
 * Форма заміни класу `platform` за видом предмета (рішення 7 і R9 плану
 * П3-2b-0): чим бажаний стан мусить замінити прийнятий об'єкт, щоб клас A
 * спеки промоції §9.1 («прийнятий рукопис замінюється платформним») не став
 * тихим зникненням. Одне місце; ключі — рядки §9.2. Спека форм не змінює:
 * кожна форма виконує те, що рядок уже обіцяє.
 */
const REPLACEMENT_SHAPES = {
  /**
   * «FK посилання» (`RESTRICT` → `NO ACTION` без дозволу): ті самі колонки,
   * ціль, `MATCH` і відкладеність (урок В-5); дія рівна або пара
   * {`RESTRICT`, `NO ACTION`}. Інша зміна дії — не заміна класу A, а шлях
   * дозволу `delete:` (Пр8, §8). Через `promote` FK предметом не буває
   * (класифікуються лише `uniques`/`checks`/`indexes`), тож форма захисна.
   */
  foreignKey: (adopted: EquivalenceObject, c: Context): boolean => {
    const was = constraintNode(definition(adopted), c.parse)
    return (
      was !== undefined &&
      sameTable(c.shadow, adopted).some((s) => {
        const now = isForeignKey(s)
          ? constraintNode(definition(s), c.parse)
          : undefined
        return now !== undefined && sameForeignKey(was, now)
      })
    )
  },
  /**
   * «Перелік значень у `CHECK`» (→ `Ref` на перерахування): змаплена колонка
   * в бажаній моделі — `Ref` на вид зі значеннями-елементами. Форми `CHECK`
   * у тіні замало: дописаний будь-ким `CHECK` пройшов би хибно. Що значення
   * переліку — значення перерахування, доводять мапінг і крок даних, а не
   * цей гейт.
   */
  valueList: (adopted: EquivalenceObject, column: string, c: Context) =>
    c.labels.some(
      (l) =>
        l.schema === adopted.schema &&
        l.table === adopted.table &&
        l.column === column
    ),
  /**
   * «Індекс на FK, пара «тип + id», рухові індекси» та решта структурних
   * (UNIQUE, `CHECK` іншої форми, індекс): еквівалентний елемент на тій самій
   * таблиці тіні, ключ — `readEquivalenceObjects` (рішення 4 плану П3-2a).
   * «Ключі записів регістрів і зв'язків M:N» потрапляють сюди ж: до появи
   * регістрів вид такого ключа не дає — відома відмова.
   */
  equivalent: (adopted: EquivalenceObject, c: Context) =>
    sameTable(c.shadow, adopted).some(
      (s) => s.kind === adopted.kind && s.key === adopted.key
    ),
  /**
   * «Тригери механіки», «RLS і предикат скоупу», «Гранти на відношення»,
   * «Команди документа»: одиниця того самого класу на тій самій таблиці
   * бажаної моделі. Одиниця без таблиці (функція) — та сама за схемою й
   * іменем. До П3-3 генерованих політик і тригерів немає — відмова.
   */
  unit: (
    key: Extract<PromotionObject, { kind: "unit" }>,
    c: Context
  ): boolean => {
    const table = key.table === "" ? "" : c.newTable(key.schema, key.table)
    return c.desired.units.some((u) =>
      unitSubjectKeys(u, c.parse, u.schema).some(
        (k) =>
          k.class === key.class &&
          k.schema === key.schema &&
          k.table === table &&
          (table !== "" || k.name === key.name)
      )
    )
  },
  /** Значення за замовчуванням і коментар: рядка класу A в §9.2 немає. */
  none: (): boolean => false,
} as const

/**
 * Гейт Г4 (рішення 7 плану П3-2b-0): кожен об'єкт предмета з класом
 * `platform` мусить мати заміну в бажаному стані за формою свого виду.
 * `cloneEquivalence` — копія після наміру й до канонічних імен: імена
 * обмежень та індексів там ще початкові, а таблиці й колонки — нові, як у
 * тіні. Об'єкта, якого на копії немає, ціль не має — зникати нічому.
 */
export function platformReplacements(p: {
  record: PromotionRecord
  cloneEquivalence: readonly EquivalenceObject[]
  shadowEquivalence: readonly EquivalenceObject[]
  desired: CatalogModel
  valueElementColumns: readonly ColumnName[]
  parse: SqlParser
}): EngineDiagnostic[] {
  const { record, parse } = p
  const newTable = (schema: string, table: string): string =>
    record.tables.find((t) => t.schema === schema && t.from === table)?.to ??
    table
  const c: Context = {
    shadow: p.shadowEquivalence,
    desired: p.desired,
    labels: p.valueElementColumns,
    parse,
    newTable,
  }
  const subject = (o: PromotionObject): Subject | undefined => {
    if (o.kind === "unit") return { of: "unit", key: o }
    if (o.kind !== "constraint" && o.kind !== "index") return { of: "other" }
    const table = newTable(o.schema, o.table)
    const adopted = p.cloneEquivalence.find(
      (e) =>
        e.kind === o.kind &&
        e.schema === o.schema &&
        e.table === table &&
        e.name === o.name
    )
    return adopted === undefined ? undefined : { of: "structural", adopted }
  }
  const replaced = (s: Subject): boolean => {
    if (s.of === "unit") return REPLACEMENT_SHAPES.unit(s.key, c)
    if (s.of === "other") return REPLACEMENT_SHAPES.none()
    const { adopted } = s
    if (isForeignKey(adopted)) return REPLACEMENT_SHAPES.foreignKey(adopted, c)
    const column = isCheck(adopted)
      ? valueListColumn(definition(adopted), parse)
      : undefined
    return column !== undefined
      ? REPLACEMENT_SHAPES.valueList(adopted, column, c)
      : REPLACEMENT_SHAPES.equivalent(adopted, c)
  }

  const missing: string[] = []
  for (const conversion of record.conversions) {
    if (conversion.class !== "platform") continue
    for (const o of conversion.objects) {
      const s = subject(o)
      if (s !== undefined && !replaced(s))
        missing.push(`${conversion.subject} (${describe(o)})`)
    }
  }
  return missing.length === 0
    ? []
    : [
        applyDiagnostic("plan.platform-replacement-missing", "error", {
          objects: missing.join(", "),
        }),
      ]
}

/** Об'єкт запису для повідомлення — у старих іменах, як у записі. */
function describe(o: PromotionObject): string {
  switch (o.kind) {
    case "constraint":
    case "index":
      return `${o.kind} ${o.schema}.${o.table}.${o.name}`
    case "default":
      return `default ${o.schema}.${o.table}.${o.column}`
    case "comment":
      return `comment ${[o.schema, o.table, ...(o.column === undefined ? [] : [o.column])].join(".")}`
    case "unit":
      return `${o.class} ${[o.schema, ...(o.table === "" ? [] : [o.table]), o.name].join(".")}`
  }
}

const sameTable = (
  shadow: readonly EquivalenceObject[],
  adopted: EquivalenceObject
): EquivalenceObject[] =>
  shadow.filter((s) => s.schema === adopted.schema && s.table === adopted.table)

/** Ключ обмеження — `[contype, pg_get_constraintdef]`. */
const parts = (o: EquivalenceObject): [string, string] =>
  JSON.parse(o.key) as [string, string]
const isForeignKey = (o: EquivalenceObject): boolean =>
  o.kind === "constraint" && parts(o)[0] === "f"
const isCheck = (o: EquivalenceObject): boolean =>
  o.kind === "constraint" && parts(o)[0] === "c"
const definition = (o: EquivalenceObject): string => parts(o)[1]

type ConstraintNode = Extract<Node, { Constraint: unknown }>["Constraint"]

/**
 * Дерево визначення обмеження: `pg_get_constraintdef` дає хвіст
 * `ALTER TABLE … ADD CONSTRAINT`, тож розбирається саме така інструкція.
 * Нерозбірне визначення — без дерева: тоді форма не розпізнається, і гейт
 * відмовляє чи бере ключ еквівалентності.
 */
function constraintNode(
  def: string,
  parse: SqlParser
): ConstraintNode | undefined {
  const parsed = parse(`ALTER TABLE t ADD CONSTRAINT c ${def}`)
  if (!parsed.ok || parsed.statements.length !== 1) return undefined
  const stmt = parsed.statements[0]!.stmt
  if (!("AlterTableStmt" in stmt)) return undefined
  const cmd = stmt.AlterTableStmt.cmds?.[0]
  if (cmd === undefined || !("AlterTableCmd" in cmd)) return undefined
  const node = cmd.AlterTableCmd.def
  return node !== undefined && "Constraint" in node
    ? node.Constraint
    : undefined
}

const strings = (nodes: readonly Node[] | undefined): string[] =>
  (nodes ?? []).map((n) => ("String" in n ? (n.String.sval ?? "") : "\0"))

/** `NO ACTION` (`a`) і `RESTRICT` (`r`) спека §9.2 вважає неістотною зміною. */
const NO_ACTION_PAIR: ReadonlySet<string> = new Set(["a", "r"])

const sameAction = (a = "a", b = "a"): boolean =>
  a === b || (NO_ACTION_PAIR.has(a) && NO_ACTION_PAIR.has(b))

function sameForeignKey(was: ConstraintNode, now: ConstraintNode): boolean {
  const same = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((v, i) => v === y[i])
  return (
    was.contype === "CONSTR_FOREIGN" &&
    now.contype === "CONSTR_FOREIGN" &&
    same(strings(was.fk_attrs), strings(now.fk_attrs)) &&
    (was.pktable?.schemaname ?? "") === (now.pktable?.schemaname ?? "") &&
    (was.pktable?.relname ?? "") === (now.pktable?.relname ?? "") &&
    same(strings(was.pk_attrs), strings(now.pk_attrs)) &&
    (was.fk_matchtype ?? "s") === (now.fk_matchtype ?? "s") &&
    (was.deferrable ?? false) === (now.deferrable ?? false) &&
    (was.initdeferred ?? false) === (now.initdeferred ?? false) &&
    sameAction(was.fk_upd_action, now.fk_upd_action) &&
    sameAction(was.fk_del_action, now.fk_del_action) &&
    same(strings(was.fk_del_set_cols), strings(now.fk_del_set_cols))
  )
}

/**
 * Колонка переліку значень `CHECK` — лише вузькі форми R9: `col IN (…)` і
 * `col = ANY (ARRAY[…])` з літералами, зокрема з приведенням типу. Приведення
 * колонки (`(col)::text`) Postgres сам дописує для `varchar`, тож воно теж
 * допускається. Інша форма — `undefined`: діє ключ еквівалентності.
 */
function valueListColumn(def: string, parse: SqlParser): string | undefined {
  const node = constraintNode(def, parse)
  const expr = node?.contype === "CONSTR_CHECK" ? node.raw_expr : undefined
  if (expr === undefined || !("A_Expr" in expr)) return undefined
  const { kind, name, lexpr, rexpr } = expr.A_Expr
  if (strings(name).join(".") !== "=") return undefined
  const column = lexpr === undefined ? undefined : columnOf(lexpr)
  if (column === undefined || rexpr === undefined) return undefined
  if (kind === "AEXPR_IN")
    return "List" in rexpr && literals(rexpr.List.items) ? column : undefined
  if (kind !== "AEXPR_OP_ANY") return undefined
  const array = uncast(rexpr)
  return "A_ArrayExpr" in array && literals(array.A_ArrayExpr.elements)
    ? column
    : undefined
}

const uncast = (node: Node): Node =>
  "TypeCast" in node && node.TypeCast.arg !== undefined
    ? node.TypeCast.arg
    : node

function columnOf(node: Node): string | undefined {
  const bare = uncast(node)
  if (!("ColumnRef" in bare)) return undefined
  const fields = bare.ColumnRef.fields ?? []
  return fields.length === 1 && "String" in fields[0]!
    ? fields[0].String.sval
    : undefined
}

const literals = (nodes: readonly Node[] | undefined): boolean =>
  nodes !== undefined &&
  nodes.length > 0 &&
  nodes.every((n) => {
    const bare = uncast(n)
    return "A_Const" in bare && bare.A_Const.isnull !== true
  })
