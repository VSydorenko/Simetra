import { byteOffsets } from "../parse"
import { lexChain, type Token } from "./lex"
import type {
  ContractChange,
  RenameMap,
  RewriteProblem,
  RewriteScope,
  TableRename,
  TextEdit,
} from "./renames"

const CHANGE_DETAILS: Readonly<Record<ContractChange["reason"], string>> = {
  star: "a star expands the columns of the promoted table, which the promotion adds, removes and renames",
  wholeRow:
    "a whole row of the promoted table changes its fields with the promotion",
  signature: "the signature names the row type of the promoted table",
}

/**
 * Спільний стан переписування одного тексту: факти промоції, виведені з
 * мапи, і зібрані правки, відмови та зміни контракту. Обхід дерева й резолв
 * імен лише пишуть сюди — ключі мап зводять повтори одного місця до одного
 * запису, а порядок результату дає `result`.
 */
export class RewriteContext {
  private readonly toIndex: (byte: number) => number
  private readonly edits = new Map<string, TextEdit>()
  private readonly problems = new Map<string, RewriteProblem>()
  private readonly changes = new Map<string, ContractChange>()
  /** Старі імена перейменованих колонок усіх промотованих таблиць. */
  readonly renamedColumns = new Set<string>()
  readonly promotedNames = new Set<string>()
  /**
   * Імена, резолв яких промоція може змінити: старі й нові імена
   * перейменувань, додані й зняті колонки.
   */
  private readonly changedColumns = new Set<string>()
  readonly labels: ReadonlySet<string>
  /** Імена таблиць моделі — їхні рядкові типи не доводять константи каталогу. */
  readonly tableNames = new Set<string>()
  /** Оператор згадує промотовану таблицю: невизначеність імені тут важить. */
  touches = false

  constructor(
    private readonly text: string,
    readonly map: RenameMap,
    readonly scope: RewriteScope
  ) {
    this.toIndex = byteOffsets(text)
    for (const table of map.tables) {
      this.promotedNames.add(table.from)
      const before = map.knownTables.get(`${table.schema}.${table.from}`) ?? []
      for (const [old, renamed] of table.columns) {
        this.renamedColumns.add(old)
        this.changedColumns.add(old).add(renamed)
      }
      for (const column of table.columnsAfter) {
        if (!before.includes(column)) this.changedColumns.add(column)
      }
      for (const column of before) {
        if (!table.columnsAfter.has(table.columns.get(column) ?? column)) {
          this.changedColumns.add(column)
        }
      }
    }
    for (const key of map.knownTables.keys()) {
      this.tableNames.add(key.slice(key.indexOf(".") + 1))
    }
    for (const table of map.tables)
      this.tableNames.add(table.from).add(table.to)
    this.labels = new Set(scope.labels)
  }

  result(): {
    edits: TextEdit[]
    problems: RewriteProblem[]
    contractChanges: ContractChange[]
  } {
    const byOffset = <T extends { offset: number }>(a: T, b: T) =>
      a.offset - b.offset
    return {
      edits: [...this.edits.values()].sort((a, b) => a.start - b.start),
      problems: [...this.problems.values()].sort(byOffset),
      contractChanges: [...this.changes.values()].sort(byOffset),
    }
  }

  problem(code: RewriteProblem["code"], offset: number, detail: string): void {
    // Той самий вузол буває досяжним двома шляхами (джерело `(a, b) = …`
    // спільне для обох цілей) — одна проблема на місце.
    this.problems.set(`${code}@${offset}@${detail}`, { code, offset, detail })
  }

  /** На цьому місці вже є відмова — будь-якого коду. */
  reportedAt(offset: number): boolean {
    return [...this.problems.values()].some((p) => p.offset === offset)
  }

  change(
    reason: ContractChange["reason"],
    offset: number,
    detail: string = CHANGE_DETAILS[reason]
  ): void {
    this.changes.set(`${reason}@${offset}`, { offset, reason, detail })
  }

  edit(start: number, end: number, text: string): void {
    this.edits.set(`${start}:${end}:${text}`, { start, end, text })
  }

  /** Посилання на зняту колонку (без нового імені): правити нема на що. */
  removed(
    column: string,
    table: TableRename,
    location: number | undefined
  ): void {
    this.problem(
      "rewrite.unsupported",
      this.at(location),
      `column "${column}" of promoted table "${table.from}" is removed by the promotion`
    )
  }

  /** Ім'я, резолв якого промоція може змінити. */
  relevantColumn(name: string): boolean {
    return this.changedColumns.has(name)
  }

  relevantName(name: string): boolean {
    return this.promotedNames.has(name) || this.relevantColumn(name)
  }

  /** Промотована — таблиця з мапи; тотожний запис прив'язки (`from === to`) — ні. */
  isPromoted(table: TableRename): boolean {
    return this.map.tables.some((t) => sameTable(t, table))
  }

  // --- Позиції ---------------------------------------------------------------

  /** Індекс UTF-16 за байтовою позицією libpg-query; без позиції — початок тексту. */
  at(location: number | undefined): number {
    return location === undefined || location < 0 ? 0 : this.toIndex(location)
  }

  /**
   * Токени ланцюжка `a.b.c` від позиції вузла. Кожен токен звіряється з іменем
   * з дерева: розбіжність означає, що позиція вказує не на ім'я (наприклад,
   * `U&"…"`), і правка була б наосліп — тоді відмова.
   */
  tokens(
    location: number | undefined,
    names: readonly string[]
  ): Token[] | undefined {
    if (location === undefined || location < 0) {
      this.problem(
        "rewrite.unsupported",
        0,
        `a reference to "${names.join(".")}" has no position in the parse tree`
      )
      return undefined
    }
    const start = this.toIndex(location)
    const tokens = lexChain(this.text, start, names.length)
    if (tokens === undefined || tokens.some((t, i) => t.value !== names[i])) {
      this.problem(
        "rewrite.unsupported",
        start,
        `the text at the position of "${names.join(".")}" is not a plain or quoted identifier`
      )
      return undefined
    }
    return tokens
  }
}

export function sameTable(a: TableRename, b: TableRename | undefined): boolean {
  return b !== undefined && a.schema === b.schema && a.from === b.from
}
