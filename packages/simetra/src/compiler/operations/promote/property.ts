import type { PhysicalSnapshot, PhysicalTable } from "simetra/model"
import { diagnostic, type Diagnostic } from "../../diagnostics"
import type { ConversionClass } from "../inputs"
import {
  indexDifferences,
  uniqueDifferences,
  type FieldDifference,
  type ConversionSubject,
} from "./mapping"

type Subject = Pick<ConversionSubject, "subject" | "objects"> & {
  class: ConversionClass
  file?: string
  pointer?: string
}

export interface PropertyCheck {
  before: PhysicalSnapshot
  after: PhysicalSnapshot
  conversions: readonly Subject[]
  /** Нове ім'я таблиці за ключем `schema.старе ім'я`. */
  tablesOldToNew: ReadonlyMap<string, string>
  /** Нове ім'я колонки за ключем `schema.стара таблиця.стара колонка`. */
  columnsOldToNew: ReadonlyMap<string, string>
}

const NO_ELEMENT = "no element on these columns"

const render = (diffs: readonly FieldDifference[]) =>
  diffs.map((d) => `${d.field}: ${d.was} → ${d.now}`).join("; ")

/** Ім'я колонки в тексті виразу, без лапок і не частиною довшого ідентифікатора. */
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Вердикт класу `property` (спека промоції §8): обмеження чи індекс, які
 * прийнята таблиця мала, лишаються «виражені властивістю» лише коли вид
 * відтворює їх еквівалентно. Строгіше відтворення теж відмова: клас
 * `tightened` сканом даних не довести, а відкладеність, предикат чи
 * `NULLS NOT DISTINCT` мовчки зникли б. Порожній результат — усі класи
 * `property` чесні.
 */
export function propertyRefusals(input: PropertyCheck): Diagnostic[] {
  const refusals: Diagnostic[] = []
  for (const conversion of input.conversions) {
    if (conversion.class !== "property") continue
    for (const object of conversion.objects) {
      if (object.kind !== "constraint" && object.kind !== "index") continue
      const was = input.before.tables.find(
        (t) => t.schema === object.schema && t.name === object.table
      )
      const newName = input.tablesOldToNew.get(
        `${object.schema}.${object.table}`
      )
      const now = input.after.tables.find(
        (t) => t.schema === object.schema && t.name === newName
      )
      if (was === undefined) continue
      const detail =
        now === undefined
          ? NO_ELEMENT
          : differences(object, was, now, input.columnsOldToNew)
      if (detail === undefined) continue
      refusals.push(
        diagnostic(
          "promote.property-not-equivalent",
          conversion.file ?? "",
          conversion.pointer ?? "",
          {
            subject: conversion.subject,
            kind: elementKind(object, was),
            name: object.name,
            detail,
          }
        )
      )
    }
  }
  return refusals
}

function elementKind(
  object: { kind: string; name: string },
  was: PhysicalTable
): string {
  if (object.kind === "index") return "index"
  return was.checks.some((c) => c.name === object.name)
    ? "check constraint"
    : "unique constraint"
}

/** `undefined` — відтворено еквівалентно; інакше — чим воно інше. */
function differences(
  object: { kind: string; schema: string; table: string; name: string },
  was: PhysicalTable,
  now: PhysicalTable,
  columnsOldToNew: ReadonlyMap<string, string>
): string | undefined {
  const rename = (column: string) =>
    columnsOldToNew.get(`${object.schema}.${object.table}.${column}`)
  // Колонка без наступника (виведена з ужитку) не лишає на чому відтворювати.
  const translate = (columns: readonly string[]) => {
    const found = columns.map(rename)
    return found.every((c) => c !== undefined) ? (found as string[]) : undefined
  }
  if (object.kind === "index") {
    const index = was.indexes.find((i) => i.name === object.name)
    if (index === undefined) return undefined
    const columns = translate([
      ...index.keys.flatMap((k) => ("column" in k ? [k.column] : [])),
      ...index.include,
    ])
    if (columns === undefined) return NO_ELEMENT
    const keyOf = (k: PhysicalTable["indexes"][number]["keys"][number]) =>
      JSON.stringify({
        ...k,
        ...("column" in k ? { column: rename(k.column) } : {}),
      })
    const shaped = {
      unique: index.unique,
      method: index.method,
      keys: index.keys.map(keyOf),
      include: index.include.map((c) => rename(c)!),
      ...(index.where === undefined ? {} : { where: index.where }),
      nullsNotDistinct: index.nullsNotDistinct,
    }
    const candidates = now.indexes
      .map((p) =>
        indexDifferences(shaped, {
          ...p,
          keys: p.keys.map((k) => JSON.stringify(k)),
        })
      )
      .filter((diffs) => !diffs.some((d) => d.field === "keys"))
    return verdict(candidates)
  }
  const unique = was.uniques.find((u) => u.name === object.name)
  if (unique !== undefined) {
    const columns = translate(unique.columns)
    if (columns === undefined) return NO_ELEMENT
    const candidates = now.uniques
      .map((p) => uniqueDifferences({ ...unique, columns }, p))
      .filter((diffs) => !diffs.some((d) => d.field === "columns"))
    return verdict(candidates)
  }
  const check = was.checks.find((c) => c.name === object.name)
  if (check === undefined) return undefined
  // Вираз міняється лише за іменами колонок, які перейменовано; текстово інший,
  // але рівний семантично вираз — хибна відмова, безпечна.
  const renamed = new Map<string, string>()
  for (const column of was.columns) {
    const to = rename(column.name)
    if (to !== undefined && to !== column.name) renamed.set(column.name, to)
  }
  const translated =
    renamed.size === 0
      ? check.expression
      : check.expression.replace(
          new RegExp(
            `(?<![\\w"])(${[...renamed.keys()].map(escapeRegExp).join("|")})(?![\\w"])`,
            "g"
          ),
          (name) => renamed.get(name)!
        )
  // Кандидат — CHECK, що згадує всі колонки, які згадує вихідний вираз.
  const mentions = (expression: string, column: string) =>
    new RegExp(`(?<![\\w"])${escapeRegExp(column)}(?![\\w"])`).test(expression)
  const used = was.columns
    .map((c) => rename(c.name) ?? c.name)
    .filter((_, i) => mentions(check.expression, was.columns[i]!.name))
  const candidates = now.checks.filter((c) =>
    used.every((column) => mentions(c.expression, column))
  )
  if (candidates.some((c) => c.expression === translated)) return undefined
  const first = candidates[0]
  return first === undefined
    ? NO_ELEMENT
    : render([{ field: "expression", was: translated, now: first.expression }])
}

/** Є елемент без відмінностей — еквівалентно; інакше найближчий кандидат. */
function verdict(candidates: readonly FieldDifference[][]): string | undefined {
  if (candidates.some((diffs) => diffs.length === 0)) return undefined
  const closest = [...candidates].sort((a, b) => a.length - b.length)[0]
  return closest === undefined ? NO_ELEMENT : render(closest)
}
