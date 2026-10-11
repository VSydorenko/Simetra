import type { DbConnection } from "../engine"

/**
 * Помилка оператора з SQLSTATE: з'єднання живе, транзакція відкочена. Клас
 * лежить у T2, а `pg` — лише в адаптері, тож раннер відрізняє збій кроку від
 * втрати з'єднання без залежності від драйвера.
 */
export class ApplyDbError extends Error {
  constructor(
    message: string,
    readonly sqlstate: string | undefined
  ) {
    super(message)
    this.name = "ApplyDbError"
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
}
