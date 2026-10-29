import { describe, expect, it } from "vitest"
import {
  PLATFORM_BEFORE_ROW_LABELS,
  platformBeforeTriggerName,
} from "../before-trigger-names"

const bytes = (s: string): number => Buffer.byteLength(s, "utf8")

/** Назва рівно `n` байтів ASCII; літери на всіх позиціях — і в точці обрізання. */
function ascii(n: number): string {
  return "abcdefghijklmnopqrstuvwxyz".repeat(3).slice(0, n)
}

// Кирилиця — по 2 байти: 30 літер дають 60 байтів, і обрізання падає на межу символу.
const cyrillic = "клієнтськийдоговірпостачаннятов".slice(0, 30)

describe.each([
  ["коротка", "client", true],
  ["41 байт", ascii(41), true],
  ["42 байти", ascii(42), false],
  ["60 байтів ASCII", ascii(60), false],
  ["60 байтів кирилиці", cyrillic, false],
])("platformBeforeTriggerName — %s", (_, table, plain) => {
  const names = PLATFORM_BEFORE_ROW_LABELS.map((label) =>
    platformBeforeTriggerName(table, label)
  )

  it("тримає кожне ім'я в 63 байтах без розірваного символу", () => {
    for (const name of names) {
      expect(bytes(name)).toBeLessThanOrEqual(63)
      expect(name).not.toContain("�")
    }
  })

  it("спрацьовує в порядку міток: Postgres сортує імена байтово", () => {
    const sorted = [...names].sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b))
    )
    expect(sorted).toEqual(names)
  })

  it("дає один префікс до мітки для всієї групи", () => {
    const prefixes = PLATFORM_BEFORE_ROW_LABELS.map((label, i) =>
      names[i]!.slice(0, names[i]!.length - label.length)
    )
    expect(new Set(prefixes).size).toBe(1)
    expect(table.startsWith(prefixes[0]!.split("_")[0]!)).toBe(true)
  })

  it.runIf(plain)("лишає коротку назву без змін", () => {
    expect(names).toEqual(
      PLATFORM_BEFORE_ROW_LABELS.map((label) => `${table}_${label}`)
    )
  })
})

it("розводить довгі назви зі спільним початком хешем повної назви", () => {
  const a = `${ascii(50)}_a`
  const b = `${ascii(50)}_b`
  expect(platformBeforeTriggerName(a, "simetra_touch")).not.toBe(
    platformBeforeTriggerName(b, "simetra_touch")
  )
})
