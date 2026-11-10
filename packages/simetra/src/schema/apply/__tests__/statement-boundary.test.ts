import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const APPLY_DIR = join(import.meta.dirname, "..")

// Оператор поза транзакцією існує лише для підготовки кластера (рішення Р12):
// план і застосування ходять тільки через `transaction`. Гард ловить виклик
// `.statement(` у виробничих файлах T2 `apply`, крім файлу підготовки кластера
describe("ApplyDatabase.statement boundary", () => {
  it("is called only from postgres-cluster.ts in production sources of apply", () => {
    const files = readdirSync(APPLY_DIR, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => join(e.parentPath, e.name))
      .filter((path) => !path.includes("__tests__"))
    // Порожній перелік (перейменована тека) не має проходити вхолосту
    expect(files.length).toBeGreaterThan(0)
    const callers = files
      .filter((path) => /\.statement\(/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(APPLY_DIR.length + 1))
      .filter((path) => path !== "postgres-cluster.ts")
    expect(callers).toEqual([])
  })
})
