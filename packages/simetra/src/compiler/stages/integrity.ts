import {
  KIND_REGISTRY,
  isSqlReservedWord,
  parseExpression,
  type Attribute,
  type AttributeCase,
  type CustomTable,
  type Expr,
  NO_SCOPE,
  type MetadataRef,
  type MovementDecl,
  type ReferenceRole,
  type ScopeKind,
  type StandardColumnDef,
  type ValueType,
} from "simetra/model"
import {
  diagnostic,
  toPointer,
  type CompilerRule,
  type Diagnostic,
} from "../diagnostics"
import {
  accepts,
  describeType,
  inferType,
  typeOfLogical,
  type InferredType,
  type PostingContext,
} from "../posting-types"
import { PROJECT_FILE, objectKey, type ParsedObject } from "./files"
import type { ResolvedReference } from "./identity"
import {
  isDeclaredTable,
  isUuidColumn,
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
 * (М15) сюди не підходить. Реєстратор теж пара, але його ціль звужує власне
 * правило (лише документ), а ключ у документа є завжди.
 */
const POLYMORPHIC_ROLES: ReadonlySet<ReferenceRole> = new Set<ReferenceRole>([
  "attribute.allowedType",
  "constant.allowedType",
])

/** Ролі, чия ціль — регістр, у який документ пише рухи (спека §8.2). */
const REGISTER_TARGET_ROLES: ReadonlySet<ReferenceRole> =
  new Set<ReferenceRole>(["document.registerMovement", "posting.register"])

/** Дія виду, що пише рухи: реєстратором може бути лише вид, який проводиться. */
const POST_ACTION = "post"

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
  diagnostics.push(...checkPosting(objects, references, byKey))

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
  // Регістр і вид, що проводиться, — факти реєстру, а не перелік імен видів.
  if (REGISTER_TARGET_ROLES.has(role)) {
    return def.registerKeys === undefined ? "posting.register-kind" : undefined
  }
  if (role === "register.recorder") {
    return def.actions.includes(POST_ACTION)
      ? undefined
      : "register.recorder-kind"
  }
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
  // `scopeColumn` без скоупу — хибна ознака й в однотенантному проєкті, тож це
  // єдина перевірка, що не залежить від видів скоупу.
  for (const object of objects) {
    if (!isDeclaredTable(object)) continue
    const { scope, scopeColumn, columns } = object.data as CustomTable
    const unscoped = scope === undefined || scope === NO_SCOPE
    // Невідому колонку вже звітувала стадія 2.
    if (
      unscoped &&
      scopeColumn !== undefined &&
      columns.some((c) => c.name === scopeColumn)
    ) {
      found.push(
        diagnostic("scope.custom-table-column", object.file, "/scopeColumn", {
          column: scopeColumn,
          unscoped: 1,
        })
      )
    }
  }
  // Однотенантний проєкт скоуп-правил не має, навіть `crossScope` нічого не значить.
  if (scopeKinds.length === 0) return found
  const kindsByName = new Map(scopeKinds.map((kind) => [kind.name, kind]))
  const scopeOf = (object: ParsedObject): ScopeKind | undefined => {
    const { scope } = object.data as { scope?: string }
    return scope === undefined || scope === NO_SCOPE
      ? undefined
      : kindsByName.get(scope)
  }
  const scopeName = (kind: ScopeKind | undefined) => kind?.name ?? NO_SCOPE

  // Корінь-об'єкт: вид, який на нього вказує. Два види на одному корені
  // стадія 2 відкидає (`scope.root-duplicate`), тож перезапису тут не буде.
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
    // Ієрархія видів скоупу відкладена спекою, а ієрархічний корінь її й дав би.
    const { hierarchyType } = rootObject.data as { hierarchyType?: string }
    if (hierarchyType !== undefined && hierarchyType !== "None") {
      found.push(
        diagnostic(
          "scope.root-hierarchy",
          rootObject.file,
          "/hierarchyType",
          at
        )
      )
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
    const table = object.data as CustomTable
    if (kind === undefined) continue
    // Корінь скоуп-колонки не має: його ключ і є значенням скоупу.
    if (isRoot(object, kind)) continue
    if (table.scopeColumn === undefined) {
      found.push(diagnostic("scope.custom-table-column", object.file, ""))
      continue
    }
    const column = table.columns.find((c) => c.name === table.scopeColumn)
    // Невідому колонку вже звітувала стадія 2.
    if (column === undefined) continue
    const isUuid = isUuidColumn(column)
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
    // Корінь, що хибно оголосив скоуп, лишається коренем свого виду: інакше
    // до помилки оголошення додалися б каскадні помилки посилань.
    const sourceKind =
      rootKindOf.get(objectKey(source.kind, source.name)) ?? scopeOf(source)

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
      via: role === "catalog.owner" ? "owner" : "reference",
    }

    if (targetKind === undefined) {
      // Складеного FK немає за будь-якого `crossScope`.
    } else if (sourceKind === targetKind) {
      // Значення скоупу вже є скоуп-колонкою джерела (або самим ключем
      // кореня); посилання на корінь свого виду можливе лише свідомо між
      // тенантами — тоді це звичайний FK на ключ кореня.
      if (rootOfTarget !== undefined && !crossScope) {
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
      // Прапорець зайвий, лише коли без нього посилання дозволене й фізично те
      // саме: глобальна ціль або `CustomTable` того ж виду (FK і так плоский).
      const useful =
        targetKind !== undefined &&
        !(
          sourceKind === targetKind &&
          rootOfTarget === undefined &&
          isDeclaredTable(target)
        )
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

const UNKNOWN: InferredType = { kind: "unknown" }

/** Поля регістра за роллю — у порядку `columnFields` реєстру видів. */
type RegisterFieldRole = "dimensions" | "resources" | "attributes"

/** Усі вузли виразу, у порядку появи. */
function nodesOf(expr: Expr): Expr[] {
  switch (expr.type) {
    case "unary":
      return [expr, ...nodesOf(expr.operand)]
    case "binary":
      return [expr, ...nodesOf(expr.left), ...nodesOf(expr.right)]
    default:
      return [expr]
  }
}

/**
 * Семантика рухів конструктора (спека П2 §7, §8.2): регістр оголошено й
 * документ — його реєстратор, `fields` повні, `row.` і агрегати — за
 * джерелом, вид руху — лише в регістра з ним, а типи виразів підходять
 * полям. Ціль, що не регістр, уже звітувала перевірка посилань; рух у неї
 * тут пропускається, щоб не дати каскаду.
 */
function checkPosting(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  byKey: ReadonlyMap<string, ParsedObject>
): Diagnostic[] {
  const found: Diagnostic[] = []
  // Резолвлене ім'я виразу — за полем і початком вузла: так стадія 2 уже
  // зв'язала вузол AST з елементом, і повторно резолвити імена не треба.
  const resolved = new Map<string, string>()
  const spanKey = (file: string, pointer: string, start: number) =>
    `${file}\0${pointer}\0${start}`
  for (const { role, from, to, span } of references) {
    if (
      span !== undefined &&
      (role === "posting.docField" || role === "posting.rowField")
    ) {
      resolved.set(spanKey(from.file, from.pointer, span.start), to.id)
    }
  }
  const idOf = (ref: MetadataRef) =>
    byKey.get(objectKey(ref.kind, ref.name))?.id
  const typeOfField = (field: ValueType): InferredType => {
    const refs =
      field.ref !== undefined ? [field.ref] : (field.allowedTypes ?? [])
    const targets = refs.map(idOf)
    if (targets.some((id) => id === undefined)) return UNKNOWN
    return typeOfLogical(field.type, targets as string[], field.array === true)
  }

  for (const object of objects) {
    const data = object.data as {
      posting?: { movements: MovementDecl[] }
      registerMovements?: MetadataRef[]
      tabularSections?: { id?: string; attributes: Attribute[] }[]
    }
    const declared = new Set(
      (data.registerMovements ?? []).map((ref) => objectKey(ref.kind, ref.name))
    )
    // Реєстратор оголошує регістр; документ, що пише в регістр, мусить бути в
    // його переліку — хоч би звідки йшли рухи (конструктор чи блок запиту).
    ;(data.registerMovements ?? []).forEach((ref, index) => {
      const register = byKey.get(objectKey(ref.kind, ref.name))
      if (register === undefined) return
      if (KIND_REGISTRY[register.kind].registerKeys === undefined) return
      const { recorderTypes } = register.data as {
        recorderTypes?: MetadataRef[]
      }
      const own = objectKey(object.kind, object.name)
      if (
        !(recorderTypes ?? []).some((r) => objectKey(r.kind, r.name) === own)
      ) {
        found.push(
          diagnostic(
            "posting.recorder-not-allowed",
            object.file,
            `/registerMovements/${index}`,
            { name: register.name, document: object.name }
          )
        )
      }
    })

    const movements = data.posting?.movements
    if (movements === undefined || object.id === undefined) continue
    const def = KIND_REGISTRY[object.kind]
    const ownerId = object.id
    // Типи імен документа: власні елементи за UUID, стандартні реквізити — за
    // синтетичним id `<власник>#<канонічне ім'я>`, як їх записала стадія 2.
    const elementTypes = new Map<string, InferredType>()
    const standardType = (
      column: StandardColumnDef,
      self: string | undefined
    ): InferredType => {
      if ("raw" in column.type) return UNKNOWN
      if (column.ref === "self") {
        return self === undefined ? UNKNOWN : { kind: "ref", targets: [self] }
      }
      if (column.ref === "owningObject") {
        return { kind: "ref", targets: [ownerId] }
      }
      // Власник і реєстратор — поліморфні пари без цілі у виразі.
      if (column.ref !== undefined) return UNKNOWN
      return typeOfLogical(column.type.type)
    }
    for (const column of def.standardColumns(data)) {
      elementTypes.set(
        `${ownerId}#${column.logicalName}`,
        standardType(column, ownerId)
      )
    }
    for (const field of def.columnFields) {
      for (const element of (data as Record<string, Attribute[]>)[field] ??
        []) {
        if (element.id !== undefined) {
          elementTypes.set(element.id, typeOfField(element))
        }
      }
    }
    const rowColumns = def.tabularSectionColumns?.(data) ?? []
    for (const section of data.tabularSections ?? []) {
      if (section.id === undefined) continue
      // Рядок ТЧ — не об'єкт метаданих, тож на нього самого `Ref` не веде.
      for (const column of rowColumns) {
        elementTypes.set(
          `${section.id}#${column.logicalName}`,
          standardType(column, undefined)
        )
      }
      for (const element of section.attributes) {
        if (element.id !== undefined) {
          elementTypes.set(element.id, typeOfField(element))
        }
      }
    }

    movements.forEach((movement, index) => {
      const register = byKey.get(
        objectKey(movement.register.kind, movement.register.name)
      )
      if (register === undefined) return
      const registerDef = KIND_REGISTRY[register.kind]
      const keys = registerDef.registerKeys?.(register.data)
      if (keys === undefined) return
      const at = (...path: (string | number)[]) =>
        toPointer(["posting", "movements", index, ...path])
      if (!declared.has(objectKey(register.kind, register.name))) {
        found.push(
          diagnostic(
            "posting.register-undeclared",
            object.file,
            at("register"),
            {
              name: register.name,
            }
          )
        )
      }

      const fromDocument = movement.source === "document"
      /**
       * Розібраний вираз, придатний до типізації. Зламаний розбір (його звітує
       * T0) і вираз із порушенням джерела типізувати нема сенсу: `row.` без
       * ТЧ не резолвлено, і тип дав би лише другу помилку на тому ж місці.
       */
      const expression = (
        text: string | undefined,
        pointer: string
      ): Expr | undefined => {
        if (text === undefined) return undefined
        const parsed = parseExpression(text)
        if (!parsed.ok) return undefined
        let valid = true
        for (const node of nodesOf(parsed.expr)) {
          const code =
            fromDocument && node.type === "field" && node.base === "row"
              ? "posting.row-in-document-source"
              : !fromDocument && (node.type === "sum" || node.type === "count")
                ? "posting.aggregate-in-section-source"
                : undefined
          if (code === undefined) continue
          valid = false
          found.push(
            diagnostic(code, object.file, pointer, { offset: node.start })
          )
        }
        return valid ? parsed.expr : undefined
      }
      const typeAt = (expr: Expr, pointer: string): InferredType => {
        const ctx: PostingContext = {
          typeOf: (node) => {
            const id = resolved.get(spanKey(object.file, pointer, node.start))
            return id === undefined
              ? UNKNOWN
              : (elementTypes.get(id) ?? UNKNOWN)
          },
        }
        return inferType(expr, ctx)
      }
      const mismatch = (
        pointer: string,
        expr: Expr,
        expected: string,
        actual: InferredType
      ) =>
        found.push(
          diagnostic("posting.type-mismatch", object.file, pointer, {
            expected,
            actual: describeType(actual),
            offset: expr.start,
          })
        )
      const expectKind = (
        text: string | undefined,
        pointer: string,
        expected: InferredType
      ) => {
        const expr = expression(text, pointer)
        if (expr === undefined) return
        const actual = typeAt(expr, pointer)
        if (actual.kind !== "unknown" && actual.kind !== expected.kind) {
          mismatch(pointer, expr, describeType(expected), actual)
        }
      }
      expectKind(movement.condition, at("condition"), { kind: "boolean" })
      expectKind(movement.period, at("period"), { kind: "date" })

      // Вид руху — стандартна колонка регістра, тож її наявність і є фактом
      // реєстру про те, чи потрібен рух виду.
      const hasMovementType = registerDef
        .standardColumns(register.data)
        .some((column) => column.logicalName === "movementType")
      const { movementType } = movement
      if (movementType === undefined) {
        if (hasMovementType) {
          found.push(
            diagnostic("posting.movement-type", object.file, at(), {
              problem: "missing",
              register: register.name,
            })
          )
        }
      } else if (!hasMovementType) {
        found.push(
          diagnostic("posting.movement-type", object.file, at("movementType"), {
            problem: "forbidden",
            register: register.name,
          })
        )
      } else if (movementType !== "Receipt" && movementType !== "Expense") {
        const pointer = at("movementType")
        const expr = expression(movementType, pointer)
        const actual = expr === undefined ? UNKNOWN : typeAt(expr, pointer)
        if (
          expr !== undefined &&
          actual.kind !== "unknown" &&
          actual.kind !== "text"
        ) {
          found.push(
            diagnostic("posting.movement-type", object.file, pointer, {
              problem: "type",
              actual: describeType(actual),
              offset: expr.start,
            })
          )
        }
      }

      const fields = register.data as Record<RegisterFieldRole, Attribute[]>
      const required = [
        ...fields.dimensions,
        ...fields.resources.filter(
          (resource) => keys.additiveResources || resource.required
        ),
      ].map((field) => field.name)
      const missing = required.filter((name) => !(name in movement.fields))
      if (missing.length > 0) {
        found.push(
          diagnostic("posting.fields-incomplete", object.file, at("fields"), {
            missing: missing.join(", "),
            register: register.name,
          })
        )
      }

      const roles: readonly RegisterFieldRole[] = [
        "dimensions",
        "resources",
        "attributes",
      ]
      for (const [key, text] of Object.entries(movement.fields)) {
        const role = roles.find((r) => fields[r].some((f) => f.name === key))
        // Невідомий ключ уже звітувала стадія 2.
        if (role === undefined) continue
        const field = fields[role].find((f) => f.name === key)!
        const pointer = at("fields", key)
        const expr = expression(text, pointer)
        if (expr === undefined) continue
        const expected = typeOfField(field)
        const actual = typeAt(expr, pointer)
        // Порожнє значення приймає лише колонка, що може бути порожньою: не
        // вимір (виміри входять у ключі), не адитивний ресурс і не `required`.
        const nullable =
          !(role === "dimensions" && keys.dimensionsNotNull) &&
          !(role === "resources" && keys.additiveResources) &&
          !field.required
        if (actual.kind === "null" ? !nullable : !accepts(expected, actual)) {
          mismatch(
            pointer,
            expr,
            actual.kind === "null"
              ? `a non-empty ${describeType(expected)}`
              : describeType(expected),
            actual
          )
        }
      }
    })
  }
  return found
}
