import {
  encodeId,
  FactBase,
  type DependencyEdge,
  type Fact,
  type StableId,
} from "@supabase/pg-delta"

const edgeKey = (edge: DependencyEdge) =>
  `${encodeId(edge.from)}\u0000${encodeId(edge.to)}\u0000${edge.kind}`

/** Чи досягає `start` за ребрами цілі (будь-якого виду, транзитивно) одного з `goals`. */
function reaches(
  target: FactBase,
  start: StableId,
  goals: ReadonlySet<string>
): boolean {
  const seen = new Set<string>([encodeId(start)])
  const stack = [start]
  while (stack.length > 0) {
    for (const edge of target.outgoingEdges(stack.pop()!)) {
      const next = encodeId(edge.to)
      if (goals.has(next)) return true
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(edge.to)
    }
  }
  return false
}

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
 * Таблиця, де колонка за ребрами цілі досягає пізнішої сусідки (згенерована
 * колонка з посиланням уперед), ребер не дістає: ланцюг дав би цикл, а такий
 * порядок відтворює лише вбудований `CREATE TABLE`, якого двигун для
 * згенерованої колонки не видає. План лишається, як без ребер, і розбіжність
 * порядку чесно дає `plan.clone-mismatch`.
 */
export function withColumnOrder(source: FactBase, target: FactBase): FactBase {
  const edges = new Map<string, DependencyEdge>()
  for (const edge of target.edges) edges.set(edgeKey(edge), edge)
  for (const table of target.facts()) {
    if (table.id.kind !== "table" || source.has(table.id)) continue
    const columns = target
      .childrenOf(table.id)
      .filter((c: Fact) => c.id.kind === "column")
      .sort((a, b) => Number(a.payload._position) - Number(b.payload._position))
    if (forwardReference(target, columns)) continue
    for (let k = 1; k < columns.length; k++) {
      const edge: DependencyEdge = {
        from: columns[k]!.id,
        to: columns[k - 1]!.id,
        kind: "depends",
      }
      const key = edgeKey(edge)
      if (!edges.has(key)) edges.set(key, edge)
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

/** Чи досягає якась колонка за ребрами цілі колонки з більшим `attnum`. */
function forwardReference(target: FactBase, columns: Fact[]): boolean {
  for (let i = 0; i < columns.length - 1; i++) {
    const later = new Set(columns.slice(i + 1).map((c) => encodeId(c.id)))
    if (reaches(target, columns[i]!.id, later)) return true
  }
  return false
}
