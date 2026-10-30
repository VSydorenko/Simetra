import type { GrantStmt, Node, RoleSpec } from "libpg-query"
import {
  AUTHOR_FUNCTION,
  MECHANICS_FUNCTION,
  authorTableColumns,
  authorTriggerName,
  authorUpdateTriggerName,
  carrierFunctionNames,
  carrierTriggerNames,
  contentChangeCondition,
  effectsFunctionName,
  effectsTriggerNames,
  rightsGuardNames,
  mechanicsTriggerName,
  mechanicsUpdateTriggerName,
  statementTargets,
  uniqueDifferences,
  unitSubjectKeys,
  valueAt,
  withoutLocations,
  type CompiledModel,
  type PromotionObject,
  type PromotionRecord,
  type SqlParser,
  type UniqueShape,
} from "simetra/compiler"
import {
  KIND_REGISTRY,
  PROVIDER_API_ROLES,
  serviceDateColumns,
  type AttributeCase,
  type CatalogModel,
  type CatalogUnit,
  type DatabaseProvider,
  type MetadataKind,
  type PhysicalSnapshot,
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
  /** Копія після наміру: прийняті гранти й політики в нових іменах таблиць. */
  clone: CatalogModel
  labels: readonly ColumnName[]
  parse: SqlParser
  /** Роль запиту користувача провайдера: її означає прийнята `public`. */
  userRole: string
  /** Нове ім'я таблиці одиниці за старим (`record.tables`). */
  newTable(schema: string, table: string): string
  /** Нове ім'я колонки за старим на таблиці в новому імені (`record.columns`). */
  newColumn(schema: string, table: string, column: string): string
  /**
   * Дерево `contentChangeCondition` бажаної таблиці (нове ім'я) з копіями
   * носіїв; таблиця без копій умови не має. `author` — з колонками
   * авторства в `watched`, як у тригерів механіки й авторства (Р-A1-10);
   * без нього — як у підписок.
   */
  content(
    schema: string,
    table: string,
    watched: "author" | "none"
  ): Node | undefined
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
   * регістрів вид такого ключа не дає — відома відмова. Те саме порівняння
   * тримає й гейт плану класу `property` (`propertyReproductions`).
   */
  equivalent: (adopted: EquivalenceObject, c: Pick<Context, "shadow">) =>
    sameTable(c.shadow, adopted).some(
      (s) => s.kind === adopted.kind && s.key === adopted.key
    ),
  /**
   * «Індекс на FK» та інші індекси, яких вид не відтворює еквівалентно
   * (рішення 11 плану П3-3a1): прийнятий простий btree покриває ключ чи
   * індекс тіні на тій самій таблиці — інакше індекс скоупу `(org_id)` при
   * ключі виду `UNIQUE (org_id, id)` був би відмовою без жодної втрати.
   * Неунікальний покривається будь-яким простим ключем, що починається з
   * його колонок (пошук той самий), унікальний — лише унікальним з тими
   * самими колонками в тому самому порядку: ширший ключ дозволив би дублікати.
   */
  covered: (
    adopted: EquivalenceObject,
    c: Pick<Context, "shadow" | "parse">
  ): boolean => {
    const was =
      adopted.kind === "index" ? plainIndex(adopted, false) : undefined
    return (
      was !== undefined &&
      sameTable(c.shadow, adopted).some((s) => {
        const by = coveringKey(s, c.parse)
        if (by === undefined) return false
        return was.unique
          ? by.unique &&
              !by.deferrable &&
              by.nullsNotDistinct === was.nullsNotDistinct &&
              by.columns.length === was.columns.length &&
              was.columns.every((col, i) => by.columns[i] === col)
          : was.columns.every((col, i) => by.columns[i] === col)
      })
    )
  },
  /**
   * «Гранти на відношення» (рішення 10): кожна пара (роль, привілей), яку
   * прийнятий оператор дає чи знімає на копії цілі, покрита оператором тієї
   * самої дії на тому самому об'єкті бажаного стану. Обидва боки — з витягу
   * (копія й тінь), де грант записано відносно типових прав, тож порівняння
   * йде в одній формі. Пари, рівної типовим правам цілі (ADP схеми, пресет),
   * на копії немає, і ця форма її не перевіряє. Втрату справжнього доступу
   * від такої пари показує інше місце плану (рішення архітектора П3-3a1):
   * сервісної ролі — `plan.service-role-access-lost`, запису ролей API —
   * гейт шляху запису (`plan.write-path`), читання — рядок політики чи RLS
   * плану.
   */
  grant: (
    key: Extract<PromotionObject, { kind: "unit" }>,
    c: Context
  ): boolean => {
    const target = {
      schema: key.schema,
      object: c.newTable(key.schema, key.table),
    }
    const adopted = subjectGrant(key.name)
    const wanted = grantPairsOn(c.clone, target, c.parse).flatMap((was) => {
      if (was.action !== adopted.action || !adopted.roles.includes(was.role))
        return []
      // Що саме з наявного на копії дає цей оператор: ширший бік звужує
      // вужчий (`ALL` на копії — лише прийняті привілеї, і навпаки)
      return adopted.privileges.flatMap((p) =>
        covers(was, p) ? [{ ...was, ...p }] : covers(p, was) ? [was] : []
      )
    })
    const now = grantPairsOn(c.desired, target, c.parse)
    return wanted.every((w) =>
      now.some(
        (n) =>
          n.action === w.action &&
          n.role === w.role &&
          covers(n, w) &&
          // Грант з опцією покриває лише грант з опцією; відкликання самої
          // опції не покриває повного відкликання
          (w.action === "grant"
            ? !w.grantOption || n.grantOption
            : !n.grantOption || w.grantOption)
      )
    )
  },
  /**
   * «RLS і предикат скоупу», «Публічне читання» (рішення 10): прийнята
   * політика з копії цілі має `PERMISSIVE` і ту саму команду, що й політика
   * бажаного стану на тій самій таблиці, а ролі тієї містять усі ролі
   * прийнятої (`public` — роль запиту користувача, спека промоції §8).
   * Різниця предиката — не тут, а під дозволом `access:`. Політики, якої на
   * копії немає, ціль не має.
   */
  policy: (
    key: Extract<PromotionObject, { kind: "unit" }>,
    c: Context
  ): boolean => {
    const table = c.newTable(key.schema, key.table)
    const adopted = policiesOn(c.clone, key.schema, table, c.parse).find(
      (p) => p.name === key.name
    )
    if (adopted === undefined) return true
    return (
      adopted.permissive &&
      policiesOn(c.desired, key.schema, table, c.parse).some(
        (p) =>
          p.permissive &&
          p.command === adopted.command &&
          adopted.roles.every(
            (r) =>
              p.roles.includes("public") ||
              p.roles.includes(r === "public" ? c.userRole : r)
          )
      )
    )
  },
  /**
   * «Команди документа» та інші одиниці без таблиці: одиниця того самого
   * класу з тією самою схемою й іменем у бажаному стані.
   */
  function: (
    key: Extract<PromotionObject, { kind: "unit" }>,
    c: Pick<Context, "desired" | "parse">
  ): boolean =>
    c.desired.units.some((u) =>
      unitSubjectKeys(u, c.parse, u.schema).some(
        (k) =>
          k.class === key.class &&
          k.schema === key.schema &&
          k.table === "" &&
          k.name === key.name
      )
    ),
  /**
   * «Тригери механіки» й «Реакції застосунку на запис» (рішення 6 плану
   * П3-3a2): генеровані тригери — механіка рядка й тригери підписок. Тригер
   * бажаного стану на таблиці виду — згенерований або борг зі спільного
   * `sql/`; борговий тригер тієї самої форми відтворює ту саму поведінку, тож
   * нічого не губиться, а борг лишається видимим. Прийнятий тригер з копії після
   * наміру (таблиця вже в новому імені) замінено механікою, коли він —
   * `moddatetime` на колонці, що стає службовою датою, або підпискою з тим
   * самим обробником, часом, рівнем, подіями й умовою. На таблиці з копіями
   * носіїв `moddatetime` замінює лише `<t>_simetra_touch_update` з умовою
   * змісту, а пара підписки з цією умовою — підписка без умови (Р2a2-20).
   * Тригера, якого на копії немає, ціль не має.
   */
  trigger: (
    key: Extract<PromotionObject, { kind: "unit" }>,
    c: TriggerContext
  ): boolean => triggerReplacement(key, c).replaced,
  /**
   * Значення за замовчуванням, коментар і решта одиниць з таблицею: рядка
   * класу A в §9.2 немає.
   */
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
  /** Модель копії після наміру: прийняті гранти й політики цілі. */
  clone: CatalogModel
  valueElementColumns: readonly ColumnName[]
  provider: DatabaseProvider
  /** Таблиці бажаної моделі: копії носіїв дають умову змісту тригерів. */
  physical: Pick<PhysicalSnapshot, "tables">
  attributeCase: AttributeCase
  parse: SqlParser
}): EngineDiagnostic[] {
  const { record, parse } = p
  const c: Context = {
    ...triggerContext(p),
    shadow: p.shadowEquivalence,
    labels: p.valueElementColumns,
    userRole: PROVIDER_API_ROLES[p.provider].user,
  }
  const subject = (o: PromotionObject): Subject | undefined => {
    if (o.kind === "unit") return { of: "unit", key: o }
    if (o.kind !== "constraint" && o.kind !== "index") return { of: "other" }
    const adopted = adoptedOnClone(o, p.cloneEquivalence, record)
    // Копія доказу — копія цілі: об'єкта, якого немає на копії, немає й на
    // цілі, тож знімати нічого і заміна не потрібна
    return adopted === undefined ? undefined : { of: "structural", adopted }
  }
  const replaced = (s: Subject): boolean => {
    if (s.of === "unit") {
      const { key } = s
      // Грант без цілі-об'єкта (`key.table === ""`) форма `grant` не
      // зіставить ні з чим, і порожній перелік пар став би хибною «заміною»
      if (key.class === "grant")
        return key.table === ""
          ? REPLACEMENT_SHAPES.none()
          : REPLACEMENT_SHAPES.grant(key, c)
      if (key.class === "policy") return REPLACEMENT_SHAPES.policy(key, c)
      if (key.class === "trigger") return REPLACEMENT_SHAPES.trigger(key, c)
      if (key.table === "") return REPLACEMENT_SHAPES.function(key, c)
      return REPLACEMENT_SHAPES.none()
    }
    if (s.of === "other") return REPLACEMENT_SHAPES.none()
    const { adopted } = s
    if (isForeignKey(adopted)) return REPLACEMENT_SHAPES.foreignKey(adopted, c)
    const column = isCheck(adopted)
      ? valueListColumn(definition(adopted), parse)
      : undefined
    return column !== undefined
      ? REPLACEMENT_SHAPES.valueList(adopted, column, c)
      : REPLACEMENT_SHAPES.equivalent(adopted, c) ||
          REPLACEMENT_SHAPES.covered(adopted, c)
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

/**
 * Попередження `plan.update-of-narrowed` (рішення 6 плану П3-3a2): прийнятий
 * `UPDATE OF <колонки>`, який замінює підписка з `whenChanged`, спрацьовував
 * на кожен `UPDATE` з цими колонками в `SET`, а підписка — лише на справжню
 * зміну значення. Заміна законна, але поведінка звужується, тож автор має це
 * побачити. Імена — старі, як у записі й у `plan.platform-replacement-missing`.
 */
export function updateOfNarrowings(p: {
  record: PromotionRecord
  clone: CatalogModel
  desired: CatalogModel
  physical: Pick<PhysicalSnapshot, "tables">
  attributeCase: AttributeCase
  parse: SqlParser
}): EngineDiagnostic[] {
  const c = triggerContext(p)
  return p.record.conversions
    .filter((conversion) => conversion.class === "platform")
    .flatMap((conversion) =>
      conversion.objects.flatMap((o) => {
        if (o.kind !== "unit" || o.class !== "trigger") return []
        const { narrowed } = triggerReplacement(o, c)
        if (narrowed === undefined) return []
        // Колонки `UPDATE OF` — з копії після наміру, тобто вже в нових
        // іменах; назад їх веде той самий мапінг запису, що й `newColumn`
        const table = c.newTable(o.schema, o.table)
        const old = (column: string) =>
          p.record.columns.find(
            (m) => m.schema === o.schema && m.table === table && m.to === column
          )?.from ?? column
        return [
          applyDiagnostic("plan.update-of-narrowed", "warning", {
            trigger: o.name,
            table: `${o.schema}.${o.table}`,
            columns: narrowed.map(old).join(", "),
          }),
        ]
      })
    )
}

/** Те, з чим форма `trigger` порівнює прийнятий тригер. */
type TriggerContext = Pick<
  Context,
  "clone" | "desired" | "parse" | "newTable" | "newColumn" | "content"
>

function triggerContext(p: {
  record: PromotionRecord
  clone: CatalogModel
  desired: CatalogModel
  physical: Pick<PhysicalSnapshot, "tables">
  attributeCase: AttributeCase
  parse: SqlParser
}): TriggerContext {
  const { record } = p
  return {
    clone: p.clone,
    desired: p.desired,
    parse: p.parse,
    newTable: (schema, table) => newTableName(record, schema, table),
    newColumn: (schema, table, column) =>
      record.columns.find(
        (m) => m.schema === schema && m.table === table && m.from === column
      )?.to ?? column,
    content: (schema, table, watched) => {
      const found = p.physical.tables.find(
        (t) => t.schema === schema && t.name === table
      )
      const when =
        found === undefined
          ? undefined
          : contentChangeCondition(
              found,
              p.attributeCase,
              watched === "author"
                ? authorTableColumns(found, p.attributeCase)
                : []
            )
      return when === undefined ? undefined : whenTree(when, p.parse)
    },
  }
}

/**
 * Дерево умови `WHEN` з тексту умови: розбір цілого оператора тригера, бо
 * окремого виразу libpg-query не розбирає. Умову дав компілятор, тож збій —
 * порушений інваріант.
 */
function whenTree(when: string, parse: SqlParser): Node {
  const parsed = parse(
    `CREATE TRIGGER t BEFORE UPDATE ON t FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION f()`
  )
  const stmt = parsed.ok ? parsed.statements[0]?.stmt : undefined
  const tree =
    stmt !== undefined && "CreateTrigStmt" in stmt
      ? stmt.CreateTrigStmt.whenClause
      : undefined
  if (tree === undefined)
    throw new Error(`internal: content condition does not parse: ${when}`)
  return tree
}

/**
 * Гейт плану класу `property` (R10 плану П3-2b-0): кожне прийняте обмеження
 * чи індекс з цим класом бажана тінь мусить відтворити еквівалентно — тим
 * самим порівнянням, що й форма `equivalent` класу `platform`. Клас запису
 * сам нічого не доводить: запис, написаний до гейта мутації
 * (`promote.property-not-equivalent`), змінені після `promote` метадані чи
 * ручна правка запису інакше мовчки зняли б відкладеність чи предикат.
 * Умова — відсутність еквівалента в тіні, а не DROP двигуна: залежне
 * обмеження двигун законно знімає й створює наново при зміні типу колонки
 * (спека промоції §7.2).
 */
export function propertyReproductions(p: {
  record: PromotionRecord
  cloneEquivalence: readonly EquivalenceObject[]
  shadowEquivalence: readonly EquivalenceObject[]
  parse: SqlParser
}): EngineDiagnostic[] {
  const c = { shadow: p.shadowEquivalence }
  const refusals: EngineDiagnostic[] = []
  for (const conversion of p.record.conversions) {
    if (conversion.class !== "property") continue
    for (const o of conversion.objects) {
      if (o.kind !== "constraint" && o.kind !== "index") continue
      const adopted = adoptedOnClone(o, p.cloneEquivalence, p.record)
      // Як і для `platform`: чого немає на копії цілі, того немає на цілі
      if (adopted === undefined || REPLACEMENT_SHAPES.equivalent(adopted, c))
        continue
      refusals.push(
        applyDiagnostic("plan.property-not-reproduced", "error", {
          subject: conversion.subject,
          object: describe(o),
          detail: closestDifference(adopted, c.shadow, p.parse),
        })
      )
    }
  }
  return refusals
}

/** Нове ім'я таблиці одиниці за старим (`record.tables`). */
const newTableName = (
  record: PromotionRecord,
  schema: string,
  table: string
): string =>
  record.tables.find((t) => t.schema === schema && t.from === table)?.to ??
  table

/**
 * Прийнятий об'єкт на копії після наміру: таблиця там уже в новому імені, а
 * ім'я обмеження чи індексу ще початкове, як у записі.
 */
function adoptedOnClone(
  o: Extract<PromotionObject, { kind: "constraint" | "index" }>,
  clone: readonly EquivalenceObject[],
  record: PromotionRecord
): EquivalenceObject | undefined {
  const table = newTableName(record, o.schema, o.table)
  return clone.find(
    (e) =>
      e.kind === o.kind &&
      e.schema === o.schema &&
      e.table === table &&
      e.name === o.name
  )
}

/**
 * Назви частин ключа індексу — у порядку `readEquivalenceObjects`; ключ
 * обмеження — `[contype, definition]`.
 */
const INDEX_PARTS = [
  "method",
  "unique",
  "nullsNotDistinct",
  "keyColumns",
  "columns",
  "options",
  "operatorClasses",
  "operatorClassOptions",
  "collations",
  "where",
  "storage",
  "defaultOperatorClasses",
] as const
const CONSTRAINT_PARTS = ["type", "definition"] as const

/**
 * Чим найближчий елемент того самого виду на таблиці тіні відрізняється від
 * прийнятого — лише для повідомлення, вердикт дає `equivalent`. Найближчий —
 * з найменшою кількістю різних частин, далі з найдовшим спільним початком
 * ключа. Два UNIQUE порівнюються полями `uniqueDifferences` — тими самими, що
 * й у гейті `promote` (`promote.property-not-equivalent`), а не цілим рядком
 * `pg_get_constraintdef`.
 */
function closestDifference(
  adopted: EquivalenceObject,
  shadow: readonly EquivalenceObject[],
  parse: SqlParser
): string {
  const names: readonly string[] =
    adopted.kind === "index" ? INDEX_PARTS : CONSTRAINT_PARTS
  const was = JSON.parse(adopted.key) as unknown[]
  const show = (v: unknown) =>
    v === null || v === undefined
      ? "(none)"
      : typeof v === "string"
        ? v
        : JSON.stringify(v)
  const common = (a: string, b: string) => {
    let i = 0
    while (i < a.length && a[i] === b[i]) i++
    return i
  }
  const candidates = sameTable(shadow, adopted)
    .filter(
      (s) =>
        s.kind === adopted.kind &&
        (s.kind !== "constraint" || parts(s)[0] === parts(adopted)[0])
    )
    .map((s) => {
      const now = JSON.parse(s.key) as unknown[]
      const fields =
        uniqueFields(adopted, s, parse) ??
        names.flatMap((field, i) =>
          show(was[i]) === show(now[i])
            ? []
            : [`${field}: ${show(was[i])} → ${show(now[i])}`]
        )
      return { fields, prefix: common(adopted.key, s.key) }
    })
    .sort((a, b) => a.fields.length - b.fields.length || b.prefix - a.prefix)
  const closest = candidates[0]
  return closest === undefined
    ? "no element of this kind on the table in the desired state"
    : closest.fields.join("; ")
}

/**
 * Різні поля двох UNIQUE за `uniqueDifferences`. `undefined` — не пара
 * UNIQUE, визначення не розбирається або поля рівні, а різниця в тому, чого
 * форма UNIQUE не несе (скажімо, `INCLUDE`): тоді діє порівняння частин ключа.
 */
function uniqueFields(
  adopted: EquivalenceObject,
  shadow: EquivalenceObject,
  parse: SqlParser
): string[] | undefined {
  const was = uniqueShape(adopted, parse)
  const now = uniqueShape(shadow, parse)
  if (was === undefined || now === undefined) return undefined
  const found = uniqueDifferences(was, now)
  return found.length === 0
    ? undefined
    : found.map((d) => `${d.field}: ${d.was} → ${d.now}`)
}

/** Форма UNIQUE з дерева визначення; інше обмеження — `undefined`. */
function uniqueShape(
  o: EquivalenceObject,
  parse: SqlParser
): UniqueShape | undefined {
  if (o.kind !== "constraint" || parts(o)[0] !== "u") return undefined
  const node = constraintNode(definition(o), parse)
  if (node?.contype !== "CONSTR_UNIQUE") return undefined
  return {
    columns: strings(node.keys),
    nullsNotDistinct: node.nulls_not_distinct ?? false,
    deferrable:
      node.deferrable !== true
        ? "no"
        : node.initdeferred === true
          ? "initiallyDeferred"
          : "deferrable",
  }
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

/**
 * Колонка лівої частини. Знімається лише приведення до `text` — те, що
 * Postgres сам дописує для `varchar`; приведення до іншого типу — вираз над
 * колонкою, а не сама колонка, тож переліком значень він не є.
 */
function columnOf(node: Node): string | undefined {
  const bare =
    ("TypeCast" in node && textCast(node.TypeCast)
      ? node.TypeCast.arg
      : undefined) ?? node
  if (!("ColumnRef" in bare)) return undefined
  const fields = bare.ColumnRef.fields ?? []
  return fields.length === 1 && "String" in fields[0]!
    ? fields[0].String.sval
    : undefined
}

type TypeCastNode = Extract<Node, { TypeCast: unknown }>["TypeCast"]

/** `(…)::text` чи `(…)::pg_catalog.text` без модифікаторів і масиву. */
function textCast(cast: TypeCastNode): boolean {
  const type = cast.typeName
  const names = strings(type?.names)
  return (
    cast.arg !== undefined &&
    (type?.typmods ?? []).length === 0 &&
    (type?.arrayBounds ?? []).length === 0 &&
    (names.join(".") === "text" || names.join(".") === "pg_catalog.text")
  )
}

const literals = (nodes: readonly Node[] | undefined): boolean =>
  nodes !== undefined &&
  nodes.length > 0 &&
  nodes.every((n) => {
    const bare = uncast(n)
    return "A_Const" in bare && bare.A_Const.isnull !== true
  })

/** Ключ, що покриває прийнятий індекс: ключові колонки в порядку ключа. */
interface CoveringKey {
  unique: boolean
  nullsNotDistinct: boolean
  deferrable: boolean
  columns: string[]
}

/** Колляція колонки за замовчуванням — не явна колляція індексу. */
const DEFAULT_COLLATION = 'pg_catalog."default"'

/**
 * Простий btree з ключа еквівалентності (`INDEX_PARTS`): без предиката,
 * виразів, нетипових класів операторів, колляцій, `indoption` і параметрів
 * класу. Лише такий пошук ключ тіні гарантовано відтворює: індекс
 * `(a text_pattern_ops)` чи `(a DESC)` служить іншим запитам. Прийнятий
 * (`include = false`) ще й без `INCLUDE` і `reloptions`; покривальний ключ
 * тіні може їх мати — пошуку за ключовими колонками вони не міняють.
 */
function plainIndex(
  o: EquivalenceObject,
  include: boolean
): CoveringKey | undefined {
  const [
    method,
    unique,
    nullsNotDistinct,
    keyCount,
    columns,
    options,
    ,
    classOptions,
    collations,
    where,
    storage,
    defaults,
  ] = JSON.parse(o.key) as unknown[]
  if (
    method !== "btree" ||
    typeof keyCount !== "number" ||
    !Array.isArray(columns) ||
    where !== null ||
    (!include && (storage !== null || columns.length !== keyCount))
  )
    return undefined
  const all = (v: unknown, ok: (x: unknown) => boolean) =>
    Array.isArray(v) && v.length === keyCount && v.every(ok)
  if (
    !all(options, (x) => x === 0) ||
    !all(classOptions, (x) => x === null) ||
    !all(collations, (x) => x === null || x === DEFAULT_COLLATION) ||
    !all(defaults, (x) => x === true)
  )
    return undefined
  const keys = columns.slice(0, keyCount).map(identifier)
  if (keys.some((k) => k === undefined)) return undefined
  return {
    unique: unique === true,
    nullsNotDistinct: nullsNotDistinct === true,
    deferrable: false,
    columns: keys as string[],
  }
}

/**
 * Ключ тіні, що може покрити прийнятий індекс: простий індекс або UNIQUE чи
 * PK — їхній індекс-носій завжди btree з типовими класами й без предиката.
 */
function coveringKey(
  s: EquivalenceObject,
  parse: SqlParser
): CoveringKey | undefined {
  if (s.kind === "index") return plainIndex(s, true)
  if (s.kind !== "constraint" || !["p", "u"].includes(parts(s)[0]))
    return undefined
  const node = constraintNode(definition(s), parse)
  if (node?.contype !== "CONSTR_UNIQUE" && node?.contype !== "CONSTR_PRIMARY")
    return undefined
  return {
    unique: true,
    nullsNotDistinct: node.nulls_not_distinct ?? false,
    deferrable: node.deferrable ?? false,
    columns: strings(node.keys),
  }
}

/**
 * Ім'я ключової колонки з `pg_get_indexdef(oid, k, false)`: ідентифікатор
 * як є або в лапках. Решта — вираз, а не колонка.
 */
function identifier(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined
  if (/^[a-z_][a-z0-9_$]*$/.test(text)) return text
  const quoted = /^"((?:[^"]|"")+)"$/.exec(text)
  return quoted === null ? undefined : quoted[1]!.replaceAll('""', '"')
}

/** Привілей пари гранту: `all` — усі; колонки — колонковий привілей. */
interface Privilege {
  privilege: string
  columns: string[]
}

/** Одна пара (роль, привілей) оператора гранту. */
interface GrantPair extends Privilege {
  action: "grant" | "revoke"
  role: string
  /** `WITH GRANT OPTION` гранту чи `GRANT OPTION FOR` відкликання. */
  grantOption: boolean
}

/** `a` покриває `b`: `ALL`, або той самий привілей на всю таблицю чи ширший перелік колонок. */
const covers = (a: Privilege, b: Privilege): boolean =>
  a.privilege === "all" ||
  (a.privilege === b.privilege &&
    (a.columns.length === 0 ||
      (b.columns.length > 0 && b.columns.every((x) => a.columns.includes(x)))))

/**
 * Дія, ролі й привілеї прийнятого гранту з імені ключа предмета
 * (`<grant|revoke>:<ролі>:<привілеї>`, `unitSubjectKeys`): ролі й привілеї
 * там уже розкладено тим самим правилом, що й у дерева гранту.
 */
function subjectGrant(name: string): {
  action: "grant" | "revoke"
  roles: string[]
  privileges: Privilege[]
} {
  const [action, roles = "", ...rest] = name.split(":")
  return {
    action: action === "grant" ? "grant" : "revoke",
    roles: roles.split(","),
    privileges: [...rest.join(":").matchAll(/([^,()]+)(?:\(([^)]*)\))?/g)].map(
      (m) => ({
        privilege: m[1]!,
        columns: m[2] === undefined ? [] : m[2].split(","),
      })
    ),
  }
}

const roleName = (spec: RoleSpec): string =>
  spec.rolename ?? (spec.roletype ?? "").replace(/^ROLESPEC_/, "").toLowerCase()

function grantPairs(node: GrantStmt): GrantPair[] {
  const privileges: Privilege[] =
    (node.privileges ?? []).length === 0
      ? [{ privilege: "all", columns: [] }]
      : node.privileges!.map((n) => {
          const priv = "AccessPriv" in n ? n.AccessPriv : {}
          return {
            privilege: priv.priv_name ?? "all",
            columns: strings(priv.cols),
          }
        })
  return (node.grantees ?? []).flatMap((g) =>
    "RoleSpec" in g
      ? privileges.map((p) => ({
          ...p,
          action:
            node.is_grant === true ? ("grant" as const) : ("revoke" as const),
          role: roleName(g.RoleSpec),
          grantOption: node.grant_option === true,
        }))
      : []
  )
}

/** Розібрані оператори одиниць класу `cls` моделі. */
function statementsOf(
  model: CatalogModel,
  cls: CatalogUnit["class"],
  parse: SqlParser
): { unit: CatalogUnit; stmt: Node }[] {
  return model.units
    .filter((u) => u.class === cls)
    .flatMap((unit) => {
      const parsed = parse(unit.sql)
      // Одиниці моделі вже розібрав extract: збій — порушений інваріант
      if (!parsed.ok)
        throw new Error(`${cls} unit does not parse: ${parsed.message}`)
      return parsed.statements.map((s) => ({ unit, stmt: s.stmt }))
    })
}

/** Пари гранту моделі на об'єкт (`schema`, `object`). */
function grantPairsOn(
  model: CatalogModel,
  target: { schema: string; object: string },
  parse: SqlParser
): GrantPair[] {
  return statementsOf(model, "grant", parse).flatMap(({ unit, stmt }) =>
    "GrantStmt" in stmt &&
    statementTargets(stmt, unit.schema).some(
      (t) => t.schema === target.schema && t.object === target.object
    )
      ? grantPairs(stmt.GrantStmt)
      : []
  )
}

export interface PolicyShape {
  name: string
  permissive: boolean
  command: string
  roles: string[]
}

/** Політики моделі на таблиці; без `TO` політика діє для `public`. */
export function policiesOn(
  model: CatalogModel,
  schema: string,
  table: string,
  parse: SqlParser
): PolicyShape[] {
  return statementsOf(model, "policy", parse).flatMap(({ unit, stmt }) => {
    if (!("CreatePolicyStmt" in stmt)) return []
    const node = stmt.CreatePolicyStmt
    if (
      (node.table?.schemaname ?? unit.schema) !== schema ||
      node.table?.relname !== table
    )
      return []
    const roles = (node.roles ?? []).flatMap((r) =>
      "RoleSpec" in r ? [roleName(r.RoleSpec)] : []
    )
    return [
      {
        name: node.policy_name ?? "",
        permissive: node.permissive === true,
        command: node.cmd_name ?? "all",
        roles: roles.length === 0 ? ["public"] : roles,
      },
    ]
  })
}

/** Біти `CreateTrigStmt.timing` і `events` (`trigger.h` Postgres). */
const TRIGGER_BEFORE = 2
const TRIGGER_INSERT = 4
const TRIGGER_UPDATE = 16

/** Службова дата оновлення, яку тримає механіка рядка, — з реєстру. */
const UPDATED_AT = serviceDateColumns().find(
  (c) => c.logicalName === "updatedAt"
)!.physicalName

/** Те, що тригер робить, з дерева `CreateTrigStmt`. */
interface TriggerShape {
  name: string
  /** Функція: некваліфіковане ім'я — у схемі одиниці, як `unitTargets`. */
  function: { schema: string; name: string }
  timing: number
  events: number
  row: boolean
  /** `UPDATE OF <колонки>`. */
  columns: string[]
  when: Node | undefined
  args: string[]
  /**
   * Тригер обмеження чи з `REFERENCING`: такого генератори не дають, тож він
   * ні з чим не зрівняється.
   */
  special: boolean
}

/** Тригери моделі на таблиці (`schema`, `table`). */
function triggersOn(
  model: CatalogModel,
  schema: string,
  table: string,
  parse: SqlParser
): TriggerShape[] {
  return statementsOf(model, "trigger", parse).flatMap(({ unit, stmt }) => {
    if (!("CreateTrigStmt" in stmt)) return []
    const node = stmt.CreateTrigStmt
    if (
      (node.relation?.schemaname ?? unit.schema) !== schema ||
      node.relation?.relname !== table
    )
      return []
    const fn = strings(node.funcname)
    return [
      {
        name: node.trigname ?? "",
        function: { schema: fn.at(-2) ?? unit.schema, name: fn.at(-1) ?? "" },
        timing: node.timing ?? 0,
        events: node.events ?? 0,
        row: node.row === true,
        columns: strings(node.columns),
        when: node.whenClause,
        args: strings(node.args),
        special:
          node.isconstraint === true ||
          (node.transitionRels ?? []).length > 0 ||
          node.constrrel !== undefined,
      },
    ]
  })
}

/**
 * Вердикт форми `trigger` і, коли заміна покриває `UPDATE OF`, колонки, на
 * яких тригер звужується до справжньої зміни значення.
 */
function triggerReplacement(
  key: Extract<PromotionObject, { kind: "unit" }>,
  c: TriggerContext
): { replaced: boolean; narrowed?: string[] } {
  const table = c.newTable(key.schema, key.table)
  const adopted = triggersOn(c.clone, key.schema, table, c.parse).find(
    (t) => t.name === key.name
  )
  if (adopted === undefined) return { replaced: true }
  if (adopted.special || !adopted.row) return { replaced: false }
  const desired = triggersOn(c.desired, key.schema, table, c.parse)
  const content = c.content(key.schema, table, "none")
  // Платформні тригери оновлення (механіка, авторство) стежать і за
  // авторством (Р-A1-10), підписки — ні: дві різні умови
  const authored = c.content(key.schema, table, "author")
  // Умова змісту таблиці з копіями носіїв еквівалентна «без `WHEN`»
  // (Р2a2-20): вона придушує лише поширення копій платформою. Впізнається
  // лише рівністю дерева з умовою бажаної таблиці — власна умова `… OR NOT
  // …` іншого набору колонок платформною не є
  const sameCondition =
    (expected: Node | undefined) => (when: Node | undefined) =>
      expected !== undefined &&
      when !== undefined &&
      sameTree(withoutRowOperandCasts(when), expected)
  const isContent = sameCondition(content)
  const isAuthoredContent = sameCondition(authored)
  const touch = (t: TriggerShape) =>
    t.name === mechanicsTriggerName(table) &&
    sameFunction(t.function, MECHANICS_FUNCTION)
  // На таблиці з копіями механіка оновлення — окремий тригер з умовою змісту
  const contentUpdate = (t: TriggerShape) =>
    t.timing === TRIGGER_BEFORE &&
    t.events === TRIGGER_UPDATE &&
    t.row &&
    !t.special &&
    t.columns.length === 0 &&
    isAuthoredContent(t.when)
  const touchUpdate = (t: TriggerShape) =>
    t.name === mechanicsUpdateTriggerName(table) &&
    sameFunction(t.function, MECHANICS_FUNCTION) &&
    contentUpdate(t)
  // Тригер авторства (Р-A1-8) — платформний за іменем і функцією; на таблиці
  // з копіями оновлення — окремий тригер з тією самою умовою, що в механіки
  const author = (t: TriggerShape) =>
    (t.name === authorTriggerName(table) &&
      sameFunction(t.function, AUTHOR_FUNCTION)) ||
    (t.name === authorUpdateTriggerName(table) &&
      sameFunction(t.function, AUTHOR_FUNCTION) &&
      contentUpdate(t))
  const carriers = carrierTriggerNames({ schema: key.schema, name: table })
  const carrierFns = carrierFunctionNames({ schema: key.schema, name: table })
  // Тригери копій носіїв — платформні: прийнятого тригера вони не замінюють,
  // навіть коли той кличе функцію з тим самим іменем
  const carrier = (t: TriggerShape) =>
    (t.name === carriers.derive &&
      sameFunction(t.function, carrierFns.derive)) ||
    ((t.name === carriers.propagate || t.name === carriers.propagateInsert) &&
      sameFunction(t.function, carrierFns.propagate))
  // Тригери ефектів дії (Р2b1-12) теж платформні: тригер з їхнім іменем, що
  // кличе функцію ефектів, прийнятого тригера не замінює
  const effects = effectsTriggerNames({ schema: key.schema, name: table })
  const effectsFn = effectsFunctionName({ schema: key.schema, name: table })
  const effect = (t: TriggerShape) =>
    (t.name === effects.all || t.name === effects.update) &&
    sameFunction(t.function, effectsFn)
  const guards = rightsGuardNames({ schema: key.schema, name: table })
  const guard = (t: TriggerShape) =>
    guards.some(
      (entry) =>
        t.name === entry.trigger && sameFunction(t.function, entry.function)
    )
  const platform = (t: TriggerShape) =>
    touch(t) ||
    touchUpdate(t) ||
    author(t) ||
    carrier(t) ||
    effect(t) ||
    guard(t)

  // Механіка спрацьовує й на вставку — ширше за `moddatetime`, і це
  // посилення: дата й версія правильні й на вставці (спека промоції §8).
  // Аргумент тригера — рядок, перейменування колонки його не переписує, тож
  // ім'я колонки береться з мапінгу запису. На таблиці з копіями оновлення
  // тримає лише `<t>_simetra_touch_update` з умовою змісту.
  if (
    adopted.function.name === "moddatetime" &&
    adopted.timing === TRIGGER_BEFORE &&
    adopted.events === TRIGGER_UPDATE &&
    adopted.columns.length === 0 &&
    adopted.when === undefined &&
    adopted.args.length === 1 &&
    c.newColumn(key.schema, table, adopted.args[0]!) === UPDATED_AT
  )
    return {
      replaced: desired.some(content === undefined ? touch : touchUpdate),
    }

  const found = subscriptionShapes(
    desired.filter((t) => !platform(t)),
    isContent
  )
    .filter(
      (s) =>
        !s.special &&
        s.row &&
        sameFunction(s.function, adopted.function) &&
        s.timing === adopted.timing &&
        s.events === adopted.events &&
        sameList(s.args, adopted.args) &&
        s.columns.length === 0
    )
    .some((s) =>
      adopted.columns.length === 0
        ? sameTree(s.when, adopted.when)
        : adopted.when === undefined &&
          sameSet(changedColumns(s.when), adopted.columns)
    )
  if (!found) return { replaced: false }
  return adopted.columns.length === 0
    ? { replaced: true }
    : { replaced: true, narrowed: adopted.columns }
}

/**
 * Логічні тригери підписок: `whenChanged` чи джерело з копіями носіїв дає
 * пару — `<name>` на `UPDATE` з умовою й `<name>_insert` на `INSERT` без неї
 * (`subscriptionTriggerNames`), і разом вони спрацьовують на обидві події.
 * Пара з умовою змісту (`isContent`) — це підписка без умови (Р2a2-20). Без
 * пари тригер — сам по собі.
 */
function subscriptionShapes(
  triggers: readonly TriggerShape[],
  isContent: (when: Node | undefined) => boolean
): TriggerShape[] {
  const byName = new Map(triggers.map((t) => [t.name, t]))
  const paired = new Set<string>()
  const shapes = triggers.map((t) => {
    const insert = byName.get(`${t.name}_insert`)
    // Половина `UPDATE` пари — лише з умовою форми `whenChanged` чи з умовою
    // змісту: інакше два боргові тригери `x` з довільним `WHEN` і `x_insert`
    // зійшли б за пару
    const content = isContent(t.when)
    if (
      insert === undefined ||
      t.events !== TRIGGER_UPDATE ||
      (changedColumns(t.when) === undefined && !content) ||
      insert.events !== TRIGGER_INSERT ||
      insert.when !== undefined ||
      insert.columns.length > 0 ||
      insert.special !== t.special ||
      insert.row !== t.row ||
      insert.timing !== t.timing ||
      !sameFunction(insert.function, t.function) ||
      !sameList(insert.args, t.args)
    )
      return t
    paired.add(insert.name)
    return {
      ...t,
      events: TRIGGER_UPDATE | TRIGGER_INSERT,
      ...(content ? { when: undefined } : {}),
    }
  })
  return shapes.filter((s) => !paired.has(s.name))
}

/**
 * Операнд `old.c` чи `new.c` без `::text`, який Postgres дописує колонці
 * `varchar` у `pg_get_triggerdef`; `cast` — чи він там був. Інше приведення —
 * вираз над колонкою, а не сама колонка, тож воно лишається.
 */
function rowOperand(node: Node): { cast: boolean; node: Node } {
  if (
    "TypeCast" in node &&
    textCast(node.TypeCast) &&
    "ColumnRef" in node.TypeCast.arg!
  ) {
    const [row] = strings(node.TypeCast.arg.ColumnRef.fields)
    if (row === "old" || row === "new")
      return { cast: true, node: node.TypeCast.arg }
  }
  return { cast: false, node }
}

/**
 * Дерево оператора тригера без `::text` над `old.c`/`new.c` в умові `WHEN`:
 * так `pg_get_triggerdef` друкує умову над `varchar`, а генератор — без
 * приведення. Решта дерева — як є.
 */
export function withoutRowTextCasts(stmt: Node): Node {
  if (
    !("CreateTrigStmt" in stmt) ||
    stmt.CreateTrigStmt.whenClause === undefined
  )
    return stmt
  return {
    CreateTrigStmt: {
      ...stmt.CreateTrigStmt,
      whenClause: withoutRowOperandCasts(stmt.CreateTrigStmt.whenClause),
    },
  }
}

/** Умова `WHEN` без `::text` над `old.c`/`new.c` (`withoutRowTextCasts`). */
function withoutRowOperandCasts(node: Node): Node {
  if ("BoolExpr" in node)
    return {
      BoolExpr: {
        ...node.BoolExpr,
        args: node.BoolExpr.args?.map(withoutRowOperandCasts),
      },
    }
  if ("A_Expr" in node) {
    const { lexpr, rexpr } = node.A_Expr
    return {
      A_Expr: {
        ...node.A_Expr,
        ...(lexpr === undefined ? {} : { lexpr: rowOperand(lexpr).node }),
        ...(rexpr === undefined ? {} : { rexpr: rowOperand(rexpr).node }),
      },
    }
  }
  return node
}

/**
 * Колонки умови `whenChanged`: лише `OLD.c IS DISTINCT FROM NEW.c`, з'єднані
 * `OR`. Інша умова — `undefined`: вона не з `whenChanged`. Тінь друкує умову
 * над `varchar` як `(old.c)::text IS DISTINCT FROM (new.c)::text`, тож
 * `::text` знімається, але лише з обох боків разом: однобічне приведення —
 * не та умова, яку дає `whenChanged`.
 */
function changedColumns(when: Node | undefined): string[] | undefined {
  if (when === undefined) return undefined
  const parts =
    "BoolExpr" in when && when.BoolExpr.boolop === "OR_EXPR"
      ? (when.BoolExpr.args ?? [])
      : [when]
  const columns: string[] = []
  for (const part of parts) {
    if (!("A_Expr" in part)) return undefined
    const { kind, name, lexpr, rexpr } = part.A_Expr
    if (kind !== "AEXPR_DISTINCT" || strings(name).join(".") !== "=")
      return undefined
    if (lexpr === undefined || rexpr === undefined) return undefined
    const left = rowOperand(lexpr)
    const right = rowOperand(rexpr)
    if (left.cast !== right.cast) return undefined
    const was = left.node
    const now = right.node
    if (!("ColumnRef" in was) || !("ColumnRef" in now)) return undefined
    const [oldRow, oldColumn, ...restOld] = strings(was.ColumnRef.fields)
    const [newRow, newColumn, ...restNew] = strings(now.ColumnRef.fields)
    if (
      oldRow !== "old" ||
      newRow !== "new" ||
      oldColumn === undefined ||
      oldColumn !== newColumn ||
      restOld.length > 0 ||
      restNew.length > 0
    )
      return undefined
    columns.push(oldColumn)
  }
  return columns
}

const sameFunction = (
  a: { schema: string; name: string },
  b: { schema: string; name: string }
): boolean => a.schema === b.schema && a.name === b.name

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

const sameSet = (
  a: readonly string[] | undefined,
  b: readonly string[]
): boolean =>
  a !== undefined &&
  a.every((v) => b.includes(v)) &&
  b.every((v) => a.includes(v))

/**
 * Умови рівні за деревом без позицій: libpg-query не має депарсу, а текст
 * `pg_get_triggerdef` відрізняється від згенерованого дужками й регістром.
 */
const sameTree = (a: Node | undefined, b: Node | undefined): boolean =>
  JSON.stringify(a === undefined ? null : withoutLocations(a)) ===
  JSON.stringify(b === undefined ? null : withoutLocations(b))
