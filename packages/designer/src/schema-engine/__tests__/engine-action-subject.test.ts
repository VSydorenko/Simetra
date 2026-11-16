import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Опора правила чужого об'єкта (платформна спека §6.6) на конвенцію
 * pg-delta: суб'єкт дії — `produces[0] ?? destroys[0] ?? consumes[0]`, а
 * перевизначення на місці (`CREATE OR REPLACE`, `ALTER POLICY`, `OWNER TO`)
 * вживає сам об'єкт першим, а його залежності — після. T2 бере ціль дії
 * `alter` саме звідти (`foreignChanges` у `simetra/schema`). Нова версія
 * pg-delta, що змінить цю конвенцію, червонить тест, а не мовчки робить
 * чужі перевизначення `catalogOnly`.
 */

const emitter = async (): Promise<string> => {
  // Пакет не експортує внутрішні модулі, тож шлях — від точки входу `dist`
  const entry = createRequire(import.meta.url).resolve("@supabase/pg-delta")
  return readFile(
    join(dirname(entry), "plan", "phases", "action-emitter.js"),
    "utf8"
  )
}

describe("pg-delta action subject convention", () => {
  it("leads an action with its subject, before the spec's own consumes", async () => {
    const source = await emitter()
    expect(source).toContain(
      "const consumes = [...(opts.consumes ?? []), ...(spec.consumes ?? [])];"
    )
    expect(source).toContain(
      "const subjectKind = (produces[0] ?? destroys[0] ?? consumes[0])?.kind;"
    )
  })

  it("passes the altered fact first for in-place and owner alters", async () => {
    const source = await emitter()
    // Атрибут на місці: тіло функції, ролі політики, default колонки
    expect(source).toContain(
      'pushAction("alter", spec, { consumes: [fact.id] });'
    )
    // Власник об'єкта: змінений і відновлений після заміни
    expect(source).toContain("}, { consumes: [objId] });")
    expect(source).toContain("}, { consumes: [fact.id] });")
  })
})
