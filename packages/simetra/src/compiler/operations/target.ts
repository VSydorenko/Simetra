import type { z } from "zod"
import { KIND_REGISTRY, namedCollections, projectSchema } from "simetra/model"
import type { CompiledModel } from "../compile"
import { diagnostic, type Diagnostic } from "../diagnostics"
import { PROJECT_FILE } from "../stages/files"
import type { ContainerTarget, ElementTarget } from "./inputs"

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export type ResolvedTarget =
  | { ok: true; file: string; pointer: string; id: string }
  | { ok: false; diagnostic: Diagnostic }

/** Знайдений контейнер разом зі схемою, з якої видно його колекції. */
export type LocatedContainer =
  | {
      ok: true
      file: string
      pointer: string
      /** Немає лише в кореня проєкту: він не іменований елемент. */
      id?: string
      schema: z.ZodType
    }
  | { ok: false; diagnostic: Diagnostic }

/** Ціль словами для діагностики: `Document ServiceAccrual / services`. */
export function describeTarget(t: ContainerTarget | ElementTarget): string {
  const head = t.kind === "Project" ? "Project" : `${t.kind} ${t.name}`
  const chain = "element" in t && t.element !== undefined ? t.element : []
  return [head, ...chain].join(" / ")
}

function parse(text: string | undefined): Json | undefined {
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Спуск ланцюжком логічних імен (рішення плану 3). На кожному рівні ім'я
 * шукається в усіх колекціях іменованих елементів схеми рівня: на чистій
 * моделі збігу двох колекцій не буває — простори реквізитів і ТЧ спільні
 * (стадія 2 відкидає дублі), а предвизначені елементи й значення мають
 * PascalCase, якого стиль реквізитів не допускає.
 */
export function locateContainer(
  model: CompiledModel,
  files: ReadonlyMap<string, string>,
  t: ContainerTarget | ElementTarget
): LocatedContainer {
  const notFound = (file: string, pointer: string, name: string) => ({
    ok: false as const,
    diagnostic: diagnostic("operation.target-not-found", file, pointer, {
      target: describeTarget(t),
      name,
    }),
  })

  let file: string
  let id: string | undefined
  let schema: z.ZodType
  if (t.kind === "Project") {
    file = PROJECT_FILE
    schema = projectSchema
  } else {
    const object = model.objects.find(
      (o) => o.kind === t.kind && o.name === t.name
    )
    if (object === undefined) return notFound("", "", t.name)
    file = object.file
    id = object.id
    schema = KIND_REGISTRY[object.kind].schema
  }
  let current = parse(files.get(file))
  if (current === undefined) return notFound(file, "", describeTarget(t))

  let pointer = ""
  const chain = "element" in t && t.element !== undefined ? t.element : []
  for (const name of chain) {
    let found: { key: string; index: number; element: Json } | undefined
    for (const [key, elementSchema] of namedCollections(schema)) {
      const items = current[key]
      if (!Array.isArray(items)) continue
      const index = items.findIndex(
        (item: unknown) => isRecord(item) && item.name === name
      )
      if (index < 0) continue
      found = { key, index, element: items[index] as Json }
      schema = elementSchema
      break
    }
    if (found === undefined) return notFound(file, pointer, name)
    pointer = `${pointer}/${found.key}/${found.index}`
    current = found.element
    id = typeof current.id === "string" ? current.id : undefined
  }
  return {
    ok: true,
    file,
    pointer,
    ...(id === undefined ? {} : { id }),
    schema,
  }
}

/**
 * Адреса цілі перейменування чи видалення: файл, JSON Pointer і id
 * (спека П2 §8.6). Працює над чистою моделлю — там кожен іменований елемент
 * має id, а імена в просторі елементів унікальні.
 */
export function resolveTarget(
  model: CompiledModel,
  files: ReadonlyMap<string, string>,
  t: ElementTarget
): ResolvedTarget {
  const located = locateContainer(model, files, t)
  if (!located.ok) return located
  // Тип `ElementTarget` не адресує корінь проєкту, тож id є завжди; захист —
  // від виклику в обхід типу.
  if (located.id === undefined) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "operation.target-not-found",
        located.file,
        located.pointer,
        { target: describeTarget(t), name: describeTarget(t) }
      ),
    }
  }
  return {
    ok: true,
    file: located.file,
    pointer: located.pointer,
    id: located.id,
  }
}

/**
 * Усі файли об'єкта в мапі: `.meta.json`, `.sql`, `.module.ts` — усе під
 * текою `<тека виду>/<Name>/`. Перейменування переносить їх, видалення стирає.
 */
export function objectFiles(
  files: ReadonlyMap<string, string>,
  object: { kind: keyof typeof KIND_REGISTRY; name: string }
): string[] {
  const prefix = `${KIND_REGISTRY[object.kind].dir}/${object.name}/`
  return [...files.keys()].filter((path) => path.startsWith(prefix))
}
