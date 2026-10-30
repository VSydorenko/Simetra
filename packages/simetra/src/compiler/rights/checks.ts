import {
  authorColumns,
  KIND_REGISTRY,
  isUuidColumn,
  singleUuidKeyColumn,
  standardLogicalName,
  toSnakeCase,
  type CarrierCopyOf,
  type CustomAction,
  type AssignmentSource,
  type CustomTable,
  type PhysicalColumn,
  type PhysicalTable,
  type Project,
  type RightsSystemCatalog,
  type ScopeKind,
  type SourceCondition,
} from "simetra/model"
import { mainTableOf } from "../contracts"
import { diagnostic, type Diagnostic } from "../diagnostics"
import { PROJECT_FILE, type ParsedObject } from "../stages/files"
import { standardElementId, type ResolvedReference } from "../stages/identity"
import {
  hasScopeKeyUnique,
  usersCatalogOf,
  type ModelStageResult,
} from "../stages/model"
import {
  carrierTarget,
  crossTenant,
  elementField,
  resolveCarrier,
  type CarrierContext,
} from "./carriers"
import {
  accessCarrier,
  accessDimensionId,
  accessOf,
  bindingOf,
  carrierContext,
  carrierDeclarations,
  customActionEffects,
  customActionsOf,
  headerReference,
  isMembershipCatalog,
  isRightsContainer,
  isRightsDeclaration,
  isUsers,
  ownershipOf,
  scopeKindOf,
  sourceLiteralFits,
  sourceLiteralType,
} from "./facts"
import { commandWriteColumns } from "./command-columns"
import { must, projectTarget } from "./references"

/** Вхід правил прав стадії 4: усе, що вже знає цілісність. */
export interface RightsCheckContext {
  objects: readonly ParsedObject[]
  references: readonly ResolvedReference[]
  model: ModelStageResult
  scopeKinds: readonly ScopeKind[]
  project: Project
  byId: ReadonlyMap<string, ParsedObject>
}

/**
 * Правила прав стадії 4 (спека прав §3): кастомні дії не повторюють
 * стандартних, вимоги називають відомі дії й не замикаються в цикл, а
 * колонки ефектів — власні колонки об'єкта. Контракт будується лише після
 * них, тож замикання вимог там не зустріне циклу. Ефекти кастомної дії —
 * лише на виді, стандартні дії якого пишуть, і ТЧ — лише на виді з ТЧ.
 */
export function checkRights(ctx: RightsCheckContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const carriers = carrierContext({ ...ctx, physical: ctx.model.physical })
  for (const object of ctx.objects) {
    const def = KIND_REGISTRY[object.kind]
    if (def.rightsExtents.length === 0) continue
    const standard = new Set<string>(
      def.actions(object.data).map((a) => a.name)
    )
    const actions = customActionsOf(object)
    const custom = new Set(actions.map((a) => a.name))
    // Колонки переходів — з `transition` стандартних дій виду (Р2b1-18).
    const transitionIds = new Set(
      def.actions(object.data).flatMap((a) =>
        a.transition === undefined
          ? []
          : [
              standardElementId(must(object.id), {
                logicalName: a.transition.column,
              }),
            ]
      )
    )
    // Незмінні для шапки колонки. Вид з `commandWrites` (довідник) — усе поза
    // колонками зміни ролі команд (спека П4 §6.2): джерело те саме, що для
    // гранту, тож шапка не обіцяє того, чого роль не змінить. Решта видів —
    // ключ `ref` і авторство (Р2b1-9, Р2b1-20, Р-A1-9): колонку скоупу шапка
    // назвати не може, бо у кореня виду скоупу вона і є `ref`, а власну
    // колонку скоупу платформа додає без імені елемента
    // (`rights.attribute-unknown`).
    const immutableIds = def.commandWrites
      ? outsideCommandUpdate(object, ctx)
      : new Set(
          [{ logicalName: "ref" }, ...authorColumns()].map((column) =>
            standardElementId(must(object.id), column)
          )
        )
    // Вид, жодна стандартна дія якого не пише (регістр накопичення,
    // підлеглий регістр відомостей), пишуть лише рухи проведення (§5.3):
    // ефект кастомної дії там відкрив би запис в обхід оболонки.
    const writes = def
      .actions(object.data)
      .some((a) => a.effects.dml.length > 0)
    actions.forEach((action, index) => {
      const at = `/customActions/${index}`
      if (standard.has(action.name)) {
        diagnostics.push(
          diagnostic(
            "rights.custom-action-reserved",
            object.file,
            `${at}/name`,
            {
              action: action.name,
              kind: object.kind,
            }
          )
        )
      }
      action.requires.forEach((name, i) => {
        if (standard.has(name) || custom.has(name)) return
        diagnostics.push(
          diagnostic(
            "rights.action-unknown",
            object.file,
            `${at}/requires/${i}`,
            { action: name, object: object.name }
          )
        )
      })
      diagnostics.push(...unknownHeader(object, action, index, ctx.references))
      diagnostics.push(
        ...forbiddenHeader(
          object,
          action,
          index,
          { transitionIds, immutableIds },
          ctx.references
        )
      )
      const effects = customActionEffects(action)
      if (!writes && effects.dml.length > 0) {
        diagnostics.push(
          diagnostic(
            "rights.custom-action-effects",
            object.file,
            `${at}/effects`,
            {
              action: action.name,
              reason: "noWrite",
            }
          )
        )
      } else if (
        effects.tabularSections &&
        def.tabularSectionColumns === undefined
      ) {
        diagnostics.push(
          diagnostic(
            "rights.custom-action-effects",
            object.file,
            `${at}/effects/tabularSections`,
            { action: action.name, reason: "noTabularSections" }
          )
        )
      }
    })
    diagnostics.push(...requiresCycles(object, actions, standard))
    if (def.rightsExtents.includes("own")) {
      diagnostics.push(...checkOwnership(object, ctx, carriers))
    }
    if (def.rightsBinding) {
      diagnostics.push(...checkBinding(object, carriers))
    }
    if (def.rightsExtents.includes("dimension")) {
      diagnostics.push(...checkAccess(object, ctx, carriers))
    }
    diagnostics.push(...checkCarrierCopies(object, carriers))
  }
  diagnostics.push(...checkDimensions(ctx, carriers))
  diagnostics.push(...checkSources(ctx))
  diagnostics.push(...checkUsers(ctx))
  diagnostics.push(...checkPublicRead(ctx))
  return diagnostics
}

/**
 * `publicRead` заборонено на довідниках, рядки яких — люди чи їхні права
 * (Р2a2-33): він знімає межу тенанта (Р2a2-3) і відкриває всі рядки гостю й
 * кожному користувачу, тож гість бачив би більше за учасника — межа
 * видимості «Користувачів» (спека системної схеми §12) і членства з
 * призначеннями зникли б. Публічні профілі — окремий довідник з посиланням
 * на «Користувачі».
 */
function checkPublicRead(ctx: RightsCheckContext): Diagnostic[] {
  return ctx.objects.flatMap((object) => {
    if ((object.data as { publicRead?: unknown }).publicRead === undefined) {
      return []
    }
    const holds = peopleRowsOf(object)
    return holds === undefined
      ? []
      : [
          diagnostic(
            "rights.public-read-forbidden",
            object.file,
            "/publicRead",
            {
              object: object.name,
              holds,
            }
          ),
        ]
  })
}

/**
 * Що з людей чи їхніх прав тримають рядки об'єкта; `undefined` — нічого.
 * Роль системного довідника прав — з хука реєстру (Р2a1-23).
 */
function peopleRowsOf(
  object: ParsedObject
): "users" | "membership" | RightsSystemCatalog | undefined {
  if (isUsers(object)) return "users"
  if (isMembershipCatalog(object)) return "membership"
  return KIND_REGISTRY[object.kind].rightsSystem?.(object.data)
}

/**
 * Правило цілі власності (спека прав §4.2, Р1a-11): кінцевий `Ref` носія —
 * на довідник членства того самого виду скоупу, що й об'єкт, і в межах
 * скоупу (інакше власник з чужого тенанта відкрив би рядок), або на
 * «Користувачі» — там простий FK, бо предикат власності йде AND зі скоупами.
 * Ключ (`ref`) — власник лише рядка самих «Користувачів».
 */
function checkOwnership(
  object: ParsedObject,
  ctx: RightsCheckContext,
  carriers: CarrierContext
): Diagnostic[] {
  const scopeOf = (o: ParsedObject) => scopeKindOf(o, ctx.references)
  return ownershipOf(object).flatMap((carrier, index) => {
    const pointer = `/ownership/${index}`
    const resolved = resolveCarrier(
      object,
      carrier,
      { pointer, field: "ownership" },
      carriers
    )
    if (!resolved.ok) return [resolved.diagnostic]
    const at = typeof carrier === "string" ? pointer : `${pointer}/1`
    const { object: holder, field } = resolved.terminal
    const target = (reason: "key" | "target") => [
      diagnostic("rights.ownership-target", object.file, at, {
        attribute: field.name,
        reason,
      }),
    ]
    if (field.key) return isUsers(holder) ? [] : target("key")
    const owner = field.target!
    if (isUsers(owner)) return []
    // Прийнята таблиця — джерело членства виду об'єкта — стоїть на місці
    // довідника членства (Р1a-24): учасник — її рядок, а складений FK
    // (`UNIQUE (scope, id)`, §4.5) тримає його в межах тенанта.
    const scopeKindId = scopeOf(object)
    const catalog = isMembershipCatalog(owner) && scopeOf(owner) === scopeKindId
    const source =
      scopeKindId !== undefined &&
      membershipSourceTables(scopeKindId, ctx).includes(must(owner.id))
    if (!catalog && !source) return target("target")
    return field.inScope
      ? []
      : [crossTenant(object, at, field.name, ctx.references)]
  })
}

/**
 * Правило прив'язки до контейнера (спека прав §4.3, Р1a-10): кінцева ціль
 * носія — об'єкт із `rightsContainer`, не сам об'єкт, і в межах скоупу
 * (інакше чужий контейнер відкрив би рядок).
 */
function checkBinding(
  object: ParsedObject,
  carriers: CarrierContext
): Diagnostic[] {
  const carrier = bindingOf(object)
  if (carrier === undefined) return []
  const pointer = "/containerBinding"
  const resolved = resolveCarrier(
    object,
    carrier,
    { pointer, field: "containerBinding" },
    carriers
  )
  if (!resolved.ok) return [resolved.diagnostic]
  const at = typeof carrier === "string" ? pointer : `${pointer}/1`
  const { field } = resolved.terminal
  const target = carrierTarget(resolved.terminal)
  // Спершу — чи ціль контейнер: не-контейнер, прив'язаний сам до себе,
  // помиляється ціллю, а не самоприв'язкою контейнера.
  if (!isRightsContainer(target)) {
    return [
      diagnostic("rights.container-target", object.file, at, {
        attribute: field.name,
        name: target.name,
      }),
    ]
  }
  if (target === object) {
    return [
      diagnostic("rights.container-self", object.file, at, {
        attribute: field.name,
        name: object.name,
      }),
    ]
  }
  return field.inScope
    ? []
    : [crossTenant(object, at, field.name, carriers.references)]
}

/**
 * Правила виміру доступу (спека прав §4.4, Р1a-13): довідник значень — вид,
 * що може ним бути, і скоуплений, коли в проєкті є види скоупу (інакше
 * значення одного тенанта відкривали б рядки іншого). Зв'язок — у тому самому
 * виді скоупу, що й довідник; `subject` — одиночний `Ref` на «Користувачі» чи
 * на довідник членства того самого виду, `value` — одиночний `Ref` на
 * довідник значень. Функцію значень перевіряє стадія 5.
 */
function checkDimensions(
  ctx: RightsCheckContext,
  carriers: CarrierContext
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const scopeOf = (o: ParsedObject) => scopeKindOf(o, ctx.references)
  ctx.project.accessDimensions.forEach((dimension, index) => {
    const at = `/accessDimensions/${index}`
    // Політика прав читання виміру — `<t>_read_<вимір snake_case>` (Р2a2-14):
    // такі імена збіглися б з політиками форм обсягу `any`, `own` і
    // `in_<контейнер>`.
    const snake = toSnakeCase(dimension.name)
    if (
      snake === "any" ||
      snake === "own" ||
      snake.startsWith("own_") ||
      snake.startsWith("in_")
    ) {
      diagnostics.push(
        diagnostic(
          "rights.dimension-name-reserved",
          PROJECT_FILE,
          `${at}/name`,
          {
            name: dimension.name,
          }
        )
      )
    }
    const targetId = projectTarget(`${at}/target`, "dimension.target", ctx)
    const target = targetId === undefined ? undefined : ctx.byId.get(targetId)
    // Невідому ціль уже звітувала стадія 2 (`reference.unresolved`).
    if (target === undefined) return
    const reason = !KIND_REGISTRY[target.kind].accessDimensionTarget
      ? "kind"
      : ctx.scopeKinds.length > 0 && scopeOf(target) === undefined
        ? "unscoped"
        : undefined
    if (reason !== undefined) {
      diagnostics.push(
        diagnostic("rights.dimension-target", PROJECT_FILE, `${at}/target`, {
          dimension: dimension.name,
          reason,
        })
      )
    }
    if (!("relation" in dimension.values)) return
    const { relation } = dimension.values
    const relationAt = `${at}/values/relation`
    const broken = (
      field: "object" | "subject" | "value",
      why: "table" | "scope" | "unknown" | "target",
      // Ім'я, якого немає в об'єкті зв'язку, — лише для `unknown`.
      name?: string
    ) =>
      diagnostics.push(
        diagnostic(
          "rights.dimension-relation",
          PROJECT_FILE,
          `${relationAt}/${field}`,
          {
            dimension: dimension.name,
            field,
            reason: why,
            ...(name === undefined ? {} : { name }),
          }
        )
      )
    const objectId = projectTarget(
      `${relationAt}/object`,
      "dimension.relationObject",
      ctx
    )
    const object = objectId === undefined ? undefined : ctx.byId.get(objectId)
    if (object === undefined) return
    if (KIND_REGISTRY[object.kind].materializes !== "table") {
      broken("object", "table")
      return
    }
    if (scopeOf(object) !== scopeOf(target)) broken("object", "scope")
    // Ціль одиночного `Ref` поля зв'язку; `null` — поля немає в об'єкта.
    const targetOf = (field: "subject" | "value") => {
      const id = projectTarget(
        `${relationAt}/${field}`,
        "dimension.relationField",
        ctx
      )
      if (id === undefined) return null
      return elementField(object, id, relation[field], carriers)?.target
    }
    const subject = targetOf("subject")
    const member = (o: ParsedObject) =>
      isMembershipCatalog(o) && scopeOf(o) === scopeOf(target)
    if (subject === null) broken("subject", "unknown", relation.subject)
    else if (subject === undefined || !(isUsers(subject) || member(subject))) {
      broken("subject", "target")
    }
    const value = targetOf("value")
    if (value === null) broken("value", "unknown", relation.value)
    else if (value !== target) broken("value", "target")
  })
  return diagnostics
}

/**
 * Правило мапінгу `access` (спека прав §4.4): вимір відомий і названий раз,
 * кінцевий `Ref` носія — на довідник значень виміру й у межах скоупу
 * (інакше значення з чужого тенанта відкрили б рядок).
 */
function checkAccess(
  object: ParsedObject,
  ctx: RightsCheckContext,
  carriers: CarrierContext
): Diagnostic[] {
  const seen = new Set<string>()
  return accessOf(object).flatMap((mapping, index) => {
    const dimensionAt = `/access/${index}/dimension`
    const params = { dimension: mapping.dimension }
    const dimensionId = accessDimensionId(object, index, ctx.references)
    if (dimensionId === undefined) {
      return [
        diagnostic(
          "rights.dimension-unknown",
          object.file,
          dimensionAt,
          params
        ),
      ]
    }
    if (seen.has(dimensionId)) {
      return [
        diagnostic("rights.access-duplicate", object.file, dimensionAt, params),
      ]
    }
    seen.add(dimensionId)
    const { carrier, pointer } = accessCarrier(mapping, index)
    // Регістр читають за вимірами і в рухах, і в підсумках (§5.2, Р2a2-4):
    // похідні таблиці несуть лише виміри, а копій носіїв у регістра немає.
    if (
      KIND_REGISTRY[object.kind].registerKeys !== undefined &&
      !(typeof carrier === "string" && registerDimensions(object).has(carrier))
    ) {
      return [
        diagnostic("rights.register-access-dimension", object.file, pointer, {
          attribute: typeof carrier === "string" ? carrier : carrier.join("."),
        }),
      ]
    }
    const resolved = resolveCarrier(
      object,
      carrier,
      { pointer, field: "access", role: "access.attribute" },
      carriers
    )
    if (!resolved.ok) return [resolved.diagnostic]
    const at = typeof carrier === "string" ? pointer : `${pointer}/1`
    const { field } = resolved.terminal
    const dimensionIndex = ctx.project.accessDimensions.findIndex(
      (d) => d.id === dimensionId
    )
    const targetId = projectTarget(
      `/accessDimensions/${dimensionIndex}/target`,
      "dimension.target",
      ctx
    )
    if (
      targetId !== undefined &&
      carrierTarget(resolved.terminal).id !== targetId
    ) {
      return [
        diagnostic("rights.access-target", object.file, at, {
          attribute: field.name,
          dimension: mapping.dimension,
        }),
      ]
    }
    return field.inScope
      ? []
      : [crossTenant(object, at, field.name, ctx.references)]
  })
}

/**
 * Копії носіїв (Р2a2-5): ім'я копії в основній таблиці (шлях) і в кожній ТЧ
 * (кожен носій, крім ключа) мусить бути копією з тим самим джерелом. Інакше
 * ім'я зайняте колонкою опису, і стадія 3 копії не поклала — права читали б
 * чуже значення.
 */
function checkCarrierCopies(
  object: ParsedObject,
  carriers: CarrierContext
): Diagnostic[] {
  if (KIND_REGISTRY[object.kind].registerKeys !== undefined) return []
  const objectId = must(object.id)
  const main = must(mainTableOf(carriers.physical, objectId))
  const owner = { schema: main.schema, name: main.name }
  const sections = carriers.physical.tables.filter(
    (t) =>
      t.origin.objectId === objectId && t.origin.tabularSectionId !== undefined
  )
  const diagnostics: Diagnostic[] = []
  const reported = new Set<string>()
  for (const { carrier, pointer, field, role } of carrierDeclarations(object)) {
    const resolved = resolveCarrier(
      object,
      carrier,
      { pointer, field, role },
      carriers
    )
    if (!resolved.ok) continue
    const { contract } = resolved
    const expected: [PhysicalTable, Omit<CarrierCopyOf, "through">][] = []
    if (contract.via !== undefined) {
      expected.push([
        main,
        { table: contract.via.table, column: contract.via.column },
      ])
    }
    // Носій-ключ копії не має: його значення в ТЧ — сам `parent_id`.
    if (contract.via !== undefined || !resolved.terminal.field.key) {
      for (const table of sections) {
        expected.push([table, { table: owner, column: contract.value }])
      }
    }
    for (const [table, source] of expected) {
      const copyOf = table.columns.find((c) => c.name === contract.value)
        ?.origin.copyOf
      if (
        copyOf !== undefined &&
        copyOf.table.schema === source.table.schema &&
        copyOf.table.name === source.table.name &&
        copyOf.column === source.column
      ) {
        continue
      }
      const key = `${table.schema}.${table.name}.${contract.value}`
      if (reported.has(key)) continue
      reported.add(key)
      diagnostics.push(
        diagnostic("rights.carrier-column-taken", object.file, pointer, {
          table: table.name,
          column: contract.value,
        })
      )
    }
  }
  return diagnostics
}

/** Логічні імена вимірів регістра. */
function registerDimensions(object: ParsedObject): Set<string> {
  const { dimensions } = object.data as { dimensions?: { name: string }[] }
  return new Set((dimensions ?? []).map((d) => d.name))
}

/** Тип змапованої колонки джерела, якого чекають функції прав (Р2d1-2a). */
type SourceColumnType = "UUID" | "Boolean" | "Text"

const SOURCE_COLUMN_TYPES: Record<
  SourceColumnType,
  (column: CustomTable["columns"][number]) => boolean
> = {
  // Та сама перевірка uuid, що й для ключа учасника: `Raw` з `pgType` uuid —
  // теж uuid.
  UUID: isUuidColumn,
  Boolean: (column) => column.array !== true && column.type === "Boolean",
  Text: (column) =>
    column.array !== true &&
    (column.type === "Text" || column.type === "String"),
}

/**
 * Правила прийнятих джерел (спека прав §4.7): таблиця — прийнята
 * (`CustomTable`) і без `FORCE ROW LEVEL SECURITY`, бо функції прав
 * `SECURITY DEFINER` інакше проходили б її політики; вид скоупу відомий і має
 * одне членство — довідник чи джерело (Р1a-17); рівень контейнера — об'єкт із
 * `rightsContainer`, а колонка контейнера є саме на контейнерному рівні.
 * Учасник джерела членства — одноколонковий uuid-ключ таблиці (Р2d1-2), а
 * змаповані колонки мають типи, з якими працюють функції прав (Р2d1-2a):
 * інакше невідповідність виявилася б лише на застосуванні.
 */
function checkSources(ctx: RightsCheckContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const report = (
    code: Parameters<typeof diagnostic>[0],
    pointer: string,
    params: Record<string, string>
  ) => diagnostics.push(diagnostic(code, PROJECT_FILE, pointer, params))
  const known = new Set(ctx.scopeKinds.map((k) => k.name))
  // Прийнята таблиця джерела; `undefined` — ціль невідома (стадія 2) чи не
  // прийнята таблиця (звітовано тут).
  // Той самий шлях — для таблиці-джерела й таблиці ролей джерела призначень
  // (Р2d1-17): обидві читають функції прав `SECURITY DEFINER`.
  const table = (
    source: { name: string },
    pointer: string,
    role: "source.table" | "source.roleTable" = "source.table"
  ): ParsedObject | undefined => {
    const id = projectTarget(pointer, role, ctx)
    const target = id === undefined ? undefined : ctx.byId.get(id)
    // Невідому ціль уже звітувала стадія 2 (`reference.unresolved`).
    if (target === undefined) return
    if (!KIND_REGISTRY[target.kind].declared) {
      report("rights.source-table", pointer, { source: source.name })
      return
    }
    if (
      (target.data as { rowLevelSecurity?: string }).rowLevelSecurity ===
      "forced"
    ) {
      report("rights.source-forced-rls", pointer, {
        source: source.name,
        table: target.name,
      })
    }
    return target
  }
  // Членство виду рахується наростаючим підсумком: перше джерело виду без
  // довідника законне, кожне наступне — дубль.
  const counted = new Set<string>()
  // Скоуп джерела членства — скоуп самої таблиці (Р1a-24): складений FK
  // власника тримає рівність колонки `scopeColumn` таблиці, тож значення
  // скоупу членства мусить читатися саме з неї. Інакше FK тримав би один
  // тенант, а членство — інший.
  const checkSourceScope = (
    source: string,
    at: string,
    target: ParsedObject
  ) => {
    const kindId = projectTarget(`${at}/scopeKind`, "source.scopeKind", ctx)
    // Невідомий вид уже звітовано вище.
    if (kindId === undefined) return
    if (scopeKindOf(target, ctx.references) !== kindId) {
      report("rights.source-scope-column", `${at}/table`, {
        source,
        reason: "scope",
      })
      return
    }
    const column = projectTarget(`${at}/columns/scope`, "source.column", ctx)
    // Невідому колонку звітувала стадія 2 (`customTable.column-unknown`).
    if (column === undefined) return
    const scopeColumn = ctx.references.find(
      (r) =>
        r.from.file === target.file &&
        r.from.pointer === "/scopeColumn" &&
        r.role === "customTable.scopeColumn"
    )?.to.id
    if (scopeColumn !== column) {
      report("rights.source-scope-column", `${at}/columns/scope`, {
        source,
        reason: "column",
      })
    }
  }
  // `base` — вказівник об'єкта полів (`…/columns` чи `…/columns/role`), а
  // `target` — таблиця, серед колонок якої поле резолвлено: ключ ролі живе в
  // таблиці ролей, і з таблицею-джерелом тип мовчки не перевірився б.
  const checkColumnTypes = (
    source: string,
    base: string,
    target: ParsedObject,
    expected: Record<string, SourceColumnType>
  ) => {
    const { columns } = target.data as CustomTable
    for (const [field, type] of Object.entries(expected)) {
      const pointer = `${base}/${field}`
      // Незмаповану чи невідому колонку тут не перевіряти: невідому звітувала
      // стадія 2.
      const id = projectTarget(pointer, "source.column", ctx)
      const column = columns.find((c) => c.id === id)
      if (id === undefined || column === undefined) continue
      if (!SOURCE_COLUMN_TYPES[type](column)) {
        report("rights.source-column-type", pointer, {
          source,
          column: column.name,
          expected: type,
        })
      }
    }
  }
  // Учасник — одноколонковий uuid-ключ (Р2d1-2): id учасника — значення
  // носія власності, суб'єкта призначення й `member` джерела призначень, а
  // складений ключ одного значення не має. Суб'єкт системних довідників прав
  // виду посилається на таблицю складеним FK у межах скоупу (Р2d1-5), тож
  // тоді таблиця мусить оголосити `UNIQUE (scope, id)` — Postgres не прийме
  // FK на неунікальну пару.
  const checkMember = (
    source: string,
    at: string,
    target: ParsedObject,
    kindId: string | undefined
  ) => {
    const data = target.data as CustomTable
    if (singleUuidKeyColumn(data) === undefined) {
      report("rights.source-member-key", `${at}/table`, {
        source,
        table: target.name,
      })
      return
    }
    if (
      kindId !== undefined &&
      memberSubjectCatalogs(kindId, ctx) &&
      !hasScopeKeyUnique(data)
    ) {
      report("rights.source-member-unique", `${at}/table`, {
        source,
        table: target.name,
      })
    }
  }
  // Умова рядків (Р2d1-15): рівність порівнює лише колонку тексту, uuid,
  // логічну чи цілу, і літерал — форми її типу; `isNull` — будь-яку колонку.
  // `base` — вказівник власника `where` (джерело чи `columns/role`), `target`
  // — таблиця, над якою умова стоїть.
  const checkWhere = (
    source: string,
    base: string,
    target: ParsedObject,
    where: readonly SourceCondition[]
  ) => {
    const { columns } = target.data as CustomTable
    where.forEach((condition, j) => {
      if (!("equals" in condition)) return
      const pointer = `${base}/where/${j}`
      const id = projectTarget(`${pointer}/column`, "source.column", ctx)
      const column = columns.find((c) => c.id === id)
      // Невідому колонку звітувала стадія 2.
      if (id === undefined || column === undefined) return
      const type = sourceLiteralType(column)
      const reason =
        type === undefined
          ? "type"
          : sourceLiteralFits(type, condition.equals)
            ? undefined
            : "literal"
      if (reason === undefined) return
      report("rights.source-where", pointer, {
        source,
        column: column.name,
        reason,
      })
    })
  }
  // Колонка скоупу рядка джерела призначень (Р2d1-16, Р2d1-19): скоуп
  // призначення рівня скоупу — скоуп учасника, а власна колонка скоупу рядка
  // мусить із ним збігатися (R1: адмін тенанта A вписує учасника B зі скоупом
  // A — без звірки рядок діяв би в B). Скоуп з учасника — лише явним `null`,
  // тож забута колонка — помилка, а не тихе «скоуп з учасника».
  const checkRowScope = (
    source: AssignmentSource,
    at: string,
    target: ParsedObject | undefined
  ) => {
    const level = source.assignedOn
    const { scope } = source.columns
    if (level === "global" || !("scopeKind" in level)) {
      if (scope !== undefined) {
        report("rights.source-scope-column", `${at}/columns/scope`, {
          source: source.name,
          reason: "level",
        })
      }
      return
    }
    if (target === undefined) return
    const kindId = projectTarget(
      `${at}/assignedOn/scopeKind`,
      "source.scopeKind",
      ctx
    )
    const tableKind = scopeKindOf(target, ctx.references)
    // Скоуплена таблиця іншого виду несе чужий скоуп; нескоуплена
    // (поліморфна) — законна, скоуп тоді дає `columns.scope`.
    if (
      kindId !== undefined &&
      tableKind !== undefined &&
      tableKind !== kindId
    ) {
      report("rights.source-scope-column", `${at}/table`, {
        source: source.name,
        reason: "scope",
      })
      return
    }
    const scopeColumn = ctx.references.find(
      (r) =>
        r.from.file === target.file &&
        r.from.pointer === "/scopeColumn" &&
        r.role === "customTable.scopeColumn"
    )?.to.id
    if (scope === undefined) {
      if (scopeColumn === undefined) {
        report("rights.source-scope-column", `${at}/columns`, {
          source: source.name,
          reason: "missing",
        })
      }
      return
    }
    if (scopeColumn === undefined) return
    // `null` на таблиці зі скоуп-колонкою вимкнув би звірку саме там, де
    // таблиця скоуп несе.
    const column =
      scope === null
        ? undefined
        : projectTarget(`${at}/columns/scope`, "source.column", ctx)
    // Невідому колонку звітувала стадія 2.
    if (scope !== null && column === undefined) return
    if (column !== scopeColumn) {
      report("rights.source-scope-column", `${at}/columns/scope`, {
        source: source.name,
        reason: "column",
      })
    }
  }
  // Таблиця ролей (Р2d1-17): прийнята, без `FORCE`, з одноколонковим
  // uuid-ключем; ключ — текст. Без `where` ролі ключ мусить бути унікальним
  // сам (R2): інакше кастомна роль тенанта з ключем системної ролі вмикала б
  // системну роль.
  const checkRoleTable = (
    source: string,
    at: string,
    role: Exclude<AssignmentSource["columns"]["role"], string>
  ) => {
    const base = `${at}/columns/role`
    const target = table(
      { name: source },
      `${base}/references`,
      "source.roleTable"
    )
    if (target === undefined) return
    const data = target.data as CustomTable
    if (singleUuidKeyColumn(data) === undefined) {
      report("rights.source-role-key", `${base}/references`, {
        source,
        table: target.name,
        reason: "primaryKey",
      })
    }
    checkColumnTypes(source, base, target, { key: "Text" })
    checkWhere(source, base, target, role.where)
    if (role.where.length === 0 && !uniqueKey(data, role.key)) {
      report("rights.source-role-key", base, {
        source,
        table: target.name,
        reason: "ambiguous",
      })
    }
  }
  ctx.project.membershipSources.forEach((source, index) => {
    const at = `/membershipSources/${index}`
    if (!known.has(source.scopeKind)) {
      report("rights.scope-kind-unknown", `${at}/scopeKind`, {
        scopeKind: source.scopeKind,
      })
    } else {
      const kindId = projectTarget(`${at}/scopeKind`, "source.scopeKind", ctx)
      if (kindId !== undefined) {
        const catalog = membershipCatalogs(kindId, ctx).length > 0
        if (catalog || counted.has(kindId)) {
          report("rights.membership-source-duplicate", `${at}/scopeKind`, {
            scopeKind: source.scopeKind,
          })
        }
        counted.add(kindId)
      }
    }
    const target = table(source, `${at}/table`)
    if (target !== undefined) {
      checkSourceScope(source.name, at, target)
      checkMember(
        source.name,
        at,
        target,
        projectTarget(`${at}/scopeKind`, "source.scopeKind", ctx)
      )
      checkColumnTypes(source.name, `${at}/columns`, target, {
        scope: "UUID",
        user: "UUID",
        active: "Boolean",
      })
      checkWhere(source.name, at, target, source.where)
    }
  })
  ctx.project.assignmentSources.forEach((source, index) => {
    const at = `/assignmentSources/${index}`
    const level = source.assignedOn
    const container = level !== "global" && "container" in level
    if (
      level !== "global" &&
      "scopeKind" in level &&
      !known.has(level.scopeKind)
    ) {
      report("rights.scope-kind-unknown", `${at}/assignedOn/scopeKind`, {
        scopeKind: level.scopeKind,
      })
    }
    if (container) {
      const pointer = `${at}/assignedOn/container`
      const id = projectTarget(pointer, "source.container", ctx)
      const target = id === undefined ? undefined : ctx.byId.get(id)
      if (target !== undefined && !isRightsContainer(target)) {
        report("rights.container-target", pointer, {
          source: source.name,
          name: target.name,
        })
      }
    }
    if (container && source.columns.container === undefined) {
      report("rights.source-container-column", `${at}/columns`, {
        source: source.name,
        reason: "missing",
      })
    }
    if (!container && source.columns.container !== undefined) {
      report("rights.source-container-column", `${at}/columns/container`, {
        source: source.name,
        reason: "unexpected",
      })
    }
    const target = table(source, `${at}/table`)
    const { role } = source.columns
    if (target !== undefined) {
      checkColumnTypes(source.name, `${at}/columns`, target, {
        member: "UUID",
        ...(typeof role === "string"
          ? { role: "Text" as const }
          : { "role/column": "UUID" as const }),
        scope: "UUID",
        container: "UUID",
        active: "Boolean",
      })
      checkWhere(source.name, at, target, source.where)
    }
    checkRowScope(source, at, target)
    if (typeof role !== "string") checkRoleTable(source.name, at, role)
  })
  diagnostics.push(...sharedTables(ctx))
  return diagnostics
}

/**
 * Одна прийнята таблиця під кількома джерелами призначень (Р2d1-19, п. 2):
 * умови `where` кожної пари мусять бути доведено несумісні однією колонкою —
 * інакше рядок одного рівня поліморфної таблиці читався б і як рядок іншого
 * (R1'). Несумісність через різні колонки компілятор не доводить.
 */
function sharedTables(ctx: RightsCheckContext): Diagnostic[] {
  const byTable = new Map<string, number[]>()
  ctx.project.assignmentSources.forEach((_, index) => {
    const id = projectTarget(
      `/assignmentSources/${index}/table`,
      "source.table",
      ctx
    )
    if (id === undefined) return
    byTable.set(id, [...(byTable.get(id) ?? []), index])
  })
  const reported = new Set<number>()
  for (const [tableId, indexes] of byTable) {
    const target = ctx.byId.get(tableId)
    if (target === undefined || !KIND_REGISTRY[target.kind].declared) continue
    const { columns } = target.data as CustomTable
    const conjuncts = (index: number) =>
      must(ctx.project.assignmentSources[index]).where.flatMap(
        (condition, j) => {
          const id = projectTarget(
            `/assignmentSources/${index}/where/${j}/column`,
            "source.column",
            ctx
          )
          const column = columns.find((c) => c.id === id)
          return column === undefined ? [] : [{ condition, column }]
        }
      )
    indexes.forEach((a, i) => {
      for (const b of indexes.slice(i + 1)) {
        const left = conjuncts(a)
        const right = conjuncts(b)
        const disjoint = left.some((l) =>
          right.some(
            (r) =>
              l.column.id === r.column.id &&
              excludes(l.condition, r.condition, l.column)
          )
        )
        if (disjoint) continue
        reported.add(a)
        reported.add(b)
      }
    })
  }
  return [...reported]
    .sort((a, b) => a - b)
    .map((index) =>
      diagnostic(
        "rights.source-where",
        PROJECT_FILE,
        `/assignmentSources/${index}/table`,
        {
          source: must(ctx.project.assignmentSources[index]).name,
          reason: "shared",
        }
      )
    )
}

/**
 * Чи два кон'юнкти на одній колонці не пропускають спільного рядка: різні
 * літерали, літерал проти `NULL`, `NULL` проти не-`NULL`. Літерали
 * порівнюються як значення колонки: uuid Postgres ототожнює без регістру, а
 * текст під власною колацією може ототожнити різні рядки (недетермінована
 * колація) — тоді несумісності немає (fail-closed).
 */
function excludes(
  left: SourceCondition,
  right: SourceCondition,
  column: CustomTable["columns"][number]
): boolean {
  if ("isNull" in left && "isNull" in right) {
    return left.isNull !== right.isNull
  }
  if ("isNull" in left) return left.isNull
  if ("isNull" in right) return right.isNull
  const type = sourceLiteralType(column)
  if (type === "uuid") {
    return (
      String(left.equals).toLowerCase() !== String(right.equals).toLowerCase()
    )
  }
  if (type === "text" && column.collation !== undefined) return false
  return left.equals !== right.equals
}

/**
 * Чи колонка `key` таблиці ролей унікальна сама (Р2d1-19, п. 3): обмеження
 * рівно над нею чи унікальний індекс з одним ключем-колонкою без предиката.
 * Частковий індекс пускає кастомну роль із ключем системної, а клас
 * операторів чи колація ключа може розрізняти рядки, які `=` з'єднання
 * ототожнює, — обидва не рахуються (fail-closed).
 */
function uniqueKey(table: CustomTable, key: string): boolean {
  // Відкладене обмеження не доводить унікальності: усередині транзакції
  // функції прав бачать дубль, а відкат на COMMIT не скасовує того, що в ній
  // уже прочитано й зроблено. Індекс відкладеним не буває (у схемі поля немає).
  const constraint = table.uniques.some(
    (u) =>
      u.deferrable === "no" && u.columns.length === 1 && u.columns[0] === key
  )
  const index = table.indexes.some((i) => {
    if (!i.unique || i.where !== undefined || i.keys.length !== 1) return false
    const [only] = i.keys
    return (
      only !== undefined &&
      "column" in only &&
      only.column === key &&
      only.opclass === undefined &&
      only.collation === undefined
    )
  })
  return constraint || index
}

/**
 * Чи має вид скоупу системний довідник прав із суб'єктом-учасником: лише
 * тоді таблиці прийнятого членства потрібен `UNIQUE (scope, id)` (Р2d1-5).
 */
function memberSubjectCatalogs(
  scopeKindId: string,
  ctx: Pick<RightsCheckContext, "objects" | "references">
): boolean {
  return ctx.objects.some(
    (o) =>
      KIND_REGISTRY[o.kind].rightsSystem?.(o.data) !== undefined &&
      KIND_REGISTRY[o.kind]
        .standardColumns(o.data)
        .some((column) => column.ref === "member") &&
      scopeKindOf(o, ctx.references) === scopeKindId
  )
}

/**
 * Декларації прав без «Користувачів» можливі лише з прийнятим джерелом
 * членства (спека прав §4.6): інакше множини «моїх» значень і суб'єкти
 * призначень не мали б з чим зіставити поточного користувача. Роль і набір
 * прав — теж декларації: без користувачів їх нікому призначити.
 */
function checkUsers(ctx: RightsCheckContext): Diagnostic[] {
  if (ctx.objects.some(isUsers) || ctx.project.membershipSources.length > 0) {
    return []
  }
  const declared =
    ctx.project.accessDimensions.length > 0 ||
    ctx.project.assignmentSources.length > 0 ||
    ctx.objects.some(
      (o) =>
        isRightsDeclaration(o) ||
        ownershipOf(o).length > 0 ||
        accessOf(o).length > 0 ||
        bindingOf(o) !== undefined
    )
  return declared
    ? [diagnostic("rights.users-missing", PROJECT_FILE, "", {})]
    : []
}

/** Довідники членства виду скоупу. */
function membershipCatalogs(
  scopeKindId: string,
  ctx: Pick<RightsCheckContext, "objects" | "references">
): ParsedObject[] {
  return ctx.objects.filter(
    (o) =>
      isMembershipCatalog(o) && scopeKindOf(o, ctx.references) === scopeKindId
  )
}

/** Id таблиць прийнятих джерел членства виду скоупу. */
function membershipSourceTables(
  scopeKindId: string,
  ctx: Pick<RightsCheckContext, "project" | "references">
): string[] {
  return ctx.project.membershipSources.flatMap((_, index) => {
    const at = `/membershipSources/${index}`
    const kind = projectTarget(`${at}/scopeKind`, "source.scopeKind", ctx)
    const table = projectTarget(`${at}/table`, "source.table", ctx)
    return kind === scopeKindId && table !== undefined ? [table] : []
  })
}

/**
 * Чим вид скоупу має членство (Р1a-17): довідником, прийнятим джерелом чи
 * нічим. Права-1b читає це для вимоги «вид скоупу має членство» (Рх7);
 * `setFunction: "membership"` і далі вимагає саме довідника.
 */
export function membershipOfScopeKind(
  scopeKindId: string,
  objects: readonly ParsedObject[],
  ctx: Pick<RightsCheckContext, "project" | "references">
): "catalog" | "source" | undefined {
  if (membershipCatalogs(scopeKindId, { objects, ...ctx }).length > 0) {
    return "catalog"
  }
  return membershipSourceTables(scopeKindId, ctx).length > 0
    ? "source"
    : undefined
}

/**
 * Ім'я в `effects.header`, якого індекс посилань не резолвив, — не колонка
 * об'єкта: стадія 2 мовчить про нього для видів 1С, тож звітує це правило.
 */
function unknownHeader(
  object: ParsedObject,
  action: CustomAction,
  index: number,
  references: readonly ResolvedReference[]
): Diagnostic[] {
  const { header } = action.effects
  if (header === undefined || header === "all") return []
  return header.flatMap((name, at) =>
    headerReference(object, index, at, references) !== undefined
      ? []
      : [
          diagnostic(
            "rights.attribute-unknown",
            object.file,
            `/customActions/${index}/effects/header/${at}`,
            { attribute: name, field: "customActions.effects.header" }
          ),
        ]
  )
}

/**
 * Id елементів основної таблиці, яких роль команд не змінює: усі її колонки
 * поза `commandWriteColumns(...).update`. Колонку без елемента опису (скоуп,
 * копія носія) шапка назвати не може, тож вона сюди не потрапляє. Таблиці
 * немає лише на моделі з помилками — тоді правило мовчить.
 */
function outsideCommandUpdate(
  object: ParsedObject,
  ctx: RightsCheckContext
): Set<string> {
  const objectId = must(object.id)
  const table = mainTableOf(ctx.model.physical, objectId)
  if (table === undefined) return new Set()
  const { attributeCase } = ctx.project.naming
  // `origin.standard` — ім'я в стилі проєкту, а id елемента — канонічне.
  const standardIds = new Map(
    KIND_REGISTRY[object.kind]
      .standardColumns(object.data)
      .map((def) => [
        standardLogicalName(def, attributeCase),
        standardElementId(objectId, def),
      ])
  )
  const idOf = (c: PhysicalColumn) =>
    c.origin.elementId ?? standardIds.get(c.origin.standard ?? "")
  const { update } = commandWriteColumns(table, {
    attributeCase,
    main: true,
    users: usersCatalogOf(ctx.objects)?.id === objectId,
  })
  const updatable = new Set(update.map(idOf))
  return new Set(
    table.columns.flatMap((c) => {
      const id = idOf(c)
      return id === undefined || updatable.has(id) ? [] : [id]
    })
  )
}

/**
 * Кастомна дія не називає колонку переходу (Р2b1-18): інакше вона була б
 * обхідною дорогою повз право `post`/`markDeletion`. Не називає й незмінної
 * колонки (Р2b1-23), а на виді з `commandWrites` — колонки поза колонками
 * зміни ролі команд (спека П4 §6.2): тригер ефектів чи грант однаково
 * відмовили б її зміну, тож декларація тихо нічого б не дала.
 */
function forbiddenHeader(
  object: ParsedObject,
  action: CustomAction,
  index: number,
  forbidden: {
    transitionIds: ReadonlySet<string>
    immutableIds: ReadonlySet<string>
  },
  references: readonly ResolvedReference[]
): Diagnostic[] {
  const { header } = action.effects
  if (header === undefined || header === "all") return []
  return header.flatMap((_, at) => {
    const target = headerReference(object, index, at, references)?.to.id
    const reason =
      target === undefined
        ? undefined
        : forbidden.transitionIds.has(target)
          ? "transitionColumn"
          : forbidden.immutableIds.has(target)
            ? "immutableColumn"
            : undefined
    return reason === undefined
      ? []
      : [
          diagnostic(
            "rights.custom-action-effects",
            object.file,
            `/customActions/${index}/effects/header/${at}`,
            { action: action.name, reason }
          ),
        ]
  })
}

/**
 * Цикл вимог між кастомними діями (стандартні дії реєстру ациклічні й
 * кастомних не вимагають). Діагностика стоїть на ребрі, що виходить з першої
 * дії циклу на шляху обходу, і називає весь ланцюжок.
 */
function requiresCycles(
  object: ParsedObject,
  actions: readonly CustomAction[],
  standard: ReadonlySet<string>
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const byName = new Map<string, number>()
  actions.forEach((a, i) => {
    if (!byName.has(a.name)) byName.set(a.name, i)
  })
  const state = actions.map(() => "new" as "new" | "open" | "done")
  // `edges[k]` — індекс вимоги, якою обхід перейшов з `path[k]` у `path[k + 1]`.
  const path: number[] = []
  const edges: number[] = []
  const visit = (node: number) => {
    state[node] = "open"
    path.push(node)
    actions[node]!.requires.forEach((name, at) => {
      const next = standard.has(name) ? undefined : byName.get(name)
      if (next === undefined) return
      if (state[next] === "open") {
        const start = path.indexOf(next)
        const edge = start === path.length - 1 ? at : edges[start]!
        const chain = [...path.slice(start), next].map((i) => actions[i]!.name)
        diagnostics.push(
          diagnostic(
            "rights.requires-cycle",
            object.file,
            `/customActions/${next}/requires/${edge}`,
            { actions: chain.join(" → ") }
          )
        )
        return
      }
      if (state[next] === "done") return
      edges.push(at)
      visit(next)
      edges.pop()
    })
    path.pop()
    state[node] = "done"
  }
  actions.forEach((_, i) => {
    if (state[i] === "new") visit(i)
  })
  return diagnostics
}
