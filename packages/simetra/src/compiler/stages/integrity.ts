import {
  KIND_REGISTRY,
  isSqlReservedWord,
  type AttributeCase,
  type CustomTable,
  type MetadataRef,
  type ReferenceRole,
} from "simetra/model"
import { diagnostic, type CompilerRule, type Diagnostic } from "../diagnostics"
import { objectKey, type ParsedObject } from "./files"
import type { ResolvedReference } from "./identity"
import {
  isDeclaredTable,
  keyColumnOf,
  logicalColumnsOf,
  type ModelStageResult,
} from "./model"

/** NAMEDATALEN Postgres мінус завершальний нуль: довше ім'я БД мовчки обріже. */
const MAX_IDENT_BYTES = 63

/**
 * Ролі, у яких посилання — значення `Ref` чи FK прийнятої таблиці: ціль
 * мусить бути видом, на який можна посилатися. Реєстратори й рухи
 * посилаються на регістри й документи за іншими правилами, власник довідника
 * — за `ownerKinds` реєстру, а колонка `CustomTable` — на `PgEnum` за власною
 * роллю.
 */
const REF_ROLES: ReadonlySet<ReferenceRole> = new Set<ReferenceRole>([
  "attribute.ref",
  "attribute.allowedType",
  "constant.ref",
  "constant.allowedType",
  "customTable.foreignKey",
])

/**
 * Ролі поліморфної пари `<основа>_type` + `<основа>_id uuid` (спека §5): ціль
 * мусить мати одноколонковий uuid-ключ, тож перерахування з текстовою міткою
 * (М15) сюди не підходить.
 */
const POLYMORPHIC_ROLES: ReadonlySet<ReferenceRole> = new Set<ReferenceRole>([
  "attribute.allowedType",
  "constant.allowedType",
  "register.recorder",
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
    const target = byId.get(reference.to.id)
    if (target === undefined) continue
    const code = referenceTargetError(reference, target, byId)
    if (code !== undefined) {
      diagnostics.push(
        diagnostic(code, reference.from.file, reference.from.pointer, {
          kind: target.kind,
          name: target.name,
        })
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
    if (isDeclaredTable(object)) {
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

/**
 * Одна причина на посилання: перша непридатність цілі поглинає наступні.
 * Відсутній uuid-ключ прийнятої таблиці звітує `reference.custom-table-key`
 * у будь-якій ролі, бо виправляють його в описі таблиці, а не в посиланні;
 * `reference.polymorphic-target-kind` лишається видам без ключа взагалі.
 */
function referenceTargetError(
  reference: ResolvedReference,
  target: ParsedObject,
  byId: ReadonlyMap<string, ParsedObject>
): CompilerRule | undefined {
  const def = KIND_REGISTRY[target.kind]
  const { role } = reference
  if (role === "catalog.owner") {
    const source = byId.get(reference.from.objectId)
    const allowed =
      source === undefined ? [] : (KIND_REGISTRY[source.kind].ownerKinds ?? [])
    return allowed.includes(target.kind) ? undefined : "catalog.owner-kind"
  }
  if (REF_ROLES.has(role)) {
    if (!def.referenceable) return "reference.not-referenceable"
    if (role === "customTable.foreignKey") {
      // FK прийнятої таблиці сам називає колонки цілі, тож одноколонковий
      // uuid-ключ йому не потрібен — лише таблиця.
      return def.materializes === "table"
        ? undefined
        : "reference.not-referenceable"
    }
  }
  const polymorphic = POLYMORPHIC_ROLES.has(role)
  if (!polymorphic && !REF_ROLES.has(role)) return undefined
  if (keyColumnOf(target) !== undefined) return undefined
  if (isDeclaredTable(target)) return "reference.custom-table-key"
  // Одиночний `Ref` на ціль без таблиці зберігає мітку (М15), ключ не потрібен.
  return polymorphic ? "reference.polymorphic-target-kind" : undefined
}

function byteLength(name: string): number {
  return new TextEncoder().encode(name).length
}

/**
 * Поліморфні множини об'єкта з pointer на масив. Обхід іде за формою даних,
 * бо ключі множин однакові в усіх видах: `allowedTypes` — у реквізитів,
 * вимірів, ресурсів, колонок і самої константи, списки власників і
 * реєстраторів — на верхньому рівні.
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
