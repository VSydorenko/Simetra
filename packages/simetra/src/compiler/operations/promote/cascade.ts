import {
  KIND_REGISTRY,
  formatMetaFile,
  formatProjectFile,
  projectSchema,
  type MetadataRef,
} from "simetra/model"
import type { z } from "zod"
import type { CompiledModel } from "../../compile"
import { diagnostic, type Diagnostic } from "../../diagnostics"
import type { Json } from "../../object-files"
import { PROJECT_FILE } from "../../stages/files"
import { placeOf, renameJsonPlaces, type Place } from "../text-edits"

/** Що стає з посиланнями на одну промотовану таблицю. */
export interface PromotedReferences {
  objectId: string
  /** Ім'я прийнятої таблиці — для діагностик. */
  table: string
  /**
   * Новий об'єкт: посилання на таблицю переходять на нього. Немає — таблиця
   * стає табличною частиною, а ТЧ не є об'єктом, на який посилаються.
   */
  becomes: MetadataRef | undefined
  /**
   * id колонки → нове логічне ім'я, `undefined` — колонка не стає реквізитом
   * (виведена з ужитку чи носій скоупу), і посилання на неї — відмова.
   */
  columns: ReadonlyMap<string, { name: string; becomes: string | undefined }>
}

/** Дії FK, що змінюють дочірні рядки разом з батьківським. */
const CASCADING: ReadonlySet<unknown> = new Set([
  "cascade",
  "setNull",
  "setDefault",
])

/**
 * Каскад посилань індексу на промотовані таблиці з інших файлів (спека
 * промоції §7.1): `MetadataRef` отримує новий вид і ім'я, ім'я колонки — ім'я
 * реквізиту. Файли самих промотованих таблиць не правляться — їх замінює
 * файл виду. Вхідний FK з `cascade`, `setNull` чи `setDefault` від таблиці,
 * що лишається `CustomTable`, промоція переводить у `restrict` (Р2c1-34, §9.5):
 * каскад від таблиці виду заборонено. Кожен такий FK — крок
 * `promote.cascade-to-restrict`; дозвіл на нього дає пункт `delete:` чи
 * `update:` плану застосування — за подією. Повертає нові тексти змінених файлів.
 */
export function cascadeReferences(
  model: CompiledModel,
  files: ReadonlyMap<string, string>,
  promoted: readonly PromotedReferences[]
): {
  files: Map<string, string>
  problems: Diagnostic[]
  restricted: Diagnostic[]
} {
  const unitIds = new Set(promoted.map((p) => p.objectId))
  const byObject = new Map(promoted.map((p) => [p.objectId, p]))
  const byColumn = new Map(
    promoted.flatMap((p) =>
      [...p.columns].map(([id, column]) => [id, { table: p, column }] as const)
    )
  )

  const parsed = new Map<string, Json>()
  const rawOf = (file: string) => {
    let raw = parsed.get(file)
    if (raw === undefined) {
      raw = JSON.parse(files.get(file)!) as Json
      parsed.set(file, raw)
    }
    return raw
  }
  const schemaOf = (file: string): z.ZodType | undefined => {
    if (file === PROJECT_FILE) return projectSchema
    const owner = model.objects.find((o) => o.file === file)
    return owner === undefined ? undefined : KIND_REGISTRY[owner.kind].schema
  }

  // Файл → нове ім'я (і вид) → місця: `renameJsonPlaces` пише одне ім'я за раз.
  const edits = new Map<
    string,
    Map<string, { name: string; kind?: string; places: Place[] }>
  >()
  const problems: Diagnostic[] = []
  const restricted: Diagnostic[] = []
  const add = (file: string, place: Place, name: string, kind?: string) => {
    const perFile = edits.get(file) ?? new Map()
    edits.set(file, perFile)
    const key = `${kind ?? ""}:${name}`
    const group = perFile.get(key) ?? { name, kind, places: [] }
    group.places.push(place)
    perFile.set(key, group)
  }

  for (const ref of model.references) {
    if (unitIds.has(ref.from.objectId)) continue
    const object = byObject.get(ref.to.id)
    const column = byColumn.get(ref.to.id)
    if (object === undefined && column === undefined) continue
    // Маркер рухів називає регістр, а прийнята таблиця регістром не буває.
    if (ref.line !== undefined) {
      throw new Error(
        `movements marker ${ref.from.file} targets an adopted table`
      )
    }
    const file = ref.from.file
    const place = placeOf(ref, rawOf(file), schemaOf(file))
    if (object !== undefined) {
      if (object.becomes !== undefined) {
        add(file, place, object.becomes.name, object.becomes.kind)
        if (ref.role === "customTable.foreignKey") {
          restricted.push(...restrictForeignKey(model, rawOf(file), ref))
        }
      } else {
        problems.push(
          diagnostic("promote.unit-unsupported", file, ref.from.pointer, {
            kind: String(
              model.objects.find((o) => o.id === object.objectId)?.kind
            ),
            name: object.table,
            detail: `it becomes a tabular section, and this ${ref.role} references it as an object`,
          })
        )
      }
    } else if (column!.table.becomes === undefined) {
      // Колонку таблиці ТЧ ззовні називають лише поруч із самою таблицею:
      // відмову дає посилання на об'єкт.
      continue
    } else if (column!.column.becomes !== undefined) {
      add(file, place, column!.column.becomes)
    } else {
      problems.push(
        diagnostic("promote.retired-referenced", file, ref.from.pointer, {
          table: column!.table.table,
          column: column!.column.name,
          role: ref.role,
        })
      )
    }
  }

  const result = new Map<string, string>()
  for (const [file, groups] of edits) {
    const raw = rawOf(file)
    for (const { name, kind, places } of groups.values()) {
      renameJsonPlaces(raw, places, name, kind)
    }
    result.set(
      file,
      file === PROJECT_FILE ? formatProjectFile(raw) : formatMetaFile(raw)
    )
  }
  return { files: result, problems, restricted }
}

interface RawForeignKey {
  name?: string
  columns: string[]
  onDelete?: string
  onUpdate?: string
}

/**
 * Переводить у `restrict` каскадні дії вхідного FK у сирому файлі дочірньої
 * таблиці; кожна змінена дія — крок `promote.cascade-to-restrict` зі старою
 * дією, колонками FK і назвою таблиці.
 */
function restrictForeignKey(
  model: CompiledModel,
  raw: Json,
  ref: CompiledModel["references"][number]
): Diagnostic[] {
  const index = Number(ref.from.pointer.split("/")[2])
  const fk = (raw.foreignKeys as RawForeignKey[] | undefined)?.[index]
  if (fk === undefined) return []
  const table = model.physical.tables.find(
    (t) =>
      t.origin.objectId === ref.from.objectId &&
      t.origin.tabularSectionId === undefined &&
      t.origin.part === undefined
  )
  const physical = new Map(
    ((raw.columns as { name: string; physicalName?: string }[]) ?? []).map(
      (c) => [c.name, c.physicalName ?? c.name]
    )
  )
  const found: Diagnostic[] = []
  for (const field of ["onDelete", "onUpdate"] as const) {
    const action = fk[field]
    if (!CASCADING.has(action)) continue
    fk[field] = "restrict"
    found.push(
      diagnostic("promote.cascade-to-restrict", ref.from.file, "", {
        table: table === undefined ? "" : `${table.schema}.${table.name}`,
        foreignKey: fk.name ?? "",
        columns: fk.columns.map((c) => physical.get(c) ?? c).join(", "),
        action: String(action),
        ...(field === "onUpdate" ? { event: "update" } : {}),
      })
    )
  }
  return found
}
