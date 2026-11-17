import {
  CommandFailure,
  keysetFilter,
  type Filter,
  type OrderBy,
} from "simetra/model"
import type { Form } from "./forms"
import { nullableOf } from "./filter"
import { readOne, serverRow, type CoreSource, type RowsQuery } from "./source"
import type { GenerationToken, Key, ServerRow, Values, ViewSpec } from "./types"

/*
 * Вікно (спека П4-B §6.4 «Вікно `useRows`»): сторінки keyset-читання в
 * серверному порядку. Модуль не знає сховища — лише склад вікна й побудову
 * та читання однієї сторінки; запис рядків і власність — `readers.ts`.
 * Вікно не тримає значень рядків (Р8): сторінка — ключі й курсор, значення
 * показує рядок `ObjectStore`.
 */

/** The sort columns of a row and its key: the keyset boundary of a page. */
export interface WindowCursor {
  readonly values: Values
  readonly key: Key
}

/**
 * The lower bound a page was read with: `start` — from the first row of the
 * order; `after` — strictly after the last row of the previous page at the
 * moment of the read; `from` — from the page's own first row inclusive, while
 * the previous page is unknown (a page read by `loadBefore`).
 */
export type WindowLower =
  | { readonly kind: "start" }
  | { readonly kind: "after"; readonly cursor: WindowCursor }
  | { readonly kind: "from"; readonly cursor: WindowCursor }

/** One page of the window. */
export interface WindowPage {
  readonly keys: readonly Key[]
  readonly lower: WindowLower
  /** The generation of the read that wrote the page (Р9). */
  readonly generation: number
}

/** The composition of a window: its pages in list order. */
export interface WindowState {
  readonly pages: readonly WindowPage[]
  /** Changes only with a new composition (§6.4). */
  readonly chain: number
  readonly target: "start" | "end" | "keep"
  /** The first page starts the order: nothing lies before it. */
  readonly atStart: boolean
  /** The last page generation given out. */
  readonly generation: number
  /**
   * The server position a direction has read up to, set only when a read
   * brought nothing the window did not already hold: the next read of that
   * direction continues from it instead of repeating the same request.
   */
  readonly frontier: {
    readonly after?: WindowCursor
    readonly before?: WindowCursor
  }
}

/** The window before its first page. */
export const EMPTY_WINDOW: WindowState = {
  pages: [],
  chain: 0,
  target: "start",
  atStart: true,
  generation: 0,
  frontier: {},
}

/** The window without `dropped` keys (a purge); a page left empty goes. */
export function dropKeys(
  window: WindowState,
  dropped: ReadonlySet<Key>
): WindowState {
  const pages = window.pages
    .map((page) => ({
      ...page,
      keys: page.keys.filter((key) => !dropped.has(key)),
    }))
    .filter((page) => page.keys.length > 0)
  return { ...window, pages }
}

/** The keys of the pages, in list order. */
export const keysOfPages = (pages: readonly WindowPage[]): Key[] =>
  pages.flatMap((page) => page.keys)

/** The sort columns and the key of `values` as a keyset cursor. */
export function cursorOf(
  orderBy: OrderBy,
  keyName: string,
  values: Values
): WindowCursor {
  const picked: Record<string, unknown> = {}
  for (const entry of orderBy) {
    if (entry.attribute !== keyName)
      picked[entry.attribute] = values[entry.attribute]
  }
  return { values: picked, key: values[keyName] as Key }
}

/**
 * The order of a read that walks the list backwards: every direction and the
 * place of NULL mirrored, the key last (descending). The server appends the
 * key ascending itself, so the mirror has to name it.
 */
export function reversedOrder(orderBy: OrderBy, keyName: string): OrderBy {
  const mirrored = orderBy.map((entry) => {
    if (entry.attribute === keyName) {
      return {
        attribute: entry.attribute,
        direction:
          entry.direction === "asc" ? ("desc" as const) : ("asc" as const),
      }
    }
    const first =
      (entry.nulls ?? (entry.direction === "asc" ? "last" : "first")) ===
      "first"
    return {
      attribute: entry.attribute,
      direction:
        entry.direction === "asc" ? ("desc" as const) : ("asc" as const),
      nulls: first ? ("last" as const) : ("first" as const),
    }
  })
  return orderBy.at(-1)?.attribute === keyName
    ? mirrored
    : [...mirrored, { attribute: keyName, direction: "desc" as const }]
}

/** What `fetchPage` returns: the rows in list order and whether the order ended. */
export interface FetchedPage {
  readonly rows: ServerRow[]
  /** The read went past the last row of its direction: no further page. */
  readonly end: boolean
}

/**
 * The query of one keyset read of `form`: `cursor` is the boundary of the
 * previous read (strictly after it in `direction`); without it — the start
 * of that direction.
 */
function pageQuery(
  form: Form,
  direction: "after" | "before",
  cursor: WindowCursor | undefined,
  limit: number
): RowsQuery {
  const o = form.object
  const spec = form.spec as Extract<ViewSpec, { kind: "full" | "window" }>
  const orderBy = spec.orderBy ?? []
  const keyName = o.entry.keyName
  const query: OrderBy =
    direction === "after" ? orderBy : reversedOrder(orderBy, keyName)
  const keyset: Filter | undefined =
    cursor === undefined
      ? undefined
      : keysetFilter(
          orderBy,
          { ...cursor, direction },
          keyName,
          nullableOf(o.info)
        )
  const where: Filter | undefined =
    spec.where === undefined
      ? keyset
      : keyset === undefined
        ? spec.where
        : { and: [spec.where, keyset] }
  return {
    object: o.ref,
    ...(query.length === 0 ? {} : { orderBy: query }),
    ...(where === undefined ? {} : { where }),
    limit,
  }
}

/**
 * Reads one page of `form` (a `window`, or a `full` that went over its
 * limit) next to `cursor`; without it — from the start of the order
 * (`after`) or from its end (`before`). A page cut by the response budget
 * (`more`) is continued by a keyset from its last row; a read that does not
 * move the cursor is not repeated. `undefined` once `token` is invalid.
 */
export async function fetchPage(
  source: CoreSource,
  form: Form,
  request: { direction: "after" | "before"; cursor?: WindowCursor | undefined },
  token: GenerationToken,
  pageSize: number
): Promise<FetchedPage | undefined> {
  const o = form.object
  const spec = form.spec as Extract<ViewSpec, { kind: "full" | "window" }>
  const orderBy = spec.orderBy ?? []
  const keyName = o.entry.keyName
  const { direction } = request
  const rows: ServerRow[] = []
  let cursor = request.cursor
  let end = false
  for (;;) {
    const page = await readOne(
      source,
      pageQuery(form, direction, cursor, pageSize - rows.length)
    )
    // Звільнений чи перезапитаний вигляд далі не читає (токен покоління).
    if (!token.valid) return undefined
    rows.push(
      ...page.rows.map((values) => serverRow(o.entry, values, page.epoch))
    )
    const tail = page.rows.at(-1)
    // Порожня відповідь не просуває курсора: повторювати нічого. Без `more`
    // вона означає кінець порядку.
    if (tail === undefined) {
      end = page.more !== true
      break
    }
    if (rows.length >= pageSize) break
    if (page.more !== true) {
      end = true
      break
    }
    cursor = cursorOf(orderBy, keyName, tail)
  }
  return { rows: direction === "after" ? rows : rows.reverse(), end }
}

/**
 * The system re-read of a window's pages (§6.4): every page again from its
 * lower bound, all of them in one call of the source per round, `pageSize`
 * rows each. A page cut by the response budget (`more`) goes on from its
 * last row in the next round. The rows come per page, in the order of
 * `pages`; a `from` page starts strictly after its cursor, the cursor row
 * is the caller's to confirm. `undefined` once `token` is invalid.
 */
export async function rereadPages(
  source: CoreSource,
  form: Form,
  lowers: readonly WindowLower[],
  token: GenerationToken,
  pageSize: number
): Promise<ServerRow[][] | undefined> {
  const o = form.object
  const spec = form.spec as Extract<ViewSpec, { kind: "full" | "window" }>
  const orderBy = spec.orderBy ?? []
  const keyName = o.entry.keyName
  const rows: ServerRow[][] = lowers.map(() => [])
  const cursors: (WindowCursor | undefined)[] = lowers.map((lower) =>
    lower.kind === "start" ? undefined : lower.cursor
  )
  let open = lowers.map((_, i) => i)
  while (open.length > 0) {
    const { items } = await source.read(
      open.map((i) =>
        pageQuery(form, "after", cursors[i], pageSize - rows[i]!.length)
      )
    )
    if (!token.valid) return undefined
    const next: number[] = []
    for (const [at, item] of items.entries()) {
      const i = open[at]!
      if (!item.ok) throw new CommandFailure(item.error)
      rows[i]!.push(
        ...item.rows.rows.map((values) =>
          serverRow(o.entry, values, item.epoch)
        )
      )
      const tail = item.rows.rows.at(-1)
      // Без `more` чи порожня відповідь — сторінка прочитана; обрізану
      // бюджетом продовжує keyset від її останнього рядка.
      if (
        tail !== undefined &&
        item.rows.more === true &&
        rows[i]!.length < pageSize
      ) {
        cursors[i] = cursorOf(orderBy, keyName, tail)
        next.push(i)
      }
    }
    open = next
  }
  return rows
}
