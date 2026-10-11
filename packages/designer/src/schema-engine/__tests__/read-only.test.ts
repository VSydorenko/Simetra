import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Сторож рішення 14.1 плану П3-1: гарантія «лише читання» живе в транзакції,
 * а не в з'єднанні. За пулером у режимі транзакцій сесійне налаштування
 * губиться або осідає на чужому backend, тож у коді його не має бути зовсім,
 * а кожен сирий запит до пулу в двигуні — лише через спільний хелпер.
 */

const SRC = resolve(__dirname, "../..")
const ENGINE = resolve(__dirname, "..")

/** Файли коду теки без тестів. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory())
      return entry.name === "__tests__" ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function offenders(dir: string, pattern: RegExp): string[] {
  return sources(dir)
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(SRC, path))
}

describe("target reads carry no session state", () => {
  it("no session-level read-only switch or connect hook in the designer", () => {
    expect(
      offenders(SRC, /default_transaction_read_only|onConnect|\breadOnlyPool\b/)
    ).toEqual([])
  })

  // Із типовим параметром теж: `pool.query<Row>(…)` — той самий сирий запит
  it("raw pool queries in the engine go only through the read-only helper", () => {
    expect(
      offenders(ENGINE, /pool\.query\s*[<(]/i).filter(
        (path) => path !== join("schema-engine", "read-only.ts")
      )
    ).toEqual([])
  })
})
