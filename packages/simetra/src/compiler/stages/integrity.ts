import {
  DELETE_EVENTS,
  KIND_REGISTRY,
  PROVIDER_EVENT_SOURCES,
  isUuidColumn,
  postsMovements,
  isSqlReservedWord,
  parseExpression,
  walkExpr,
  defaultViolatesValueChecks,
  type Attribute,
  type AttributeCase,
  type Catalog,
  type CatalogAttribute,
  type CustomTable,
  type DatabaseProvider,
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
  compareStrings,
  diagnostic,
  toPointer,
  valueAt,
  type CompilerRule,
  type Diagnostic,
} from "../diagnostics"
import {
  accepts,
  describeType,
  inferType,
  typeOfLogical,
  type InferredType,
  type OperandError,
  type PostingContext,
} from "../posting-types"
import {
  derivedFunctions,
  subscriptionSourceTables,
  type DerivedFunction,
} from "../contracts"
import { movementWrapperName } from "../movement-functions"
import { standardOverrideNames, type PresentationFields } from "../presentation"
import { pgNamespaceKeys, type VerbatimUnit } from "../sql/units"
import { PROJECT_FILE, objectKey, type ParsedObject } from "./files"
import {
  registerTargetError,
  standardElementId,
  type ResolvedReference,
} from "./identity"
import {
  isDeclaredTable,
  keyColumnOf,
  usersCatalogOf,
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

/** Ролі одиночного `Ref`, чий елемент може мати типове значення (спека §5). */
const DEFAULT_VALUE_ROLES: ReadonlySet<ReferenceRole> = new Set<ReferenceRole>([
  "attribute.ref",
  "constant.ref",
])

/** Ролі резолвленого типового значення-перерахування (стадія 2). */
const ENUM_DEFAULT_ROLES: ReadonlySet<ReferenceRole> = new Set<ReferenceRole>([
  "attribute.enumDefault",
  "constant.enumDefault",
])

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
  scopeKinds: readonly ScopeKind[],
  sqlUnits: readonly VerbatimUnit[],
  provider: DatabaseProvider
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

  diagnostics.push(
    ...functionCollisions(
      derivedFunctions(
        objects,
        references,
        model.physical,
        movementWrapperName
      ),
      sqlUnits
    )
  )

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

    // Колонка без власного pointer — платформна (напр. `month` похідної
    // таблиці): автор не називав її, тож зіткнення виправляється в елементі,
    // що першим зайняв ім'я, а не в `physicalName` усього об'єкта.
    const columns = new Map<string, string | undefined>()
    for (const column of source.columns) {
      const first = columns.get(column.name)
      const pointer = column.pointer ?? first ?? source.pointer
      if (columns.has(column.name)) {
        diagnostics.push(
          diagnostic("physical.column-duplicate", source.file, pointer, {
            name: column.name,
            table: key,
          })
        )
      } else {
        columns.set(column.name, column.pointer)
      }
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
  diagnostics.push(...relationNameCollisions(model))

  for (const object of objects) {
    if (isDeclaredTable(object)) {
      diagnostics.push(...checkDeclaredTable(object, byKey))
    }
  }

  diagnostics.push(...checkDefaultValues(references, byId))
  diagnostics.push(...checkStandardOverrides(objects, style))
  diagnostics.push(...checkUniqueWithinPlace(objects))
  diagnostics.push(...checkCompositeIndexes(objects, style))
  diagnostics.push(...checkScope(objects, references, scopeKinds, byId, byKey))
  diagnostics.push(...checkPosting(objects, references, byKey))
  diagnostics.push(...checkSubscriptions(objects, model, provider))
  diagnostics.push(...checkUsersCatalogs(objects, model))

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
 * Роль «користувачі» (спека користувачів §4, §5). Провізія вставляє рядок
 * лише з ключем і найменуванням, тож власна колонка «Користувачів» мусить
 * прийняти такий рядок — інакше помилка в тригері зірвала б реєстрацію (С3).
 * Перевірка статична, над оголошеннями реквізитів; правило рядка статично
 * не доводиться, тож у модулі «Користувачів» його немає взагалі.
 */
function checkUsersCatalogs(
  objects: readonly ParsedObject[],
  model: ModelStageResult
): Diagnostic[] {
  const found: Diagnostic[] = []
  const first = usersCatalogOf(objects)
  for (const object of objects) {
    const data = object.data as Catalog
    if (data.role !== "users") continue
    const name = object.name
    if (object !== first) {
      found.push(
        diagnostic("users.catalog-duplicate", object.file, "/role", {
          name,
          firstFile: first!.file,
        })
      )
    }
    if (data.scope !== undefined && data.scope !== NO_SCOPE) {
      found.push(
        diagnostic("users.scope-not-none", object.file, "/scope", { name })
      )
    }
    if (data.descriptionLength === 0) {
      found.push(
        diagnostic(
          "users.description-required",
          object.file,
          "/descriptionLength",
          {
            name,
          }
        )
      )
    }
    for (const field of KIND_REGISTRY[object.kind].columnFields) {
      const attributes = (object.data as Record<string, unknown>)[field] as
        CatalogAttribute[] | undefined
      attributes?.forEach((attribute, index) => {
        const reason = provisionHazard(attribute)
        if (reason === undefined) return
        found.push(
          diagnostic(
            "users.provision-unsafe",
            object.file,
            `/${field}/${index}`,
            {
              name,
              reason,
              element: attribute.name,
            }
          )
        )
      })
    }
    for (const table of model.physical.tables) {
      if (table.origin.objectId !== object.id) continue
      for (const check of table.checks) {
        if (check.origin === undefined) continue
        found.push(
          diagnostic("users.provision-unsafe", check.origin.rowRule.file, "", {
            name,
            reason: "rowRule",
            element: check.name,
          })
        )
      }
    }
  }
  return found
}

/** Перша причина, з якої вставка провізії порушила б обмеження реквізиту. */
function provisionHazard(attribute: CatalogAttribute): string | undefined {
  const filled = attribute.defaultValue !== undefined
  if (attribute.required && !filled) return "requiredWithoutDefault"
  // Типове значення однакове для кожного рядка: друга реєстрація дала б дубль.
  if (attribute.unique !== false && filled) return "uniqueWithDefault"
  if (defaultViolatesValueChecks(attribute)) return "defaultViolatesCheck"
  return undefined
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
    return registerTargetError(target)
  }
  // Тригер підписки стоїть на таблиці, тож джерело без неї слухати нічого.
  if (role === "eventSubscription.source") {
    return def.materializes === "table"
      ? undefined
      : "subscription.source-not-table"
  }
  if (role === "register.recorder") {
    return postsMovements(target.kind) ? undefined : "register.recorder-kind"
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
  if (keyColumnOf(target) !== undefined) {
    return singleRefBuildsForeignKey(reference, byId) &&
      isDeclaredTable(target) &&
      onlyDeferrableKey(target.data as CustomTable, [
        (target.data as CustomTable).primaryKey!.columns[0]!,
      ])
      ? "reference.custom-table-deferrable-key"
      : undefined
  }
  if (isDeclaredTable(target)) return "reference.custom-table-key"
  // Одиночний `Ref` на ціль без таблиці зберігає мітку (М15), ключ не потрібен.
  return polymorphic ? "reference.polymorphic-target-kind" : undefined
}

/**
 * Підписки на подію (спека промоції §9.3): таблиця провайдера — з пресету
 * провайдера проєкту; джерело й ім'я `whenChanged` — не більше разу;
 * `whenChanged` — лише з подіями запису, і кожне ім'я мусить бути в кожному
 * джерелі (фізичні колонки контракт несе окремо для кожного джерела).
 * `physicalName` — база імені тригера: дві однакові дали б однойменні тригери
 * на спільній таблиці, а простору імен таблиць підписка не займає. Джерело-
 * об'єкт без таблиці звітує перевірка цілей посилань, невідоме — стадія 2.
 */
function checkSubscriptions(
  objects: readonly ParsedObject[],
  model: ModelStageResult,
  provider: DatabaseProvider
): Diagnostic[] {
  const found: Diagnostic[] = []
  const triggerNames = new Map<string, string>()
  for (const object of objects) {
    const spec = KIND_REGISTRY[object.kind].subscription?.(object.data)
    if (spec === undefined) continue
    const { physicalName } = object.data as { physicalName?: string }
    if (physicalName !== undefined) {
      const firstFile = triggerNames.get(physicalName)
      if (firstFile === undefined) {
        triggerNames.set(physicalName, object.file)
      } else {
        found.push(
          diagnostic(
            "subscription.name-duplicate",
            object.file,
            "/physicalName",
            {
              name: physicalName,
              firstFile,
            }
          )
        )
      }
    }
    const tables = subscriptionSourceTables(
      object,
      objects,
      model.physical,
      provider
    )
    const seenSources = new Set<string>()
    for (const source of spec.sources) {
      const key =
        "ref" in source
          ? objectKey(source.ref.kind, source.ref.name)
          : `${source.providerTable.schema}.${source.providerTable.table}`
      if (seenSources.has(key)) {
        found.push(
          diagnostic(
            "subscription.source-duplicate",
            object.file,
            source.pointer,
            {
              source: key,
            }
          )
        )
      }
      seenSources.add(key)
      if (!("providerTable" in source) || tables.get(source.pointer)) continue
      const { schema, table } = source.providerTable
      found.push(
        diagnostic(
          "subscription.provider-table-unknown",
          object.file,
          source.pointer,
          {
            table: `${schema}.${table}`,
            provider,
            known: PROVIDER_EVENT_SOURCES[provider]
              .map((s) => `${s.schema}.${s.table}`)
              .join(", "),
          }
        )
      )
    }
    if (spec.whenChanged === undefined) continue
    if (DELETE_EVENTS.has(spec.event)) {
      found.push(
        diagnostic(
          "subscription.when-changed-on-delete",
          object.file,
          "/whenChanged",
          { event: spec.event }
        )
      )
      continue
    }
    const seenNames = new Set<string>()
    spec.whenChanged.forEach((name, index) => {
      const pointer = `/whenChanged/${index}`
      if (seenNames.has(name)) {
        found.push(
          diagnostic(
            "subscription.when-changed-duplicate",
            object.file,
            pointer,
            {
              name,
            }
          )
        )
        return
      }
      seenNames.add(name)
      for (const source of spec.sources) {
        const table = tables.get(source.pointer)
        if (table === undefined || table.columns.has(name)) continue
        found.push(
          diagnostic(
            "subscription.when-changed-unknown",
            object.file,
            pointer,
            {
              name,
              source:
                "ref" in source
                  ? `${source.ref.kind} "${source.ref.name}"`
                  : `provider table ${table.schema}.${table.table}`,
            }
          )
        )
      }
    })
  }
  return found
}

/**
 * Одиночний скалярний `Ref` стає FK на ключ цілі; масив FK не має (спека §4),
 * поліморфна пара — теж, тож відкладеність ключа цілі їм байдужа.
 */
function singleRefBuildsForeignKey(
  reference: ResolvedReference,
  byId: ReadonlyMap<string, ParsedObject>
): boolean {
  if (reference.role !== "attribute.ref" && reference.role !== "constant.ref")
    return false
  const source = byId.get(reference.from.objectId)
  const { pointer } = reference.from
  const element = valueAt(
    source?.data,
    pointer.slice(0, pointer.lastIndexOf("/"))
  ) as { array?: boolean } | undefined
  return element?.array !== true
}

/**
 * Postgres відкидає FK, чиїм єдиним ключем цілі на цих колонках є DEFERRABLE
 * PK чи UNIQUE (`cannot use a deferrable unique constraint for referenced
 * table`). Ціль FK — будь-який невідкладений ключ на тій самій множині
 * колонок, зокрема унікальний індекс без умови й виразів, тож лише його
 * відсутність поруч із відкладеним ключем — помилка. Відсутність ключа взагалі
 * — не ця перевірка: її лишено тіні (спека §4).
 */
function onlyDeferrableKey(
  table: CustomTable,
  columns: readonly string[]
): boolean {
  // Postgres зіставляє ключ цілі з колонками FK як множини, без порядку.
  const asSet = (names: readonly string[]) =>
    JSON.stringify([...new Set(names)].sort(compareStrings))
  const wanted = asSet(columns)
  const same = (names: readonly string[]) => asSet(names) === wanted
  const keys: { columns: readonly string[]; deferred: boolean }[] = [
    ...(table.primaryKey !== undefined
      ? [
          {
            columns: table.primaryKey.columns,
            deferred: table.primaryKey.deferrable !== "no",
          },
        ]
      : []),
    ...table.uniques.map((unique) => ({
      columns: unique.columns,
      deferred: unique.deferrable !== "no",
    })),
    ...table.indexes
      .filter(
        (index) =>
          index.unique &&
          index.where === undefined &&
          index.keys.every((key) => "column" in key)
      )
      .map((index) => ({
        columns: index.keys.map((key) => ("column" in key ? key.column : "")),
        deferred: false,
      })),
  ].filter((key) => same(key.columns))
  return keys.length > 0 && keys.every((key) => key.deferred)
}

/**
 * Типове значення одиночного `Ref` (спека §5): типового посилання на рядок
 * даних немає, а для перерахування значення — логічне ім'я наявного значення.
 * Форму скаляра вже перевірила схема; ціль, на яку посилатися не можна, уже
 * звітує `referenceTargetError`.
 */
function checkDefaultValues(
  references: readonly ResolvedReference[],
  byId: ReadonlyMap<string, ParsedObject>
): Diagnostic[] {
  const found: Diagnostic[] = []
  // Значення перерахування резолвила стадія 2: заданий default без запису
  // індексу не назвав наявного значення, і другого прочитання імен немає.
  const enumDefaults = new Set(
    references
      .filter((r) => ENUM_DEFAULT_ROLES.has(r.role))
      .map((r) => `${r.from.file}\0${r.from.pointer}`)
  )
  for (const reference of references) {
    if (!DEFAULT_VALUE_ROLES.has(reference.role)) continue
    const source = byId.get(reference.from.objectId)
    const target = byId.get(reference.to.id)
    if (source === undefined || target === undefined) continue
    const element = reference.from.pointer.replace(/\/ref$/, "")
    const pointer = `${element}/defaultValue`
    const value = valueAt(source.data, pointer)
    if (typeof value !== "string") continue
    const def = KIND_REGISTRY[target.kind]
    if (!def.referenceable) continue
    const params = { kind: target.kind, name: target.name }
    if (def.materializes === "table") {
      found.push(
        diagnostic(
          "reference.default-to-table",
          reference.from.file,
          pointer,
          params
        )
      )
    } else if (def.valueElements) {
      if (!enumDefaults.has(`${reference.from.file}\0${pointer}`)) {
        found.push(
          diagnostic(
            "reference.default-unknown-value",
            reference.from.file,
            pointer,
            { ...params, value }
          )
        )
      }
    }
  }
  return found
}

/**
 * Ключі `standardAttributeOverrides` — лише стандартні реквізити цього виду
 * (спека §8.2): перелік дає реєстр за налаштуваннями об'єкта, для рядка ТЧ —
 * `tabularSectionColumns`. Ім'я приймається канонічним або в стилі проєкту.
 */
function checkStandardOverrides(
  objects: readonly ParsedObject[],
  style: AttributeCase
): Diagnostic[] {
  const found: Diagnostic[] = []
  for (const object of objects) {
    const def = KIND_REGISTRY[object.kind]
    const data = object.data as PresentationFields
    const report = (
      overrides: PresentationFields["standardAttributeOverrides"],
      columns: readonly StandardColumnDef[],
      prefix: readonly PropertyKey[],
      section?: string
    ) => {
      const names = standardOverrideNames(columns, style)
      for (const name of Object.keys(overrides ?? {})) {
        if (names.has(name)) continue
        found.push(
          diagnostic(
            "presentation.unknown-standard-attribute",
            object.file,
            toPointer([...prefix, "standardAttributeOverrides", name]),
            {
              name,
              kind: object.kind,
              ...(section === undefined ? {} : { section }),
            }
          )
        )
      }
    }
    report(
      data.standardAttributeOverrides,
      def.standardColumns(object.data),
      []
    )
    if (def.tabularSectionColumns !== undefined) {
      const rowColumns = def.tabularSectionColumns(object.data)
      ;(data.tabularSections ?? []).forEach((section, index) => {
        report(
          section.standardAttributeOverrides,
          rowColumns,
          ["tabularSections", index],
          section.name
        )
      })
    }
  }
  return found
}

/**
 * `uniqueWithin` звужує унікальність до власника чи батька, тож діє лише на
 * власні реквізити об'єкта, чий вид з налаштуваннями має відповідний
 * стандартний реквізит (факт реєстру, а не ім'я виду). Де властивості місця
 * немає взагалі (ТЧ, документ, регістр), її не приймає схема.
 */
function checkUniqueWithinPlace(
  objects: readonly ParsedObject[]
): Diagnostic[] {
  const found: Diagnostic[] = []
  type WithWithin = { uniqueWithin?: "owner" | "parent" }
  for (const object of objects) {
    const def = KIND_REGISTRY[object.kind]
    const data = object.data as Record<string, unknown>
    const standard = new Set(
      def.standardColumns(object.data).map((column) => column.logicalName)
    )
    for (const field of def.columnFields) {
      ;((data[field] ?? []) as WithWithin[]).forEach((attribute, index) => {
        const within = attribute.uniqueWithin
        if (within === undefined || standard.has(within)) return
        found.push(
          diagnostic(
            "attribute.unique-within-place",
            object.file,
            `/${field}/${index}/uniqueWithin`,
            { kind: object.kind, name: object.name, within }
          )
        )
      })
    }
  }
  return found
}

/**
 * Імена в `indexes` — реквізити й стандартні реквізити власної таблиці:
 * об'єкта або рядка секції (для секції — за `tabularSectionColumns`). Ім'я
 * стандартного реквізиту приймається канонічним чи в стилі проєкту. Один
 * реквізит двічі в індексі не додає нічого до ключа.
 */
function checkCompositeIndexes(
  objects: readonly ParsedObject[],
  style: AttributeCase
): Diagnostic[] {
  const found: Diagnostic[] = []
  type Declared = {
    attributes: readonly (string | { name: string })[]
  }[]
  for (const object of objects) {
    const def = KIND_REGISTRY[object.kind]
    if (def.compositeIndexes !== true) continue
    const data = object.data as {
      attributes?: { name: string }[]
      indexes?: Declared
      tabularSections?: {
        name: string
        attributes: { name: string }[]
        indexes?: Declared
      }[]
    }
    const report = (
      declared: Declared | undefined,
      known: ReadonlyMap<string, string>,
      prefix: string,
      section?: string
    ) => {
      ;(declared ?? []).forEach((index, i) => {
        const seen = new Set<string>()
        index.attributes.forEach((part, j) => {
          const name = typeof part === "string" ? part : part.name
          const pointer = `${prefix}/indexes/${i}/attributes/${j}`
          const params = {
            kind: object.kind,
            object: object.name,
            name,
            ...(section === undefined ? {} : { section }),
          }
          const canonical = known.get(name)
          if (canonical === undefined) {
            found.push(
              diagnostic(
                "index.attribute-unknown",
                object.file,
                pointer,
                params
              )
            )
          } else if (seen.has(canonical)) {
            found.push(
              diagnostic(
                "index.attribute-duplicate",
                object.file,
                pointer,
                params
              )
            )
          }
          seen.add(canonical ?? name)
        })
      })
    }
    // Стандартний реквізит — під канонічним ім'ям (обидва стилі ведуть до
    // однієї колонки), власний — під своїм.
    const known = (
      columns: readonly StandardColumnDef[],
      attributes: readonly { name: string }[] | undefined
    ) =>
      new Map([
        ...standardOverrideNames(columns, style),
        ...(attributes ?? []).map(
          (attribute) => [attribute.name, attribute.name] as const
        ),
      ])
    report(
      data.indexes,
      known(def.standardColumns(object.data), data.attributes),
      ""
    )
    if (def.tabularSectionColumns !== undefined) {
      const rowColumns = def.tabularSectionColumns(object.data)
      ;(data.tabularSections ?? []).forEach((section, index) => {
        report(
          section.indexes,
          known(rowColumns, section.attributes),
          `/tabularSections/${index}`,
          section.name
        )
      })
    }
  }
  return found
}

function byteLength(name: string): number {
  return new TextEncoder().encode(name).length
}

/**
 * Опис прийнятої таблиці: генерована колонка без `DEFAULT` та identity,
 * кількість колонок FK і явні імена там, де Postgres назвав би обмеження за
 * деревом виразу. Імена колонок резолвила стадія 2
 * (`customTable.column-unknown`); сумісність типів і наявність ключа цілі FK
 * перевіряє тінь, а не компілятор. Виняток — відкладений ключ цілі
 * (`customTable.foreign-key-deferrable-target`): він видний з опису цілі.
 */
function checkDeclaredTable(
  object: ParsedObject,
  byKey: ReadonlyMap<string, ParsedObject>
): Diagnostic[] {
  const table = object.data as CustomTable
  const found: Diagnostic[] = []
  const nameRequired = (pointer: string) =>
    found.push(
      diagnostic("physical.constraint-name-required", object.file, pointer)
    )

  // Файл описує фізику дослівно (спека §4): колонку ключа чи identity Postgres
  // робить NOT NULL сам, тож без явного `notNull` знімок розійшовся б із
  // каталогом. Не виводимо — вимагаємо від автора.
  const keyColumns = new Set(table.primaryKey?.columns ?? [])
  table.columns.forEach((column, i) => {
    if (column.notNull) return
    const role = keyColumns.has(column.name)
      ? "primary key"
      : column.identity !== undefined
        ? "identity"
        : undefined
    if (role === undefined) return
    found.push(
      diagnostic(
        "customTable.key-column-nullable",
        object.file,
        `/columns/${i}`,
        { column: column.name, role }
      )
    )
  })
  // Значення генерованої колонки дає вираз: Postgres відкидає поруч із ним
  // DEFAULT та identity, тож ловимо це тут, а не падінням DDL.
  table.columns.forEach((column, i) => {
    if (column.generated === undefined) return
    for (const field of ["default", "identity"] as const) {
      if (column[field] !== undefined) {
        found.push(
          diagnostic(
            "customTable.generated-conflict",
            object.file,
            `/columns/${i}/generated`,
            { field }
          )
        )
      }
    }
  })
  // Ім'я безіменного CHECK Postgres бере з першої колонки дерева виразу.
  table.checks.forEach((check, i) => {
    if (check.name === undefined) nameRequired(`/checks/${i}`)
  })
  table.foreignKeys.forEach((foreignKey, i) => {
    const { references } = foreignKey
    const referenced =
      "object" in references ? references.columns : references.external.columns
    if (referenced.length !== foreignKey.columns.length) {
      found.push(
        diagnostic(
          "customTable.foreign-key-arity",
          object.file,
          `/foreignKeys/${i}`,
          {
            local: foreignKey.columns.length,
            referenced: referenced.length,
          }
        )
      )
    }
    // Зовнішню таблицю компілятор не бачить — її ключі перевіряє тінь.
    if ("object" in references) {
      const target = byKey.get(
        objectKey(references.object.kind, references.object.name)
      )
      if (
        target !== undefined &&
        isDeclaredTable(target) &&
        onlyDeferrableKey(target.data as CustomTable, references.columns)
      ) {
        found.push(
          diagnostic(
            "customTable.foreign-key-deferrable-target",
            object.file,
            `/foreignKeys/${i}/references/columns`,
            { kind: target.kind, name: target.name }
          )
        )
      }
    }
  })
  table.indexes.forEach((index, i) => {
    // Колонку-вираз Postgres називає за деревом виразу (FigureIndexColname).
    if (
      index.name === undefined &&
      index.keys.some((key) => "expression" in key)
    ) {
      nameRequired(`/indexes/${i}`)
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
  // Скоуп-колонку резолвила стадія 2: id з індексу, а не другий пошук за
  // іменем, тож перейменування колонки має одну точку правди. Невідома
  // колонка запису не має — її вже звітувала стадія 2.
  const scopeColumnOf = new Map(
    references
      .filter((r) => r.role === "customTable.scopeColumn")
      .map((r) => [r.from.objectId, r.to.id])
  )
  // `scopeColumn` без скоупу — хибна ознака й в однотенантному проєкті, тож це
  // єдина перевірка, що не залежить від видів скоупу.
  for (const object of objects) {
    if (!isDeclaredTable(object)) continue
    const { scope, scopeColumn } = object.data as CustomTable
    const unscoped = scope === undefined || scope === NO_SCOPE
    if (
      unscoped &&
      scopeColumn !== undefined &&
      scopeColumnOf.has(object.id ?? "")
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
    const columnId = scopeColumnOf.get(object.id ?? "")
    const column = table.columns.find((c) => c.id === columnId)
    // Невідому колонку вже звітувала стадія 2.
    if (columnId === undefined || column === undefined) continue
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
      // Не-документ уже отримав register.recorder-kind; скоуп йому — зайвий шум.
      if (!postsMovements(target.kind)) continue
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

const UNKNOWN: InferredType = { kind: "unknown" }

/** Поля регістра за роллю — у порядку `columnFields` реєстру видів. */
type RegisterFieldRole = "dimensions" | "resources" | "attributes"

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
  // Резолвлене ім'я виразу — за полем і початком токена імені: так стадія 2
  // уже зв'язала вузол AST з елементом, і повторно резолвити імена не треба.
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
    return typeOfLogical(
      field.type,
      targets as string[],
      field.array === true,
      field.allowedTypes !== undefined
    )
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
      // Не регістр чи незалежний регістр уже звітовано за ціллю посилання.
      if (
        register === undefined ||
        registerTargetError(register) !== undefined
      ) {
        return
      }
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
        standardElementId(ownerId, column),
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
          standardElementId(section.id, column),
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
      // Непридатну ціль уже звітовано; перевірки полів над нею — лише шум.
      if (
        register === undefined ||
        registerTargetError(register) !== undefined
      ) {
        return
      }
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
        walkExpr(parsed.expr, (node) => {
          const code =
            fromDocument && node.type === "field" && node.base === "row"
              ? "posting.row-in-document-source"
              : !fromDocument && (node.type === "sum" || node.type === "count")
                ? "posting.aggregate-in-section-source"
                : undefined
          if (code === undefined) return
          valid = false
          found.push(
            diagnostic(code, object.file, pointer, { offset: node.start })
          )
        })
        return valid ? parsed.expr : undefined
      }
      const typeAt = (expr: Expr, pointer: string): InferredType => {
        const ctx: PostingContext = {
          typeOf: (node) => {
            const id = resolved.get(
              spanKey(object.file, pointer, node.fieldSpan.start)
            )
            return id === undefined
              ? UNKNOWN
              : (elementTypes.get(id) ?? UNKNOWN)
          },
        }
        const errors: OperandError[] = []
        const type = inferType(expr, ctx, errors)
        // Операнд звітує сам; тип цілого тоді `unknown`, тож поле мовчить.
        for (const error of errors) {
          found.push(
            diagnostic("posting.type-mismatch", object.file, pointer, {
              expected: error.expected,
              actual: describeType(error.actual),
              offset: error.node.start,
            })
          )
        }
        return type
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
      // Період — стандартна колонка регістра: без неї (неперіодичний регістр
      // відомостей) значенню періоду нема куди лягти.
      const hasPeriod = registerDef
        .standardColumns(register.data)
        .some((column) => column.logicalName === "period")
      if (movement.period !== undefined && !hasPeriod) {
        found.push(
          diagnostic("posting.period-not-allowed", object.file, at("period"), {
            register: register.name,
          })
        )
      } else {
        expectKind(movement.period, at("period"), { kind: "date" })
      }

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
        // Рядковий літерал відомий статично: лише два значення стають видом руху.
        if (expr?.type === "string") {
          if (expr.value !== "Receipt" && expr.value !== "Expense") {
            found.push(
              diagnostic("posting.movement-type", object.file, pointer, {
                problem: "value",
                value: expr.value,
                offset: expr.start,
              })
            )
          }
        } else if (
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
      // Порядок оголошення — виміри, ресурси, реквізити: так і `missing`.
      const required = [
        ...fields.dimensions.filter((dimension) => dimension.required),
        ...fields.resources.filter(
          (resource) => keys.additiveResources || resource.required
        ),
        ...fields.attributes.filter((attribute) => attribute.required),
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
        // адитивний ресурс і не `required`; необов'язковий вимір може бути
        // `NULL` (ключ запису зіставляє порожні значення).
        const nullable =
          !(role === "resources" && keys.additiveResources) && !field.required
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

/**
 * Явні імена індексів, первинних ключів і UNIQUE займають `pg_class` схеми
 * поряд із таблицями (спека §8.3): збіг з таблицею чи з іншим явним іменем
 * інакше впав би на DDL («relation already exists»). Таблиці займають імена
 * першими — `physicalName` після створення не змінюється, тож помилку
 * отримує явне ім'я, далі — за файлом і порядком у файлі. Збіг двох таблиць
 * звітує `physical.table-duplicate`; похідні імена зайнятих не беруть
 * (`assignNames`).
 */
function relationNameCollisions(model: ModelStageResult): Diagnostic[] {
  const tables = new Set(
    model.physical.tables.map((t) => `${t.schema}.${t.name}`)
  )
  const taken = new Map<string, { file: string; other: string }>()
  for (const source of model.sources) {
    const key = `${source.schema}.${source.name}`
    if (tables.has(key) && !taken.has(key)) {
      taken.set(key, { file: source.file, other: "a table" })
    }
  }
  const diagnostics: Diagnostic[] = []
  for (const source of model.sources) {
    for (const { name, pointer, relation } of source.explicitNames) {
      if (!relation) continue
      const key = `${source.schema}.${name}`
      const first = taken.get(key)
      if (first === undefined) {
        taken.set(key, { file: source.file, other: "an index or key" })
        continue
      }
      diagnostics.push(
        diagnostic("physical.relation-duplicate", source.file, pointer, {
          name: key,
          other: first.other,
          firstFile: first.file,
        })
      )
    }
  }
  return diagnostics
}

/**
 * Похідні функції (контракти й обгортки) не збігаються між собою (спека §7),
 * а функції контрактів — ще й з іменами `pg_proc` дослівних `.sql`: інакше
 * `CREATE` П3 упаде чи мовчки перепише чуже. Порівнюється ім'я без
 * сигнатури: функції платформи RPC кличе за іменем, тож перевантаження їхніх
 * імен заборонені. Таблиць перевірка не торкається: `pg_proc` і `pg_class` —
 * різні простори, а PostgREST розводить `/table` і `/rpc/fn`. Обгортку з
 * дослівними одиницями звіряє за сигнатурою перевірка просторів імен
 * Postgres (`namespaceConflicts`). Першою вважається функція, раніша за
 * файлом і шляхом.
 */
function functionCollisions(
  functions: readonly DerivedFunction[],
  sqlUnits: readonly VerbatimUnit[]
): Diagnostic[] {
  const unitFiles = new Map<string, string>()
  for (const unit of sqlUnits) {
    for (const name of pgNamespaceKeys({ type: "unit", unit })) {
      const key = `${name.schema}.${name.name}`
      if (name.space === "proc" && !unitFiles.has(key)) {
        unitFiles.set(key, unit.file)
      }
    }
  }
  const seen = new Map<string, DerivedFunction>()
  const diagnostics: Diagnostic[] = []
  const ordered = [...functions].sort(
    (a, b) =>
      compareStrings(a.file, b.file) || compareStrings(a.pointer, b.pointer)
  )
  for (const fn of ordered) {
    const key = `${fn.schema}.${fn.name}`
    const first = seen.get(key)
    const unitFile = fn.movementQuery === true ? undefined : unitFiles.get(key)
    const other =
      first !== undefined
        ? `function of ${first.description}`
        : unitFile !== undefined
          ? `a function in ${unitFile}`
          : undefined
    if (first === undefined) seen.set(key, fn)
    if (other === undefined) continue
    diagnostics.push(
      diagnostic("physical.function-duplicate", fn.file, fn.pointer, {
        schema: fn.schema,
        name: fn.name,
        description: fn.description,
        other,
      })
    )
  }
  return diagnostics
}
