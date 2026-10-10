/**
 * Перейменування однієї промотованої таблиці у фізичних іменах (спека
 * промоції §6): `columns` — лише колонки, що змінюють ім'я (`старе → нове`);
 * `columnsAfter` — усі колонки таблиці після промоції (рішення 14 плану), для
 * непромотованої — її колонки без змін. Без повного «після» додана колонка
 * виду чи знята колонка мовчки перехопили б некваліфіковане ім'я.
 */
export interface TableRename {
  schema: string
  from: string
  to: string
  columns: ReadonlyMap<string, string>
  columnsAfter: ReadonlySet<string>
}

/**
 * Вхід переписувача. `knownTables` — колонки кожної таблиці моделі до
 * промоції за ключем `"<схема>.<таблиця>"`: без них некваліфіковану колонку
 * не можна довести належною саме промотованій таблиці.
 */
export interface RenameMap {
  tables: readonly TableRename[]
  knownTables: ReadonlyMap<string, readonly string[]>
}

/** Правка тексту в індексах UTF-16, `[start, end)`; вставка — `start === end`. */
export interface TextEdit {
  start: number
  end: number
  text: string
}

/**
 * Запис PL/pgSQL, поля якого переписуються за мапою колонок: `%ROWTYPE`
 * таблиці чи `NEW`/`OLD` тригерної функції з таблицями, до яких її прив'язано.
 */
export type RecordBinding = { table: TableRename } | { trigger: TableRename[] }

/**
 * Контекст оператора у функції.
 *
 * - `variables` — імена всіх змінних і параметрів у нижньому регістрі.
 *   Змінна, якої немає в `records`, вважається не пов'язаною з промоцією
 *   (скаляр чи складене значення чужого типу): `r.inn` такої змінної не
 *   переписується й не відмовляє. Тож викликач зобов'язаний покласти в
 *   `records` кожен запис, форма якого може бути рядком промотованої
 *   таблиці, або сам відмовити.
 * - `records` — записи з відомою формою; `NEW`/`OLD` — з `trigger`.
 * - `topLevelOutput: "ignore"` — лише для `PERFORM` і синтетичної обгортки
 *   виразу PL/pgSQL (рішення 14): імена й `*` їхнього верхнього списку ніде
 *   не спостерігаються, тож тут немає ні ` AS <старе>`, ні звіту `star`.
 *   `RETURN QUERY`, `SELECT … INTO` запису, `FOR … IN SELECT` лишають `"keep"`.
 * - `intoRowtypeOf` — оператор пише в запис `%ROWTYPE` цієї таблиці, тож її
 *   `*` у верхньому списку не змінює контракту.
 */
export interface RewriteScope {
  searchPath?: readonly string[]
  variables: ReadonlySet<string>
  records: ReadonlyMap<string, RecordBinding>
  labels: readonly string[]
  topLevelOutput?: "keep" | "ignore"
  intoRowtypeOf?: TableRename
}

/** Місце, яке переписувач не довів статично; `offset` — індекс UTF-16. */
export interface RewriteProblem {
  code:
    | "rewrite.ambiguous-name"
    | "rewrite.unqualified-table"
    | "rewrite.unsupported"
    | "rewrite.trigger-binding"
    | "rewrite.label-literal"
  offset: number
  detail: string
}

/** Зміна форми результату, яку переписувач не правив, а лише називає. */
export interface ContractChange {
  offset: number
  reason: "wholeRow" | "star" | "signature"
  /** Пояснення для повідомлення `rewrite.contract-change` (англійською). */
  detail?: string
}

/**
 * Застосовує правки від кінця тексту, тож індекси решти лишаються чинними.
 * Перетин правок — помилка переписувача, а не вхід автора: одне місце не
 * можна переписати двома способами, і мовчки обраний би один із них.
 */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const cur = sorted[i]!
    const sameInsertion =
      prev.start === prev.end &&
      cur.start === cur.end &&
      prev.start === cur.start
    if (cur.start < prev.end || sameInsertion) {
      throw new Error(
        `Overlapping edits [${prev.start}, ${prev.end}) and [${cur.start}, ${cur.end})`
      )
    }
  }
  let result = text
  for (let i = sorted.length - 1; i >= 0; i--) {
    const edit = sorted[i]!
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }
  return result
}
