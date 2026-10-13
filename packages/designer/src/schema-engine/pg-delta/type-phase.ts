import {
  encodeId,
  FactBase,
  type DependencyEdge,
  type Fact,
  type StableId,
} from "@supabase/pg-delta"

/** Обмеження домену — дочірній факт домену, тип без нього неповний. */
function isTypeFact(fact: Fact): boolean {
  const { kind } = fact.id
  return (
    kind === "type" ||
    kind === "domain" ||
    kind === "typeAttribute" ||
    (kind === "constraint" && fact.parent?.kind === "domain")
  )
}

/**
 * Бажаний стан фази 1 копії доказу (рішення 1 плану П3-2b-0): засіяна копія
 * плюс типи цілі (енами, складені, діапазони, домени з обмеженнями) із
 * замиканням їхніх залежностей. Двигун не вбудовує в `CREATE TABLE` колонку
 * типу, створеного пізніше за таблицю, і ставить її в кінець; коли типи вже
 * є, план «копія → ціль» відтворює порядок колонок цілі.
 *
 * Засіяні факти — усі й у своєму вигляді: без них план фази 1 зняв би
 * засіяне (гранти пресету), а свій вигляд — щоб фаза 1 нічого, крім типів, не
 * змінювала; решту зводить фаза 2. Замикання — за ребрами (тип потребує
 * схему, роль, функцію перевірки) і за батьками: `FactBase` відмовляє
 * дочірньому факту без батька. Засіяні факти далі не розгортаються — копія
 * їх уже має разом із залежностями.
 *
 * `undefined` — фаза не потрібна (нових типів немає) або неможлива
 * (замикання тягне таблицю, якої копія ще не має): тоді копія однофазна.
 */
export function typePhase(
  seeded: FactBase,
  target: FactBase
): FactBase | undefined {
  const added = new Map<string, Fact>()
  const pending = target
    .facts()
    .filter((f) => isTypeFact(f) && !seeded.has(f.id))
  if (pending.length === 0) return undefined
  while (pending.length > 0) {
    const fact = pending.pop()!
    const key = encodeId(fact.id)
    if (added.has(key)) continue
    if (fact.id.kind === "table") return undefined
    added.set(key, fact)
    const needs = [
      ...(fact.parent === undefined ? [] : [fact.parent]),
      ...target.outgoingEdges(fact.id).map((e) => e.to),
    ]
    for (const id of needs) {
      if (seeded.has(id)) continue
      const next = target.get(id)
      // Ребро на факт поза витягом (роль поза межею) лишається без кінця й
      // нижче відпадає, як у будь-якій проєкції двигуна
      if (next !== undefined) pending.push(next)
    }
  }
  const facts = [...seeded.facts(), ...added.values()]
  const present = (id: StableId) => seeded.has(id) || added.has(encodeId(id))
  // Ребра цілі — лише від доданих фактів: ребро цілі між засіяними фактами
  // (інший власник схеми) змінило б засіяне вже у фазі 1
  const edges = new Map<string, DependencyEdge>()
  for (const edge of [
    ...seeded.edges,
    ...target.edges.filter((e) => added.has(encodeId(e.from))),
  ]) {
    if (!present(edge.from) || !present(edge.to)) continue
    const key = `${encodeId(edge.from)}\u0000${encodeId(edge.to)}\u0000${edge.kind}`
    if (!edges.has(key)) edges.set(key, edge)
  }
  return new FactBase(
    facts,
    [...edges.values()],
    seeded.source,
    seeded.referenceOnly
  )
}
