import {
  KIND_REGISTRY,
  isSqlReservedWord,
  type AttributeCase,
  type CustomTable,
  type MetadataRef,
  type ReferenceRole,
} from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import { objectKey, type ParsedObject } from "./files"
import type { ResolvedReference } from "./identity"
import { keyColumnOf, logicalColumnsOf, type ModelStageResult } from "./model"

/** NAMEDATALEN Postgres мінус завершальний нуль: довше ім'я БД мовчки обріже. */
const MAX_IDENT_BYTES = 63

/**
 * Ролі, у яких посилання — значення `Ref`: ціль мусить бути видом, на який
 * можна посилатися. Реєстратори й рухи посилаються на регістри й документи за
 * іншими правилами, а колонка `CustomTable` — на `PgEnum` за власною роллю.
 */
const REF_ROLES: ReadonlySet<ReferenceRole> = new Set<ReferenceRole>([
  "attribute.ref",
  "attribute.allowedType",
  "constant.ref",
  "constant.allowedType",
  "catalog.owner",
  "customTable.foreignKey",
])

/** Поліморфні множини: їхні цілі розрізняє `physicalName` (спека §5). */
const POLYMORPHIC_SETS = ["allowedTypes", "owners", "recorderTypes"] as const

/**
 * Стадія 4, частина П2 (спека §3, §4, §5, §8.2): придатність цілей
 * посилань і унікальність фізичних імен. Першим вважається те, що раніше за
 * шляхом файлу й за порядком у файлі; помилку отримує пізніше.
 */
export function checkIntegrity(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  model: ModelStageResult,
  style: AttributeCase
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const byId = new Map(objects.map((o) => [o.id ?? "", o]))
  const byKey = new Map(objects.map((o) => [objectKey(o.kind, o.name), o]))

  for (const reference of references) {
    if (!REF_ROLES.has(reference.role)) continue
    const target = byId.get(reference.to.id)
    if (target === undefined) continue
    const def = KIND_REGISTRY[target.kind]
    const { file, pointer } = reference.from
    const params = { kind: target.kind, name: target.name }
    // FK прийнятої таблиці потребує таблиці цілі, а не лише права посилатися.
    const needsTable = reference.role === "customTable.foreignKey"
    if (!def.referenceable || (needsTable && def.materializes !== "table")) {
      diagnostics.push(
        diagnostic("reference.not-referenceable", file, pointer, params)
      )
    } else if (
      !needsTable &&
      def.materializes === "table" &&
      keyColumnOf(target) === undefined
    ) {
      diagnostics.push(
        diagnostic("reference.custom-table-key", file, pointer, params)
      )
    }
  }

  // Таблиці й енам-типи ділять простір імен типів PG-схеми.
  const relations = new Map<string, string>()
  for (const source of model.sources) {
    const key = `${source.schema}.${source.name}`
    const first = relations.get(key)
    if (first === undefined) {
      relations.set(key, source.file)
    } else {
      diagnostics.push(
        diagnostic("physical.table-duplicate", source.file, source.pointer, {
          name: key,
          firstFile: first,
        })
      )
    }

    const columns = new Set<string>()
    for (const column of source.columns) {
      const pointer = column.pointer ?? source.pointer
      if (columns.has(column.name)) {
        diagnostics.push(
          diagnostic("physical.column-duplicate", source.file, pointer, {
            name: column.name,
            table: key,
          })
        )
      }
      columns.add(column.name)
      if (byteLength(column.name) > MAX_IDENT_BYTES) {
        diagnostics.push(
          diagnostic("physical.name-too-long", source.file, pointer, {
            name: column.name,
          })
        )
      }
    }
    for (const { name, pointer } of source.explicitNames) {
      if (byteLength(name) > MAX_IDENT_BYTES) {
        diagnostics.push(
          diagnostic("physical.name-too-long", source.file, pointer, { name })
        )
      }
    }
  }

  for (const object of objects) {
    for (const { pointer, refs } of polymorphicSets(object.data)) {
      const seen = new Set<string>()
      refs.forEach((ref, index) => {
        const target = byKey.get(objectKey(ref.kind, ref.name))
        if (target === undefined) return
        const name = (target.data as { physicalName: string }).physicalName
        if (seen.has(name)) {
          diagnostics.push(
            diagnostic(
              "physical.discriminator-duplicate",
              object.file,
              `${pointer}/${index}`,
              { name }
            )
          )
        }
        seen.add(name)
      })
    }
  }

  for (const object of objects) {
    if (Array.isArray((object.data as { columns?: unknown }).columns)) {
      diagnostics.push(...checkDeclaredTable(object, byKey, style))
    }
  }

  for (const { file, pointer, name } of model.declaredNames) {
    if (isSqlReservedWord(name)) {
      diagnostics.push(
        diagnostic("physical.reserved-word", file, pointer, { name })
      )
    }
  }
  return diagnostics
}

function byteLength(name: string): number {
  return new TextEncoder().encode(name).length
}

/**
 * Поліморфні множини об'єкта з pointer на масив. Де вони лежать, визначає
 * форма даних (як у стадії 2): `allowedTypes` — у реквізитів, вимірів,
 * ресурсів, колонок і самої константи, списки власників і реєстраторів — на
 * верхньому рівні.
 */
function polymorphicSets(
  data: unknown
): { pointer: string; refs: MetadataRef[] }[] {
  const found: { pointer: string; refs: MetadataRef[] }[] = []
  const visit = (value: unknown, pointer: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${pointer}/${index}`))
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      const at = `${pointer}/${key}`
      if ((POLYMORPHIC_SETS as readonly string[]).includes(key)) {
        if (Array.isArray(child)) found.push({ pointer: at, refs: child })
      } else {
        visit(child, at)
      }
    }
  }
  visit(data, "")
  return found
}

/**
 * Опис прийнятої таблиці посилається на колонки логічними іменами; невідоме
 * ім'я — помилка, а не тиха підміна фізичним. Сумісність типів і ключ цілі FK
 * перевіряє тінь, а не компілятор.
 */
function checkDeclaredTable(
  object: ParsedObject,
  byKey: ReadonlyMap<string, ParsedObject>,
  style: AttributeCase
): Diagnostic[] {
  const table = object.data as CustomTable
  const found: Diagnostic[] = []
  const own = logicalColumnsOf(object, style)
  const columnsExist = (
    names: readonly string[],
    pointer: string,
    columns = own,
    owner = object.name
  ) => {
    names.forEach((name, index) => {
      if (!columns.has(name)) {
        found.push(
          diagnostic(
            "customTable.column-unknown",
            object.file,
            `${pointer}/${index}`,
            { column: name, table: owner }
          )
        )
      }
    })
  }
  const nameRequired = (pointer: string) =>
    found.push(
      diagnostic("physical.constraint-name-required", object.file, pointer)
    )

  if (table.primaryKey !== undefined) {
    columnsExist(table.primaryKey.columns, "/primaryKey/columns")
  }
  table.uniques.forEach((unique, i) => {
    columnsExist(unique.columns, `/uniques/${i}/columns`)
  })
  // Ім'я безіменного CHECK Postgres бере з першої колонки дерева виразу.
  table.checks.forEach((check, i) => {
    if (check.name === undefined) nameRequired(`/checks/${i}`)
  })
  table.foreignKeys.forEach((foreignKey, i) => {
    const pointer = `/foreignKeys/${i}`
    columnsExist(foreignKey.columns, `${pointer}/columns`)
    const { references } = foreignKey
    let referenced: readonly string[]
    if ("object" in references) {
      referenced = references.columns
      const target = byKey.get(
        objectKey(references.object.kind, references.object.name)
      )
      // Ціль без таблиці вже звітує reference.not-referenceable.
      if (
        target !== undefined &&
        KIND_REGISTRY[target.kind].materializes === "table"
      ) {
        columnsExist(
          references.columns,
          `${pointer}/references/columns`,
          logicalColumnsOf(target, style),
          target.name
        )
      }
    } else {
      referenced = references.external.columns
    }
    if (referenced.length !== foreignKey.columns.length) {
      found.push(
        diagnostic("customTable.foreign-key-arity", object.file, pointer, {
          local: foreignKey.columns.length,
          referenced: referenced.length,
        })
      )
    }
  })
  table.indexes.forEach((index, i) => {
    const pointer = `/indexes/${i}`
    index.keys.forEach((key, k) => {
      if ("column" in key && !own.has(key.column)) {
        found.push(
          diagnostic(
            "customTable.column-unknown",
            object.file,
            `${pointer}/keys/${k}`,
            { column: key.column, table: object.name }
          )
        )
      }
    })
    columnsExist(index.include, `${pointer}/include`)
    // Колонку-вираз Postgres називає за деревом виразу (FigureIndexColname).
    if (
      index.name === undefined &&
      index.keys.some((key) => "expression" in key)
    ) {
      nameRequired(pointer)
    }
  })
  return found
}
