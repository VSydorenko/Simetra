import {
  KIND_REGISTRY,
  effectiveSearch,
  standardLogicalName,
  type AttributeCase,
  type PhysicalColumn,
  type Search,
} from "simetra/model"
import type { ParsedObject } from "./stages/files"

/**
 * Поле пошуку, яке компілятор не збудує (спека П2 §5, «Поля пошуку»): лише
 * оголошене `fields` може так помилитися — типові поля дає реєстр.
 */
export type SearchFieldProblem =
  "unknown" | "duplicate" | "tabularSection" | "ref" | "generated"

/** Поле шапки, що знайдене за логічним ім'ям, і чи дає воно нормалізовану колонку. */
export interface SearchField {
  name: string
  /** Походження колонки поля у знімку: стандартний реквізит чи елемент. */
  origin: { standard: string } | { elementId: string }
  /** `String`/`Text`, не масив: лише таке поле має нормалізовану колонку. */
  normalized: boolean
}

export interface ResolvedSearch {
  fields: SearchField[]
  /** Помилки оголошених полів з місцем у `search.fields`. */
  problems: { problem: SearchFieldProblem; index: number; name: string }[]
}

interface HeaderElement {
  id?: string
  name: string
  type: string
  array?: boolean
  generated?: unknown
}

/**
 * Ефективні поля пошуку об'єкта, зіставлені з реквізитами шапки: одне
 * джерело і для стадії моделі (колонки й індекси), і для діагностик стадії 4.
 * Поле, що не знайдене чи заборонене, у `fields` не йде.
 */
export function resolveSearch(
  object: ParsedObject,
  style: AttributeCase
): ResolvedSearch {
  const def = KIND_REGISTRY[object.kind]
  const data = object.data as {
    search?: Search
    tabularSections?: { name: string; attributes: { name: string }[] }[]
  } & Record<string, unknown>
  const search = effectiveSearch(object.kind, data)
  const result: ResolvedSearch = { fields: [], problems: [] }
  if (search === undefined) return result

  type Found = Omit<SearchField, "name"> & {
    canonical: string
    problem?: SearchFieldProblem
  }
  const header = new Map<string, Found>()
  for (const column of def.standardColumns(object.data)) {
    const logical = standardLogicalName(column, style)
    const type = "raw" in column.type ? undefined : column.type
    const found: Found = {
      canonical: `standard:${column.logicalName}`,
      origin: { standard: logical },
      normalized:
        (type?.type === "String" || type?.type === "Text") &&
        type.array !== true,
      ...(column.ref !== undefined || type?.type === "Ref"
        ? { problem: "ref" as const }
        : {}),
    }
    // Обидва стилі імені ведуть до однієї колонки (як у `indexes`).
    header.set(column.logicalName, found)
    header.set(logical, found)
  }
  for (const field of def.columnFields) {
    for (const element of (data[field] ?? []) as HeaderElement[]) {
      header.set(element.name, {
        canonical: `element:${element.id ?? element.name}`,
        origin: { elementId: element.id ?? "" },
        normalized:
          (element.type === "String" || element.type === "Text") &&
          element.array !== true,
        ...(element.type === "Ref"
          ? { problem: "ref" as const }
          : element.generated !== undefined
            ? // Вираз генерації не може посилатися на згенеровану колонку
              // (42P17): нормалізованої колонки над нею не буде.
              { problem: "generated" as const }
            : {}),
      })
    }
  }
  const sectionNames = new Set(
    (def.tabularSectionColumns === undefined
      ? []
      : (data.tabularSections ?? [])
    ).flatMap((s) => [s.name, ...s.attributes.map((a) => a.name)])
  )

  const seen = new Set<string>()
  search.fields.forEach((name, index) => {
    const found = header.get(name)
    const problem: SearchFieldProblem | undefined =
      found === undefined
        ? sectionNames.has(name)
          ? "tabularSection"
          : "unknown"
        : seen.has(found.canonical)
          ? "duplicate"
          : found.problem
    if (found !== undefined) seen.add(found.canonical)
    if (problem !== undefined) {
      result.problems.push({ problem, index, name })
      return
    }
    result.fields.push({
      name,
      origin: found!.origin,
      normalized: found!.normalized,
    })
  })
  return result
}

/** Колонка поля у знімку за походженням (не за фізичним іменем). */
export function searchFieldColumn<
  C extends Pick<PhysicalColumn, "name" | "origin">,
>(columns: readonly C[], field: SearchField): C | undefined {
  return columns.find((c) =>
    "standard" in field.origin
      ? c.origin.standard === field.origin.standard &&
        c.origin.elementId === undefined
      : c.origin.elementId === field.origin.elementId
  )
}
