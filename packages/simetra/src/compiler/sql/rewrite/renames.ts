/**
 * Перейменування однієї промотованої таблиці у фізичних іменах (спека
 * промоції §6): `columns` — лише колонки, що змінюють ім'я (`старе → нове`).
 */
export interface TableRename {
  schema: string
  from: string
  to: string
  columns: ReadonlyMap<string, string>
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
 * Контекст оператора у функції. `variables` — імена змінних і параметрів у
 * нижньому регістрі; `topLevelOutput: "ignore"` — верхній список виводу
 * синтетичний (обгортка виразу PL/pgSQL, `PERFORM`), його імена ніде не
 * спостерігаються; `intoRowtypeOf` — оператор пише в запис `%ROWTYPE` цієї
 * таблиці, тож її `*` у верхньому списку не змінює контракту.
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
