import {
  makeObjectName,
  quoteIdent,
  type DatabaseProvider,
  type PhysicalColumn,
  type PhysicalSnapshot,
  type PhysicalTable,
} from "simetra/model"
import type { QualifiedName } from "../contracts"
import { compareStrings } from "../diagnostics"
import { dollarTag } from "../movement-functions"
import type { CreationNode } from "../sql/dependencies"
import { executeGrants } from "../sql/execute-grants"
import type { SqlParser } from "../sql/parse"
import { generatedUnit, type SqlUnit } from "../sql/units"
import { fieldForeignKey } from "../stages/model"

/** Мітки імен тригерів і функцій носіїв — алгоритм імен Postgres від таблиці. */
const DERIVE_LABEL = "simetra_carriers"
const PROPAGATE_LABEL = "simetra_carriers_out"
const PROPAGATE_INSERT_LABEL = "simetra_carriers_out_insert"

/**
 * Імена тригерів копій носіїв на таблиці: `derive` — на таблиці з копіями,
 * обидва тригери поширення — на таблиці-джерелі. Алгоритм Postgres тримає
 * мітку цілою, тож промоція й зворотна генерація впізнають їх за іменем і на
 * довгій таблиці.
 */
export function carrierTriggerNames(table: QualifiedName): {
  derive: string
  propagate: string
  propagateInsert: string
} {
  return {
    derive: makeObjectName(table.name, undefined, DERIVE_LABEL),
    propagate: makeObjectName(table.name, undefined, PROPAGATE_LABEL),
    propagateInsert: makeObjectName(
      table.name,
      undefined,
      PROPAGATE_INSERT_LABEL
    ),
  }
}

/**
 * Функції носіїв у схемі таблиці: виведення — на таблиці з копіями,
 * поширення — одна на джерело для обох його тригерів.
 */
export function carrierFunctionNames(table: QualifiedName): {
  derive: QualifiedName
  propagate: QualifiedName
} {
  const names = carrierTriggerNames(table)
  return {
    derive: { schema: table.schema, name: names.derive },
    propagate: { schema: table.schema, name: names.propagate },
  }
}

/** Колонки-копії носіїв таблиці (спека прав §5.2, Р2a2-5). */
export function carrierCopies(
  table: Pick<PhysicalTable, "columns">
): PhysicalColumn[] {
  return table.columns.filter((c) => c.origin.copyOf !== undefined)
}

/**
 * Зв'язок таблиці з копіями з її джерелом через одну локальну колонку:
 * усі копії, що читають те саме джерело через ту саму колонку, виводить
 * один запит. `pairs` — колонки складеного FK зв'язку (локальна → джерела) у
 * його порядку: рядок джерела — саме той, на який уже вказує FK у тому самому
 * скоупі. У ТЧ кореня скоуп і є `parent_id`, тож FK — одна пара, і умова
 * скоупу не дублюється.
 */
interface CarrierLink {
  table: PhysicalTable
  source: PhysicalTable
  through: string
  pairs: { local: string; source: string }[]
  /** Копії зв'язку в порядку колонок таблиці: ім'я й колонка джерела. */
  copies: { name: string; column: string }[]
}

const tableKey = (t: { schema: string; name: string }) =>
  `${t.schema}.${t.name}`

/**
 * Зв'язки копій знімка. Копію будує стадія 1 лише там, де FK зв'язку й
 * таблиця джерела є, тож їхня відсутність — дефект компілятора.
 */
function carrierLinks(
  physical: Pick<PhysicalSnapshot, "tables">
): CarrierLink[] {
  const byKey = new Map(physical.tables.map((t) => [tableKey(t), t]))
  const links: CarrierLink[] = []
  for (const table of physical.tables) {
    const groups = new Map<string, CarrierLink>()
    for (const column of carrierCopies(table)) {
      const copyOf = column.origin.copyOf!
      const key = `${tableKey(copyOf.table)}\0${copyOf.through}`
      let link = groups.get(key)
      if (link === undefined) {
        const source = byKey.get(tableKey(copyOf.table))
        const fk = fieldForeignKey(table, copyOf.through)
        if (
          source === undefined ||
          fk === undefined ||
          tableKey({
            schema: fk.references.schema,
            name: fk.references.table,
          }) !== tableKey(source)
        ) {
          throw new Error(
            `internal: carrier copy ${tableKey(table)}.${column.name} has no link to ${tableKey(copyOf.table)}`
          )
        }
        link = {
          table,
          source,
          through: copyOf.through,
          pairs: fk.columns.map((local, i) => ({
            local,
            source: fk.references.columns[i]!,
          })),
          copies: [],
        }
        groups.set(key, link)
      }
      link.copies.push({ name: column.name, column: copyOf.column })
    }
    links.push(
      ...[...groups.values()].sort(
        (a, b) =>
          compareStrings(tableKey(a.source), tableKey(b.source)) ||
          compareStrings(a.through, b.through)
      )
    )
  }
  return links
}

/** Функція носіїв знімка: таблиця, на якій її тригери, і її роль. */
export interface CarrierFunction {
  table: PhysicalTable
  fn: QualifiedName
  role: "derive" | "propagate"
}

/**
 * Функції носіїв знімка — спільні для генератора й перевірки колізій імен
 * функцій стадії 4 (`derivedFunctions`, Р2a2-22).
 */
export function carrierFunctions(
  physical: PhysicalSnapshot
): CarrierFunction[] {
  const links = carrierLinks(physical)
  const derived = new Map<string, PhysicalTable>()
  const sources = new Map<string, PhysicalTable>()
  for (const link of links) {
    derived.set(tableKey(link.table), link.table)
    sources.set(tableKey(link.source), link.source)
  }
  return [
    ...[...derived.values()].map((table): CarrierFunction => ({
      table,
      fn: carrierFunctionNames(table).derive,
      role: "derive",
    })),
    ...[...sources.values()].map((table): CarrierFunction => ({
      table,
      fn: carrierFunctionNames(table).propagate,
      role: "propagate",
    })),
  ]
}

const q = quoteIdent
const relation = (t: { schema: string; name: string }) =>
  `${q(t.schema)}.${q(t.name)}`

/**
 * Генератор `carriers` (спека прав §5.2, Р2a2-7): копії носіїв пише лише
 * платформа. На кожну таблицю з копіями — функція й `BEFORE INSERT OR
 * UPDATE` тригер виведення; на кожну таблицю-джерело — функція й два
 * тригери поширення (`AFTER UPDATE` з `WHEN` і `AFTER INSERT`: тригер має
 * одну умову на всі події, а на вставці `OLD` немає). `EXECUTE` — нікому:
 * тригер спрацьовує в ролі, яка пише, і права виконання функції не потребує
 * (платформна спека §6.7). Тіла plpgsql граф не читає, тож таблиці тіла —
 * явні ребра `requires`.
 */
export function buildCarrierUnits(
  physical: PhysicalSnapshot,
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  const links = carrierLinks(physical)
  if (links.length === 0) return []
  const units: SqlUnit[] = []
  const unit = (
    table: PhysicalTable,
    sql: string,
    requires?: readonly CreationNode[]
  ): SqlUnit => ({
    ...generatedUnit(sql, table.schema, parse),
    ownerObjectId: table.origin.objectId,
    module,
    generator: "carriers",
    ...(requires === undefined ? {} : { requires }),
  })
  const tableNode = (t: PhysicalTable): CreationNode => ({
    type: "table",
    schema: t.schema,
    name: t.name,
  })
  const byTable = (pick: (link: CarrierLink) => PhysicalTable) => {
    const groups = new Map<string, CarrierLink[]>()
    for (const link of links) {
      const key = tableKey(pick(link))
      groups.set(key, [...(groups.get(key) ?? []), link])
    }
    return [...groups.values()]
  }
  for (const group of byTable((l) => l.table)) {
    const table = group[0]!.table
    const fn = carrierFunctionNames(table).derive
    const sources = uniqueTables(group.map((l) => l.source))
    units.push(
      unit(table, deriveFunction(fn, group), sources.map(tableNode)),
      ...executeGrants(`${relation(fn)}()`, [], provider).map((sql) =>
        unit(table, sql)
      ),
      unit(
        table,
        `CREATE TRIGGER ${q(carrierTriggerNames(table).derive)} BEFORE INSERT OR UPDATE ON ${relation(table)} FOR EACH ROW EXECUTE FUNCTION ${relation(fn)}();`
      )
    )
  }
  for (const group of byTable((l) => l.source)) {
    const source = group[0]!.source
    const fn = carrierFunctionNames(source).propagate
    const names = carrierTriggerNames(source)
    const dependents = uniqueTables(group.map((l) => l.table))
    const read = new Set(group.flatMap((l) => l.copies.map((c) => c.column)))
    // Умова — за кожною колонкою, яку читає будь-яка копія (зокрема копією:
    // ТЧ копіює копію шляху власника). Двоходова зміна сходиться: поширення
    // пише лише рядки, чия копія `IS DISTINCT FROM` нового значення, тож
    // крок, що нічого не змінив, наступного не запускає, а самопосилання не
    // зациклюється.
    const changed = source.columns
      .filter((c) => read.has(c.name))
      .map((c) => `(OLD.${q(c.name)} IS DISTINCT FROM NEW.${q(c.name)})`)
      .join(" OR ")
    const execute = `EXECUTE FUNCTION ${relation(fn)}();`
    units.push(
      unit(source, propagateFunction(fn, group), dependents.map(tableNode)),
      ...executeGrants(`${relation(fn)}()`, [], provider).map((sql) =>
        unit(source, sql)
      ),
      unit(
        source,
        `CREATE TRIGGER ${q(names.propagate)} AFTER UPDATE ON ${relation(source)} FOR EACH ROW WHEN (${changed}) ${execute}`
      ),
      // Вставка — без умови: залежний рядок, записаний раніше за джерело в
      // тому самому операторі (CTE `INSERT … INSERT`, самопосилання в
      // багаторядковому `INSERT`), інакше лишився б з копією `NULL`. FK
      // перевіряється в кінці оператора, тож такий рядок легальний.
      unit(
        source,
        `CREATE TRIGGER ${q(names.propagateInsert)} AFTER INSERT ON ${relation(source)} FOR EACH ROW ${execute}`
      )
    )
  }
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}

function uniqueTables(tables: readonly PhysicalTable[]): PhysicalTable[] {
  return [...new Map(tables.map((t) => [tableKey(t), t])).values()].sort(
    (a, b) => compareStrings(tableKey(a), tableKey(b))
  )
}

/** `s.<джерело> = NEW.<локальна> AND …` за колонками FK зв'язку. */
function sourceRow(link: CarrierLink): string {
  return link.pairs
    .map((p) => `s.${q(p.source)} = NEW.${q(p.local)}`)
    .join(" AND ")
}

/**
 * Виведення копій (Р2a2-7). Значення з запиту ніколи не стає копією: на
 * вставці й на зміні зв'язку (колонки FK — `through` і скоуп) копії
 * виводяться з рядка джерела під `FOR SHARE` — вставка рядка ТЧ чекає на
 * блокування власника, тож одночасна зміна носія власника не лишить її зі
 * старою копією. На решті оновлень копія, рівна `OLD`, лишається, а змінена
 * — перевиводиться звичайним `SELECT` джерела.
 */
function deriveFunction(
  fn: QualifiedName,
  links: readonly CarrierLink[]
): string {
  const body: string[] = ["BEGIN"]
  for (const link of links) {
    const from = `FROM ${relation(link.source)} s WHERE ${sourceRow(link)}`
    const linkChanged = link.pairs
      .map((p) => `NEW.${q(p.local)} IS DISTINCT FROM OLD.${q(p.local)}`)
      .join(" OR ")
    body.push(
      `  IF TG_OP = 'INSERT' OR ${linkChanged} THEN`,
      `    SELECT ${link.copies.map((c) => `s.${q(c.column)}`).join(", ")}`,
      `      INTO ${link.copies.map((c) => `NEW.${q(c.name)}`).join(", ")}`,
      `      ${from}`,
      "      FOR SHARE;",
      "  ELSE"
    )
    // Зв'язок не змінився: власника не блокуємо, тож `UPDATE` рядка ТЧ
    // проти `UPDATE` власника в іншій сесії не дає `40P01`. Незмінена копія
    // лишається. Змінена — це або поширення (воно теж `UPDATE`), і тоді
    // `SELECT` джерела в тій самій транзакції повертає те саме нове
    // значення, тож поширення виживає, або підробка запиту, і її замінює
    // значення джерела.
    for (const copy of link.copies) {
      body.push(
        `    IF NEW.${q(copy.name)} IS DISTINCT FROM OLD.${q(copy.name)} THEN`,
        `      SELECT s.${q(copy.column)} INTO NEW.${q(copy.name)} ${from};`,
        "    END IF;"
      )
    }
    body.push("  END IF;")
  }
  body.push("  RETURN NEW;", "END")
  return definerTrigger(fn, body.join("\n"))
}

/**
 * Поширення копій (Р2a2-7): залежні рядки, що вказують на рядок джерела
 * через FK зв'язку, отримують нове значення, лише якщо їхня копія від нього
 * відрізняється. Тригер виведення залежної таблиці перевиводить змінені
 * копії з джерела, тож значення однакове.
 */
function propagateFunction(
  fn: QualifiedName,
  links: readonly CarrierLink[]
): string {
  const ordered = [...links].sort(
    (a, b) =>
      compareStrings(tableKey(a.table), tableKey(b.table)) ||
      compareStrings(a.through, b.through)
  )
  const body: string[] = ["BEGIN"]
  for (const link of ordered) {
    const set = link.copies
      .map((c) => `${q(c.name)} = NEW.${q(c.column)}`)
      .join(", ")
    const row = link.pairs
      .map((p) => `d.${q(p.local)} = NEW.${q(p.source)}`)
      .join(" AND ")
    const differs = link.copies
      .map((c) => `d.${q(c.name)} IS DISTINCT FROM NEW.${q(c.column)}`)
      .join(" OR ")
    body.push(
      `  UPDATE ${relation(link.table)} d SET ${set}`,
      `    WHERE ${row} AND (${differs});`
    )
  }
  body.push("  RETURN NULL;", "END")
  return definerTrigger(fn, body.join("\n"))
}

/** Оператор кроку даних копій носіїв: таблиця з копіями, джерело й SQL. */
export interface CarrierBackfillStatement {
  table: QualifiedName
  source: QualifiedName
  /** Колонки-копії, які пише оператор: за ними план вирішує клас кроку. */
  columns: string[]
  sql: string
}

/**
 * SQL кроку даних копій носіїв (спека прав §5.2, Р2b2-2): один `UPDATE` на
 * зв'язок (таблиця з копіями, `through`) з очікуваними копіями. Пари й
 * колонки — ті самі зв'язки, що будують тригери виведення й поширення, тож
 * значення копії бере лише рядок, на який указує складений FK (Р2a2-8,
 * Р2a2-27). Форма — виведення тригера: підзапит у `SET` дає `NULL`, коли
 * рядка джерела немає, тож рядок з `NULL` у зв'язку отримує `NULL`-копію, а
 * не лишає старе значення під іменем копії (`UPDATE … FROM` з внутрішнім
 * з'єднанням його б пропустив, Р2a2-11). Умова — `IS DISTINCT FROM` по
 * кожній колонці: Postgres не порівнює рядок з підзапитом цим оператором, а
 * `ROW(…)` вважав би рядок без зв'язку з `NULL`-копіями відмінним щоразу й
 * будив би підписки; узгоджених рядків крок не чіпає. `BEFORE`-тригер
 * носіїв на цьому `UPDATE` перевиводить змінену копію з того самого
 * джерела — значення з `SET` перезаписується тим самим. Крок іде під
 * `search_path` транзакції, тож кожне ім'я кваліфіковане, а рівність —
 * `OPERATOR(pg_catalog.=)`.
 *
 * Порядок (Р2b2-3): оператор, чия копія читає іншу очікувану копію (копія
 * ТЧ читає копію шляху власника), — після неї; решта — за таблицею й
 * `through`. Поширення й так дописує наступний крок, тож другий оператор
 * знаходить рядки вже узгодженими, а план лишається детермінованим.
 */
export function carrierBackfillStatements(
  physical: Pick<PhysicalSnapshot, "tables">,
  pending: readonly { table: QualifiedName; columns: readonly string[] }[]
): CarrierBackfillStatement[] {
  const wanted = new Map<string, Set<string>>()
  for (const entry of pending) {
    const key = tableKey(entry.table)
    const columns = wanted.get(key) ?? new Set<string>()
    for (const c of entry.columns) columns.add(c)
    wanted.set(key, columns)
  }
  const byTable = new Map(physical.tables.map((t) => [tableKey(t), t]))
  for (const [key, columns] of wanted) {
    const table = byTable.get(key)
    for (const column of columns) {
      if (
        table === undefined ||
        table.columns.find((c) => c.name === column)?.origin.copyOf ===
          undefined
      ) {
        throw new Error(
          `internal: pending carrier ${key}.${column} is not a copy in the desired snapshot`
        )
      }
    }
  }
  const backfills = carrierLinks(physical)
    .map((link) => {
      const columns = wanted.get(tableKey(link.table))
      return {
        link,
        copies: link.copies.filter((c) => columns?.has(c.name) === true),
      }
    })
    .filter((b) => b.copies.length > 0)
    .sort(
      (a, b) =>
        compareStrings(a.link.table.schema, b.link.table.schema) ||
        compareStrings(a.link.table.name, b.link.table.name) ||
        compareStrings(a.link.through, b.link.through)
    )
  // Хто пише кожну очікувану копію: оператор, що читає її з джерела, — після.
  type Backfill = (typeof backfills)[number]
  const writer = new Map<string, Backfill>()
  for (const b of backfills) {
    for (const c of b.copies)
      writer.set(`${tableKey(b.link.table)}\0${c.name}`, b)
  }
  const ordered: Backfill[] = []
  const state = new Map<Backfill, "visiting" | "done">()
  const visit = (b: Backfill) => {
    if (state.get(b) === "done") return
    if (state.get(b) === "visiting") {
      throw new Error(
        `internal: carrier copies of ${tableKey(b.link.table)} read each other`
      )
    }
    state.set(b, "visiting")
    for (const c of b.copies) {
      const read = writer.get(`${tableKey(b.link.source)}\0${c.column}`)
      if (read !== undefined) visit(read)
    }
    state.set(b, "done")
    ordered.push(b)
  }
  for (const b of backfills) visit(b)
  return ordered.map(({ link, copies }) => {
    const from =
      `FROM ${relation(link.source)} AS s WHERE ` +
      link.pairs
        .map((p) => `s.${q(p.source)} OPERATOR(pg_catalog.=) d.${q(p.local)}`)
        .join(" AND ")
    const differs = copies
      .map(
        (c) =>
          `d.${q(c.name)} IS DISTINCT FROM (SELECT s.${q(c.column)} ${from})`
      )
      .join(" OR ")
    return {
      table: { schema: link.table.schema, name: link.table.name },
      source: { schema: link.source.schema, name: link.source.name },
      columns: copies.map((c) => c.name),
      sql:
        `UPDATE ${relation(link.table)} AS d SET (${copies.map((c) => q(c.name)).join(", ")}) = ` +
        `(SELECT ${copies.map((c) => `s.${q(c.column)}`).join(", ")} ${from}) ` +
        `WHERE ${differs};`,
    }
  })
}

/**
 * `SECURITY DEFINER` (Р2a2-8): `FOR SHARE` вимагає права `UPDATE` на
 * джерело, а той, хто пише рядок, може не мати права навіть читати його;
 * поширення ж пише залежні рядки, яких автор зміни джерела не бачить.
 * Безпечно, бо значення копії береться лише з рядка, на який уже вказує
 * складений FK у тому самому скоупі, а в запит функція нічого не віддає,
 * крім `NEW` з виведеними копіями. Порожній `search_path` і кваліфіковані
 * відношення не лишають простору для підміни імен.
 */
function definerTrigger(fn: QualifiedName, text: string): string {
  const tag = dollarTag(text)
  return (
    `CREATE OR REPLACE FUNCTION ${relation(fn)}()\n` +
    `RETURNS trigger\n` +
    `LANGUAGE plpgsql SECURITY DEFINER\n` +
    `SET search_path = ''\n` +
    `AS ${tag}\n${text}\n${tag};`
  )
}
