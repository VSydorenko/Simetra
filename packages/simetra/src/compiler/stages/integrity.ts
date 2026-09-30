import {
  KIND_REGISTRY,
  isSqlReservedWord,
  type AttributeCase,
  type CustomTable,
  NO_SCOPE,
  type MetadataRef,
  type ReferenceRole,
  type ScopeKind,
} from "simetra/model"
import { diagnostic, type CompilerRule, type Diagnostic } from "../diagnostics"
import { PROJECT_FILE, objectKey, type ParsedObject } from "./files"
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
  style: AttributeCase,
  scopeKinds: readonly ScopeKind[]
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

  diagnostics.push(...checkScope(objects, references, scopeKinds, byId, byKey))

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

/**
 * Ролі посилань зі значенням скоупу: джерело — скоуплений об'єкт виду 1С,
 * тож ціль мусить бути з того самого виду скоупу. Колонки `CustomTable` правил
 * посилань не мають (FK явні, спека §4), рухи документа — не FK.
 */
const SCOPED_REFERENCE_ROLES: ReadonlySet<ReferenceRole> =
  new Set<ReferenceRole>([
    "attribute.ref",
    "attribute.allowedType",
    "constant.ref",
    "constant.allowedType",
    "catalog.owner",
  ])

/**
 * Правила скоупу стадії 4 (спека П2 §6): корінь виду й посилання між
 * скоупами. Рішення про заборону живе тут, а не в стадії 3: вона не будує
 * неможливого FK і нічого не звітує.
 */
function checkScope(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  scopeKinds: readonly ScopeKind[],
  byId: ReadonlyMap<string, ParsedObject>,
  byKey: ReadonlyMap<string, ParsedObject>
): Diagnostic[] {
  const found: Diagnostic[] = []
  const kindsByName = new Map(scopeKinds.map((kind) => [kind.name, kind]))
  const scopeOf = (object: ParsedObject): ScopeKind | undefined => {
    const { scope } = object.data as { scope?: string }
    return scope === undefined || scope === NO_SCOPE
      ? undefined
      : kindsByName.get(scope)
  }
  const scopeName = (kind: ScopeKind | undefined) => kind?.name ?? NO_SCOPE

  // Корінь-об'єкт: вид, який на нього вказує (на один об'єкт — один вид).
  const rootKindOf = new Map<string, ScopeKind>()
  scopeKinds.forEach((kind, index) => {
    if (!("object" in kind.root)) return
    const { root } = kind
    const key = objectKey(root.object.kind, root.object.name)
    const rootObject = byKey.get(key)
    if (rootObject === undefined) return
    rootKindOf.set(key, kind)
    const at = {
      kind: rootObject.kind,
      name: rootObject.name,
      scope: kind.name,
    }
    if (
      KIND_REGISTRY[rootObject.kind].materializes !== "table" ||
      keyColumnOf(rootObject) === undefined
    ) {
      found.push(
        diagnostic(
          "scope.root-key",
          PROJECT_FILE,
          `/scopeKinds/${index}/root/object`,
          at
        )
      )
      return
    }
    if (scopeOf(rootObject) !== kind) {
      const { scope } = rootObject.data as { scope?: string }
      found.push(
        diagnostic(
          "scope.root-declaration",
          rootObject.file,
          scope === undefined ? "" : "/scope",
          at
        )
      )
    }
  })
  const isRoot = (object: ParsedObject, kind: ScopeKind | undefined) =>
    kind !== undefined &&
    rootKindOf.get(objectKey(object.kind, object.name)) === kind

  for (const object of objects) {
    if (!isDeclaredTable(object)) continue
    const kind = scopeOf(object)
    // Корінь скоуп-колонки не має: його ключ і є значенням скоупу.
    if (kind === undefined || isRoot(object, kind)) continue
    const table = object.data as CustomTable
    if (table.scopeColumn === undefined) {
      found.push(diagnostic("scope.custom-table-column", object.file, ""))
      continue
    }
    const column = table.columns.find((c) => c.name === table.scopeColumn)
    // Невідому колонку вже звітувала стадія 2.
    if (column === undefined) continue
    const isUuid =
      column.array !== true &&
      (column.type === "UUID" ||
        (column.type === "Raw" && column.pgType?.toLowerCase() === "uuid"))
    if (!isUuid) {
      found.push(
        diagnostic("scope.custom-table-column", object.file, "/scopeColumn", {
          column: table.scopeColumn,
        })
      )
    }
  }

  // Поліморфний `Ref` дає кілька посилань з одним елементом: `crossScope`
  // зайвий, лише якщо зайвий для кожної цілі.
  const crossScopeUse = new Map<
    string,
    { file: string; pointer: string; useful: boolean }
  >()
  for (const reference of references) {
    const source = byId.get(reference.from.objectId)
    const target = byId.get(reference.to.id)
    if (source === undefined || target === undefined) continue
    const { role, from } = reference
    const sourceKind = scopeOf(source)

    if (role === "register.recorder") {
      const recorderKind = scopeOf(target)
      if (recorderKind !== sourceKind) {
        found.push(
          diagnostic("scope.recorder-mismatch", from.file, from.pointer, {
            scope: scopeName(sourceKind),
            recorderScope: scopeName(recorderKind),
            kind: target.kind,
            name: target.name,
          })
        )
      }
      continue
    }
    if (!SCOPED_REFERENCE_ROLES.has(role)) continue

    // Корінь — ціль свого виду, хоч би що він сам оголошував.
    const rootOfTarget = rootKindOf.get(objectKey(target.kind, target.name))
    const targetKind = rootOfTarget ?? scopeOf(target)
    const elementPointer = from.pointer.replace(
      /\/(ref|allowedTypes\/\d+)$/,
      ""
    )
    const crossScope =
      (
        valueAt(source.data, elementPointer) as
          { crossScope?: true } | undefined
      )?.crossScope === true
    const params = {
      kind: target.kind,
      name: target.name,
      scope: scopeName(targetKind),
      from: scopeName(sourceKind),
    }

    if (targetKind === undefined) {
      // Складеного FK немає за будь-якого `crossScope`.
    } else if (sourceKind === targetKind) {
      if (rootOfTarget !== undefined && !isRoot(source, sourceKind)) {
        // Значення скоупу вже є скоуп-колонкою джерела; `crossScope` не рятує.
        found.push(
          diagnostic(
            "scope.root-self-reference",
            from.file,
            from.pointer,
            params
          )
        )
      }
    } else if (!crossScope) {
      found.push(
        diagnostic(
          sourceKind === undefined
            ? "scope.global-to-scoped"
            : "scope.cross-kind",
          from.file,
          from.pointer,
          params
        )
      )
    }

    if (crossScope) {
      // У цілі без складеного FK (`CustomTable`, глобальна) ключ і так плоский.
      const useful =
        targetKind !== undefined &&
        !(sourceKind === targetKind && isDeclaredTable(target))
      const at = `${elementPointer}/crossScope`
      const key = `${from.file}\0${at}`
      const known = crossScopeUse.get(key)
      crossScopeUse.set(key, {
        file: from.file,
        pointer: at,
        useful: useful || (known?.useful ?? false),
      })
    }
  }
  for (const { file, pointer, useful } of crossScopeUse.values()) {
    if (!useful) {
      found.push(diagnostic("scope.cross-scope-redundant", file, pointer))
    }
  }
  return found
}

/** Значення за JSON Pointer; `""` — сам корінь. */
function valueAt(data: unknown, pointer: string): unknown {
  let current = data
  for (const segment of pointer.split("/").slice(1)) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}
