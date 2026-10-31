import type { CommandDatabase } from "../port"
import { CommandFailure } from "../errors"

/** What the fake answers to one query: a result or a thrown error. */
export type Answer =
  { rows?: Record<string, unknown>[]; command?: string } | { error: unknown }

/** One recorded call of the port, in the order the runtime made it. */
export type Call =
  | { connect: true }
  | { text: string; params: readonly (string | null)[] }
  | { release: boolean }

/** A query the script left unanswered: the test settles it by hand. */
export interface PendingQuery {
  text: string
  params: readonly (string | null)[]
  answer(answer?: Answer): void
}

/**
 * Script of the fake: an answer, or `undefined` to leave the query pending.
 * `connect` answers `connect()`; an error makes it throw.
 */
export interface Script {
  query(
    text: string,
    params: readonly (string | null)[],
    index: number
  ): Answer | undefined
  connect?(index: number): { error: unknown } | undefined
}

/**
 * The port fake of T3 tests: records every `connect`, `query` and `release`
 * and answers through deferred promises. Відкладені відповіді дають тесту
 * керувати порядком: незавершений запит лишається в `pending`, доки тест
 * його не розв'яже, — так видно, що черга не пускає наступний оператор.
 */
export function fakeDatabase(script: Script) {
  const calls: Call[] = []
  const pending: PendingQuery[] = []
  let queries = 0
  let connects = 0
  const waiters: (() => void)[] = []

  const settle = (
    answer: Answer,
    text: string,
    resolve: (value: {
      rows: Record<string, unknown>[]
      command: string
    }) => void,
    reject: (error: unknown) => void
  ) => {
    if ("error" in answer) {
      reject(answer.error)
      return
    }
    resolve({
      rows: answer.rows ?? [],
      // Тег — перше слово оператора, як у `pg`, якщо скрипт не дав інший.
      command: answer.command ?? text.split(" ")[0],
    })
  }

  const database: CommandDatabase = {
    connect() {
      const failure = script.connect?.(connects++)
      calls.push({ connect: true })
      if (failure !== undefined) return Promise.reject(failure.error)
      return Promise.resolve({
        query(text, params = []) {
          calls.push({ text, params })
          const answer = script.query(text, params, queries++)
          return new Promise((resolve, reject) => {
            if (answer !== undefined) {
              settle(answer, text, resolve, reject)
              return
            }
            const entry: PendingQuery = {
              text,
              params,
              answer(given = {}) {
                pending.splice(pending.indexOf(entry), 1)
                settle(given, text, resolve, reject)
              },
            }
            pending.push(entry)
            for (const wake of waiters.splice(0)) wake()
          })
        },
        release(destroy) {
          calls.push({ release: destroy ?? false })
        },
      })
    },
  }

  return {
    database,
    calls,
    pending,
    /** Resolves once a query is left pending. */
    async next(): Promise<PendingQuery> {
      while (pending.length === 0) {
        await new Promise<void>((wake) => waiters.push(wake))
      }
      return pending[0]
    },
  }
}

/** The `CommandError` a promise rejected with; fails the test otherwise. */
export async function failureOf(promise: Promise<unknown>) {
  const thrown: unknown = await promise.then(
    () => {
      throw new Error("expected a CommandFailure")
    },
    (error: unknown) => error
  )
  if (!(thrown instanceof CommandFailure)) throw thrown
  return thrown.error
}
