import {
  encodeId,
  FactBase,
  type DependencyEdge,
  type Fact,
  type StableId,
} from "@supabase/pg-delta"

const edgeKey = (edge: DependencyEdge) =>
  `${encodeId(edge.from)}\u0000${encodeId(edge.to)}\u0000${edge.kind}`

/**
 * Бажаний стан плану копії доказу з порядком колонок нових таблиць: ціль
 * плюс ребра `c[k+1] → c[k]` між сусідніми за `_position` (`attnum`)
 * колонками кожної таблиці, якої копія ще не має.
 *
 * Чому ребра. Двигун створює таблицю порожньою й додає колонки окремо, а
 * компакція вбудовує в `CREATE TABLE` лише ті, чиї власні попередники вже
 * виконано. Згенерована колонка не вбудовується ніколи (вираз посилається на
 * інші колонки), а колонка, чий тип чи функція виразу створюється після
 * таблиці, — теж; колонки з більшим `attnum` компакція згортає повз них, і
 * невбудовна колонка опиняється в кінці. Ребро від наступної колонки до
 * попередньої — факт фізичної історії таблиці («колонку N+1 створено після
 * N»): `topoSort` не випустить колонку раніше за попередню, а компакція не
 * згорне її, поки попередня лишається окремим `ADD COLUMN`. Колонки до першої
 * невбудовної йдуть у `CREATE TABLE`, решта — `ADD COLUMN` у порядку цілі.
 *
 * Таблиця, де колонка досягає пізнішої сусідки (згенерована колонка чи
 * DEFAULT з посиланням уперед, CHECK домену з функцією, що читає пізнішу
 * колонку), ребер не дістає: ланцюг дав би цикл, а такий порядок відтворює
 * лише вбудований `CREATE TABLE`, якого двигун для цих колонок не видає. План
 * лишається, як без ребер, і розбіжність порядку чесно дає
 * `plan.clone-mismatch`. Досяжність рахується на графі «ребра цілі плюс
 * синтетичні ребра вже прийнятих нових таблиць» (див. `forwardReference`),
 * тож із двох нових таблиць, чиї ланцюги разом замкнули б цикл, ребра
 * дістає лише перша, а друга лишається без них.
 *
 * Нові таблиці обробляються за ідентичністю (`encodeId` факту таблиці), а не
 * за порядком ітерації фактів: яка з двох взаємозалежних таблиць лишиться без
 * ребер — а отже, і SQL плану копії — не залежить від того, в якому порядку
 * екстрактор чи компілятор подали факти.
 */
export function withColumnOrder(source: FactBase, target: FactBase): FactBase {
  const edges = new Map<string, DependencyEdge>()
  const outgoing = new Map<string, StableId[]>()
  const add = (edge: DependencyEdge) => {
    const key = edgeKey(edge)
    if (edges.has(key)) return
    edges.set(key, edge)
    const from = encodeId(edge.from)
    const list = outgoing.get(from)
    if (list === undefined) outgoing.set(from, [edge.to])
    else list.push(edge.to)
  }
  for (const edge of target.edges) add(edge)
  const newTables = target
    .facts()
    .filter((t) => t.id.kind === "table" && !source.has(t.id))
    .map((t) => ({ id: t.id, key: encodeId(t.id) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  for (const table of newTables) {
    const columns = target
      .childrenOf(table.id)
      .filter((c: Fact) => c.id.kind === "column")
      .sort((a, b) => Number(a.payload._position) - Number(b.payload._position))
    if (forwardReference(target, outgoing, table.id, columns)) continue
    for (let k = 1; k < columns.length; k++) {
      add({ from: columns[k]!.id, to: columns[k - 1]!.id, kind: "depends" })
    }
  }
  const ordered = new FactBase(
    target.facts(),
    [...edges.values()],
    target.source,
    target.referenceOnly
  )
  // Конструктор не переносить діагностики, а `plan()` читає їх із бажаного
  // стану (відмова на невключованих інтентах, межа нечитаних user mapping):
  // без перенесення копія мовчки обійшла б ці запобіжники. Ідіома двигуна —
  // дописати після побудови, як `extract.ts` після перебудови бази
  ordered.diagnostics.push(...target.diagnostics)
  return ordered
}

/**
 * Чи досягає якась колонка таблиці колонки з більшим `attnum` на графі
 * `outgoing` (ребра цілі плюс синтетичні ребра прийнятих таблиць).
 *
 * Двигун упорядковує не факти, а дії, і дія залежить від ребер усіх фактів,
 * які вона створює: `ADD COLUMN … DEFAULT` створює й факт `default`,
 * `CREATE DOMAIN` — обмеження домену. Які саме нащадки дія вбудовує, вирішують
 * правила двигуна; повторювати їх тут означало б мовчки розійтися з ними на
 * оновленні. Тому обхід консервативний: з кожного досягнутого факту він іде
 * й ребрами, й униз до всіх нащадків за `parent`. Зайвий нащадок лише зайво
 * лишає таблицю без ребер — безпечний бік.
 *
 * Униз не спускаємось лише з предків самої таблиці (таблиця, її схема): дія
 * колонки споживає таблицю, тож якби дія предка справді вбудовувала нащадка,
 * що досягає пізнішої колонки, цикл був би й без синтетичних ребер. А спуск
 * зі схеми досягав би всього в ній і позбавив би ребер кожну таблицю, чия
 * колонка посилається на тип своєї схеми.
 * Ціллю є й нащадки пізніших колонок: їх створює та сама дія.
 */
function forwardReference(
  target: FactBase,
  outgoing: ReadonlyMap<string, readonly StableId[]>,
  table: StableId,
  columns: Fact[]
): boolean {
  const opaque = new Set<string>()
  for (let id: StableId | undefined = table; id !== undefined;) {
    const key = encodeId(id)
    if (opaque.has(key)) break
    opaque.add(key)
    id = target.get(id)?.parent
  }
  for (let i = 0; i < columns.length - 1; i++) {
    const later = new Set<string>()
    for (const c of columns.slice(i + 1)) addSubtree(target, c.id, later)
    if (reaches(target, outgoing, opaque, columns[i]!.id, later)) return true
  }
  return false
}

function addSubtree(target: FactBase, id: StableId, into: Set<string>): void {
  const key = encodeId(id)
  if (into.has(key)) return
  into.add(key)
  for (const child of target.childrenOf(id)) addSubtree(target, child.id, into)
}

/**
 * Чи досягає `start` одного з `goals` за ребрами `outgoing` (будь-якого виду,
 * транзитивно) і спуском до нащадків усіх фактів, крім `opaque`.
 */
function reaches(
  target: FactBase,
  outgoing: ReadonlyMap<string, readonly StableId[]>,
  opaque: ReadonlySet<string>,
  start: StableId,
  goals: ReadonlySet<string>
): boolean {
  const seen = new Set<string>([encodeId(start)])
  const stack = [start]
  while (stack.length > 0) {
    const current = stack.pop()!
    const currentKey = encodeId(current)
    const next = [...(outgoing.get(currentKey) ?? [])]
    if (!opaque.has(currentKey)) {
      for (const child of target.childrenOf(current)) next.push(child.id)
    }
    for (const id of next) {
      const key = encodeId(id)
      if (goals.has(key)) return true
      if (seen.has(key)) continue
      seen.add(key)
      stack.push(id)
    }
  }
  return false
}
