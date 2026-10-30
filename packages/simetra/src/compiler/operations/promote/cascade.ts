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
  columns: ReadonlyMap<
    string,
    {
      name: string
      becomes: string | undefined
      /** Колонка стає ключем виду (`ref`) чи його колонкою скоупу (`scope`). */
      key?: "ref" | "scope"
    }
  >
}

/** Колонка цілі FK на промотовану таблицю, що стає об'єктом. */
interface TargetColumn {
  place: Place
  pointer: string
  table: PromotedReferences
  column: PromotedReferences["columns"] extends ReadonlyMap<string, infer C>
    ? C
    : never
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
 * що лишається `CustomTable`, промоція переводить у `restrict` (спека прав §4.7, спека промоції §9.5):
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
  // `файл\0/foreignKeys/<i>` → колонки цілі за їхнім індексом у FK.
  const targetColumns = new Map<
    string,
    { file: string; index: number; columns: TargetColumn[] }
  >()
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
    } else if (ref.role === "customTable.foreignKeyTarget") {
      // Ціль FK судиться цілим FK, а не колонкою: див. нижче.
      const [, , fk, , , at] = ref.from.pointer.split("/")
      const key = `${file}\0${fk}`
      const group = targetColumns.get(key) ?? {
        file,
        index: Number(fk),
        columns: [],
      }
      group.columns[Number(at)] = {
        place,
        pointer: ref.from.pointer,
        ...column!,
      }
      targetColumns.set(key, group)
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

  // FK на таблицю, що стає видом, називає ключ виду, а не колонки (спека прав §4.7):
  // ключ — `ref`, пара (скоуп, ключ) у будь-якому порядку — `scopedRef` з
  // локальними колонками в порядку складеного ключа цілі. Посилання на
  // колонку, що не стає реквізитом, без такої форми (сама колонка скоупу) —
  // відмова; на реквізит — перейменування, а форму судить компіляція
  // результату (`customTable.fk-target-not-key`).
  const keyForms = new Map<
    string,
    { index: number; key: "ref" | "scopedRef"; scopeAt: number }[]
  >()
  for (const { file, index, columns } of targetColumns.values()) {
    const roles = columns.map((c) => c.column.key)
    const scopeAt = roles.indexOf("scope")
    const key =
      roles.length === 1 && roles[0] === "ref"
        ? "ref"
        : roles.length === 2 && roles.includes("ref") && scopeAt !== -1
          ? "scopedRef"
          : undefined
    if (key !== undefined) {
      keyForms.set(file, [
        ...(keyForms.get(file) ?? []),
        { index, key, scopeAt },
      ])
      continue
    }
    for (const { place, pointer, table, column } of columns) {
      if (column.becomes !== undefined) {
        add(file, place, column.becomes)
      } else {
        problems.push(
          diagnostic("promote.retired-referenced", file, pointer, {
            table: table.table,
            column: column.name,
            role: "customTable.foreignKeyTarget",
          })
        )
      }
    }
  }

  const result = new Map<string, string>()
  for (const [file, groups] of edits) {
    const raw = rawOf(file)
    for (const { name, kind, places } of groups.values()) {
      renameJsonPlaces(raw, places, name, kind)
    }
    for (const { index, key, scopeAt } of keyForms.get(file) ?? []) {
      const fk = (raw.foreignKeys as RawForeignKey[])[index]!
      fk.references = { object: fk.references.object, key }
      if (key === "scopedRef") {
        fk.columns = [fk.columns[scopeAt]!, fk.columns[1 - scopeAt]!]
      }
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
  references: { object: unknown; columns?: string[]; key?: string }
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
