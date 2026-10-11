import type { TableRename } from "./renames"

/**
 * Модель областей імен оператора: джерела рядків `FROM`, їхні колонки до й
 * після промоції та резолв імені за рівнями — без жодних правок і відмов.
 */

/**
 * Чому набір колонок джерела не доведено. Змінене промоцією ім'я, яке може
 * вести в таке джерело, — відмова з цим кодом: функція, `(вираз).*`,
 * відношення поза моделлю чи вузол, якого переписувач не знає, можуть
 * віддавати колонки промотованої таблиці.
 */
export interface Unproven {
  /**
   * `ambiguous-name` — колонки відомі, але промоція їх змінює (`*` над
   * промотованою таблицею); решта — `unsupported`.
   */
  code: "rewrite.unsupported" | "rewrite.ambiguous-name"
  /** Першопричина для деталі відмови, напр. `the function-call source unnest() in FROM`. */
  source: string
  /** Про джерело вже є проблема: невизначеності через нього не множать відмов. */
  reported?: boolean
}

/**
 * Набір колонок джерела до промоції в порядку виводу. Доведений — лише
 * `columns`; інакше `unproven` обов'язковий: тип не дає збудувати джерело з
 * невідомими колонками без причини, тож нове джерело чи вираз, якого
 * переписувач не розбирає, стає недоведеним, а не мовчки довіреним.
 */
export type Shape =
  | { columns: readonly string[]; unproven?: never }
  | { columns: undefined; unproven: Unproven }

export const REPORTED: Shape = {
  columns: undefined,
  unproven: {
    code: "rewrite.unsupported",
    source: "a source the rewrite has already refused",
    reported: true,
  },
}

export function unproven(
  source: string,
  code: Unproven["code"] = "rewrite.unsupported"
): Shape {
  return { columns: undefined, unproven: { code, source } }
}

/** Джерело рядків у `FROM`; колонки — `Shape`. */
export type Leaf = Shape & {
  refname: string | undefined
  aliased: boolean
  schema?: string
  relname?: string
  table?: TableRename
  /** Індекс UTF-16 відношення в тексті — для відмови за ім'ям джерела. */
  location?: number
}

/** `JOIN` з псевдонімом: внутрішні імена сховані, колонки — їхнє об'єднання. */
export interface Group {
  refname: string
  leaves: Leaf[]
  /** `USING`/`NATURAL` зливає колонки: порядок `*` не моделюється. */
  coalesced: boolean
}

export type Item = { leaf: Leaf } | { group: Group }

/** Рівень запиту: його `FROM` і колонки, злиті `USING`. */
export interface Level {
  items: Item[]
  merged: ReadonlySet<string>
  /** Є `JOIN … USING` чи `NATURAL JOIN`: порядок `*` не моделюється. */
  coalesced: boolean
}

export interface Env {
  /** Від зовнішнього рівня до внутрішнього. */
  levels: readonly Level[]
  /** Видимі CTE: ім'я → колонки виводу. */
  ctes: ReadonlyMap<string, Shape>
}

/** Як обробляється список виводу. */
export interface OutputMode {
  /** Вставляти ` AS <старе>` за голим посиланням на перейменовану колонку. */
  alias: boolean
  /** Імена виводу хтось читає: ім'я, сховане у виразі, — відмова. */
  names: boolean
  /** Кількість і порядок колонок спостерігаються: `*` — зміна контракту. */
  stars: boolean
  /** Верхній список оператора: тут діє `intoRowtypeOf`. */
  top: boolean
}

/** Підсумок обробки посилання на колонку — для ` AS <старе>`. */
export interface RefResult {
  /** Ім'я колонки виводу, яке дає посилання до правок. */
  old: string
  /** Нове ім'я, коли правка змінює саме його (останнє поле). */
  to?: string
  /** Індекс одразу за останнім токеном посилання. */
  end: number
}

/**
 * Імена списку виводу до правок і після, по елементу на ціль (`*` — один
 * елемент, `undefined`); `shape` — колонки виводу як джерела для зовнішнього
 * рівня, з розгорнутими `*`.
 */
export interface Outputs {
  pre: (string | undefined)[]
  post: (string | undefined)[]
  shape: Shape
}

export const KEEP: OutputMode = {
  alias: true,
  names: true,
  stars: true,
  top: false,
}

export function pushLevel(env: Env, level: Level): Env {
  return { levels: [...env.levels, level], ctes: env.ctes }
}

export function leavesOf(item: Item): Leaf[] {
  return "leaf" in item ? [item.leaf] : item.group.leaves
}

/**
 * Джерело за видимим ім'ям, від внутрішнього рівня до зовнішнього; `after` —
 * за іменами після промоції (таблиця без аліасу бачиться під новим ім'ям).
 */
export function findByRefname(
  levels: readonly Level[],
  name: string,
  after: boolean
): Item | undefined {
  for (const level of [...levels].reverse()) {
    const found = level.items.find(
      (i) => (after ? postRefname(i) : preRefname(i)) === name
    )
    if (found !== undefined) return found
  }
  return undefined
}

function preRefname(item: Item): string | undefined {
  return "leaf" in item ? item.leaf.refname : item.group.refname
}

export function postRefname(item: Item): string | undefined {
  if (!("leaf" in item)) return item.group.refname
  const { leaf } = item
  return !leaf.aliased && leaf.table !== undefined
    ? leaf.table.to
    : leaf.refname
}

/** Колонки джерела після промоції; `undefined` — невідомі. */
export function columnsAfter(leaf: Leaf): readonly string[] | undefined {
  return leaf.table !== undefined ? [...leaf.table.columnsAfter] : leaf.columns
}

/** Де резолвиться некваліфікована колонка (як `colNameToVar`). */
export type Located =
  | { leaf: Leaf }
  | { merged: Level }
  | { failed: true }
  | { hits: Leaf[]; unknown: Leaf[] }

/**
 * Перший рівень (від внутрішнього), де ім'я — колонка; `after` — за колонками
 * після промоції. Джерело, про яке вже є відмова, зупиняє пошук: невизначеність
 * через нього відмов не множить.
 */
export function locate(
  name: string,
  innermostFirst: readonly Level[],
  after: boolean
): Located | undefined {
  for (const level of innermostFirst) {
    const leaves = level.items.flatMap(leavesOf)
    // Злите `USING` ім'я доведене, лише коли доведені всі джерела рівня;
    // інакше резолв іде далі й упирається в недоведене джерело.
    if (
      level.merged.has(name) &&
      leaves.every((l) => (after ? columnsAfter(l) : l.columns) !== undefined)
    ) {
      return { merged: level }
    }
    if (leaves.some((l) => l.unproven?.reported === true)) {
      return { failed: true }
    }
    const columns = (l: Leaf) => (after ? columnsAfter(l) : l.columns)
    const hits = leaves.filter((l) => columns(l)?.includes(name) ?? false)
    const unknown = leaves.filter((l) => columns(l) === undefined)
    if (hits.length === 0 && unknown.length === 0) continue
    if (hits.length === 1 && unknown.length === 0) return { leaf: hits[0]! }
    return { hits, unknown }
  }
  return undefined
}

export function levelHas(level: Level, name: string): boolean {
  return (
    level.merged.has(name) ||
    level.items
      .flatMap(leavesOf)
      .some((l) => l.columns === undefined || l.columns.includes(name))
  )
}

/** Колонка рівня після промоції: додана чи нове ім'я перейменованої. */
export function levelHasAfter(level: Level, name: string): boolean {
  return level.items
    .flatMap(leavesOf)
    .some((l) => columnsAfter(l)?.includes(name) ?? false)
}

/** Відношення моделі в `FROM` з доведеними колонками, а не підзапит, CTE чи функція. */
export function isRelation(leaf: Leaf): boolean {
  return leaf.relname !== undefined && leaf.columns !== undefined
}

/**
 * Колонки джерела під списком псевдонімів (`AS s(a, b)`): псевдоніми
 * перейменовують перші колонки, решта лишає свої імена.
 */
export function aliasShape(shape: Shape, aliases: string[] | undefined): Shape {
  if (shape.columns === undefined || aliases === undefined) return shape
  return { columns: [...aliases, ...shape.columns.slice(aliases.length)] }
}

/** Розгортання `*`: колонки й чи доведена хоча б їхня кількість. */
export interface StarExpansion {
  shape: Shape
  /** Кількість колонок не доведена: `*` у списку виводу — зміна контракту. */
  arity: boolean
}

/**
 * `*` над джерелами: доведене лише над джерелами з доведеними колонками, без
 * промотованої таблиці (її `*` промоція змінює — звіт `star` окремо) і без
 * злиття колонок `USING`/`NATURAL`, порядку якого переписувач не моделює.
 */
export function starShape(
  leaves: readonly Leaf[],
  coalesced: boolean
): StarExpansion {
  const reported = leaves.find((l) => l.unproven?.reported === true)
  if (reported !== undefined) return { shape: REPORTED, arity: false }
  for (const leaf of leaves) {
    if (leaf.columns === undefined) {
      return {
        shape: { columns: undefined, unproven: leaf.unproven },
        arity: true,
      }
    }
  }
  const promoted = leaves.find((l) => l.table !== undefined)
  if (promoted?.table !== undefined) {
    return {
      shape: unproven(
        `a star over promoted table "${promoted.table.from}"`,
        "rewrite.ambiguous-name"
      ),
      arity: false,
    }
  }
  if (coalesced) {
    return {
      shape: unproven(
        "a star over a JOIN with USING or NATURAL, whose column order the rewrite does not model"
      ),
      arity: false,
    }
  }
  return {
    shape: { columns: leaves.flatMap((l) => l.columns ?? []) },
    arity: false,
  }
}
