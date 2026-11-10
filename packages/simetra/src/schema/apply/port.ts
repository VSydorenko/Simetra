import type { DbConnection, EngineScope, Extracted } from "../engine"

/**
 * Помилка оператора з SQLSTATE: з'єднання живе, транзакція відкочена. Клас
 * лежить у T2, а `pg` — лише в адаптері, тож раннер відрізняє збій кроку від
 * втрати з'єднання без залежності від драйвера. `detail` відрізняє причини
 * одного коду (`42501`), а `column`/`constraint`/`table` називають, що саме
 * порушено (`23502`, `23503`).
 */
export class ApplyDbError extends Error {
  readonly detail: string | undefined
  readonly column: string | undefined
  readonly constraint: string | undefined
  readonly table: string | undefined

  constructor(
    message: string,
    readonly sqlstate: string | undefined,
    extra: {
      detail?: string
      column?: string
      constraint?: string
      table?: string
    } = {}
  ) {
    super(message)
    this.name = "ApplyDbError"
    this.detail = extra.detail
    this.column = extra.column
    this.constraint = extra.constraint
    this.table = extra.table
  }
}

/**
 * З'єднання втрачено (клас `08`, `57P01` чи збій транспорту драйвера):
 * результат транзакції невідомий. Помилка програми без SQLSTATE сюди не
 * потрапляє: вона летить як є.
 */
export class ApplyConnectionLost extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ApplyConnectionLost"
  }
}

/** Запити однієї відкритої транзакції. */
export interface ApplyTransaction {
  query<R extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<R[]>
  /**
   * Витяг двигуна з цієї транзакції: бачить її незакомічені зміни. Двигун
   * читає в точці збереження, яку закриває відкатом, тож після виклику ні
   * налаштувань, ні об'єктів, ні замків, узятих витягом, у транзакції не
   * лишається, а сама вона придатна далі. Ізоляція — транзакції
   * (`READ COMMITTED`), а не `REPEATABLE READ`, якого чекає двигун: чужа DDL
   * поза замками плану між запитами витягу може дати неузгоджений знімок.
   */
  extract(scope: EngineScope): Promise<Extracted>
}

/**
 * Порт виконання застосування. Один виклик — одне з'єднання й одна
 * транзакція: `BEGIN`, `fn`, потім `COMMIT` чи `ROLLBACK` за `end`. Виняток
 * у `fn` дає `ROLLBACK` і прокидається далі без змін. Сесійного стану на
 * цілі порт не лишає. Ізоляція — завжди `READ COMMITTED`, задана явно:
 * кожен оператор бачить коміти, зроблені до нього, тож знімок береться
 * після блокування, взятого попереднім оператором (раннер на цьому стоїть).
 */
export interface ApplyDatabase {
  transaction<T>(
    db: DbConnection,
    end: "commit" | "rollback",
    fn: (tx: ApplyTransaction) => Promise<T>
  ): Promise<T>
  /**
   * One statement on its own connection, outside any transaction, for
   * operators that Postgres refuses inside one (`CREATE DATABASE`,
   * `ALTER DATABASE … IS_TEMPLATE`). Only for cluster preparation
   * (`ensurePostgresCluster`); never in plan or apply. The read-only
   * implementation rejects it.
   */
  statement(db: DbConnection, sql: string): Promise<void>
}
