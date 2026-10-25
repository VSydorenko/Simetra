import {
  KIND_REGISTRY,
  actionRequires,
  closeRequires,
  singleUuidKeyColumn,
  type ActionEffects,
  type CustomTable,
  type Dml,
  type PhysicalSnapshot,
  type Project,
  type Role,
} from "simetra/model"
import {
  mainTableOf,
  type AccessDimensionContract,
  type AssignmentSourceContract,
  type Contracts,
  type MembershipSourceContract,
  type RightsAction,
  type RightsContract,
  type RightsExtent,
  type RightsProjectionRow,
  type RoleContract,
} from "../contracts"
import { compareStrings, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import { standardElementId, type ResolvedReference } from "../stages/identity"
import { elementColumns, kindLabelOf } from "../stages/model"
import {
  carrierTarget,
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
  customActionEffects,
  customActionsOf,
  declarationsOf,
  grantRecords,
  headerReference,
  includedSets,
  isRightsContainer,
  isUsers,
  ownershipOf,
  recordCustomAction,
  recordExtent,
  recordObjects,
  roleLevel,
  scopeKindOf,
  sourceLevel,
  supportedExtents,
} from "./facts"
import {
  compareExtents,
  expandRole,
  type DeclarationInput,
  type ResolvedGrant,
} from "./expand"
import { must, objectTarget, projectTarget } from "./references"

/**
 * Спільний набір обсягів дій об'єкта. Усі дії об'єкта мають один набір
 * (на цьому стоїть єдина умова політик запису, Р2b1-5): різні набори дали б
 * мовчазне розходження політик, тож це внутрішня помилка компілятора.
 */
export function uniformExtents(
  actions: readonly RightsAction[],
  label: string
): RightsExtent[] {
  const first = must(actions[0]).extents
  const key = JSON.stringify(first)
  if (actions.some((a) => JSON.stringify(a.extents) !== key)) {
    throw new Error(`internal: rights actions of ${label} differ in extents`)
  }
  return first
}

/**
 * Контракти прав (спека прав §3): запис має кожен об'єкт виду з непорожнім
 * `rightsExtents`. Викликається лише на моделі без помилок: цикли вимог і
 * невідомі дії вже відхилила стадія 4, тож замикання не кидає.
 */
export function rightsContracts(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  physical: PhysicalSnapshot,
  project: Project
): RightsContract[] {
  const ctx = carrierContext({ objects, references, physical, project })
  return objects
    .filter((object) => KIND_REGISTRY[object.kind].rightsExtents.length > 0)
    .map((object) => rightsContract(object, ctx))
    .sort((a, b) => compareStrings(a.objectId, b.objectId))
}

function rightsContract(
  object: ParsedObject,
  ctx: CarrierContext
): RightsContract {
  const { references, physical } = ctx
  const def = KIND_REGISTRY[object.kind]
  const objectId = must(object.id)
  const table = must(mainTableOf(physical, objectId))
  const columnsOf = elementColumns(
    object,
    table,
    ctx.project.naming.attributeCase
  )
  const standard = def.actions(object.data)
  const custom = customActionsOf(object)
    .map((action, index) => ({ action, index }))
    .sort((a, b) => compareStrings(must(a.action.id), must(b.action.id)))

  // Ключ дії в контракті — слово словника чи UUID кастомної (Рх18), тож і
  // вимоги замикаються над ключами: ім'я кастомної дії може змінитися.
  const standardNames = new Set<string>(standard.map((a) => a.name))
  const keyOf = (name: string) =>
    standardNames.has(name)
      ? name
      : must(custom.find((c) => c.action.name === name)?.action.id)
  const customEffects = new Map(
    custom.map(({ action }) => [action, customActionEffects(action)])
  )
  const closed = closeRequires([
    ...standard.map((a) => ({ name: a.name, requires: actionRequires(a) })),
    ...custom.map(({ action }) => ({
      name: must(action.id),
      requires: actionRequires({
        requires: action.requires.map(keyOf),
        effects: must(customEffects.get(action)),
      }),
    })),
  ])

  const scopeKindId = scopeKindOf(object, references)
  // Носії вже перевірила стадія 4, тож резолв тут не падає, а ціль власності
  // — «Користувачі» чи учасник виду скоупу самого об'єкта (довідник членства
  // чи прийняте джерело того самого виду).
  const ownership = ownershipOf(object).map((carrier, index) => {
    const resolved = resolveCarrier(
      object,
      carrier,
      { pointer: `/ownership/${index}`, field: "ownership" },
      ctx
    )
    if (!resolved.ok) throw new Error("internal: unchecked rights carrier")
    return {
      ...resolved.contract,
      owner: isUsers(carrierTarget(resolved.terminal))
        ? ({ users: true } as const)
        : { membership: must(scopeKindId) },
    }
  })
  const bindingCarrier = bindingOf(object)
  let binding: RightsContract["binding"]
  if (bindingCarrier !== undefined) {
    const resolved = resolveCarrier(
      object,
      bindingCarrier,
      { pointer: "/containerBinding", field: "containerBinding" },
      ctx
    )
    if (!resolved.ok) throw new Error("internal: unchecked rights carrier")
    binding = {
      containerId: must(carrierTarget(resolved.terminal).id),
      carrier: resolved.contract,
    }
  }
  const access = accessOf(object).map((mapping, index) => {
    const { carrier, pointer } = accessCarrier(mapping, index)
    const resolved = resolveCarrier(
      object,
      carrier,
      { pointer, field: "access", role: "access.attribute" },
      ctx
    )
    if (!resolved.ok) throw new Error("internal: unchecked rights carrier")
    return {
      dimensionId: must(accessDimensionId(object, index, references)),
      carrier: resolved.contract,
    }
  })
  const extents = supportedExtents(object, references)
  const physicalOf = (logicalName: string) =>
    must(columnsOf.get(standardElementId(objectId, { logicalName })))
  // Колонки переходів — з `transition` стандартних дій виду (без гілки за
  // видом), значення за замовчуванням — зі стандартної колонки реєстру.
  const standardColumns = def.standardColumns(object.data)
  const transitions = [
    ...new Set(
      standard.flatMap((a) => (a.transition ? [a.transition.column] : []))
    ),
  ]
    .flatMap((logicalName) => {
      const standardColumn = must(
        standardColumns.find((c) => c.logicalName === logicalName)
      )
      return physicalOf(logicalName).map((column) => ({
        column,
        default: must(standardColumn.default),
      }))
    })
    .sort((a, b) => compareStrings(a.column, b.column))
  const transitionColumns = new Set(transitions.map((t) => t.column))
  // Колонки переходів змінює лише дія-перехід, тож `"all"` розгортається в
  // явний перелік без них (Р2b1-18): тригер ефектів порівнює їх, як будь-які
  // колонки поза ефектом дії.
  // Ключ `ref` незмінний за будь-якої дії (Р2b1-9): змінений ключ — зміна
  // ідентичності кореня, тож у шапку дії він не входить.
  const keyColumns = new Set(
    columnsOf.get(standardElementId(objectId, { logicalName: "ref" })) ?? []
  )
  const expandAll = [...columnsOf.values()]
    .flat()
    .filter(
      (column) => !transitionColumns.has(column) && !keyColumns.has(column)
    )
  // Ім'я шапки стандартної дії — факт реєстру; без фізичної колонки це дрейф
  // реєстру, а не порожній ефект.
  const canonicalHeader = (header: ActionEffects["header"]) =>
    header === "all" ? expandAll : header.flatMap(physicalOf)
  // Ім'я шапки кастомної дії резолвила стадія 2 і перевірила стадія 4, тож
  // відсутня колонка — дефект компілятора, а не тихо порожній ефект.
  const customHeader = (index: number, header: ActionEffects["header"]) =>
    header === "all"
      ? expandAll
      : header.flatMap((_, at) =>
          must(
            columnsOf.get(
              must(headerReference(object, index, at, references)).to.id
            )
          )
        )

  const actions: RightsAction[] = [
    ...standard.map((a) => ({
      action: a.name,
      name: a.name,
      requires: [...must(closed.get(a.name))],
      effects: {
        dml: [...a.effects.dml],
        header: canonicalHeader(a.effects.header),
        tabularSections: a.effects.tabularSections,
      },
      natural: a.natural ? [...a.effects.dml] : [],
      ...(a.transition
        ? {
            transition: {
              ...a.transition,
              column: must(physicalOf(a.transition.column)[0]),
            },
          }
        : {}),
      extents,
    })),
    ...custom.map(({ action, index }) => {
      const id = must(action.id)
      const effects = must(customEffects.get(action))
      return {
        action: id,
        name: action.name,
        requires: [...must(closed.get(id))],
        effects: {
          dml: [...effects.dml],
          header: customHeader(index, effects.header),
          tabularSections: effects.tabularSections,
        },
        natural: [],
        extents,
      }
    }),
  ]
  const label = must(kindLabelOf(object))
  // На кожен DML — щонайбільше одна природна дія (Р2b1-7): інакше «решта
  // рядків» мала б дві рівноправні умови.
  const naturalDml = new Set<Dml>()
  for (const action of actions) {
    for (const dml of action.natural) {
      if (naturalDml.has(dml)) {
        throw new Error(
          `internal: rights actions of ${label} have two natural actions for ${dml}`
        )
      }
      naturalDml.add(dml)
    }
  }
  uniformExtents(actions, label)
  const system = def.rightsSystem?.(object.data)
  return {
    objectId,
    kindLabel: label,
    table: { schema: table.schema, name: table.name },
    ...(scopeKindId === undefined ? {} : { scopeKindId }),
    actions,
    transitions,
    ownership,
    ...(isRightsContainer(object) ? { container: true as const } : {}),
    ...(binding === undefined ? {} : { binding }),
    access,
    ...(system === undefined ? {} : { system }),
  }
}

/**
 * Контракти вимірів доступу проєкту (спека прав §4.4). Викликається лише на
 * моделі без помилок: ціль, об'єкт і поля зв'язку вже перевірила стадія 4.
 */
export function accessDimensionContracts(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  physical: PhysicalSnapshot,
  project: Project
): AccessDimensionContract[] {
  const ctx = carrierContext({ objects, references, physical, project })
  const toId = (pointer: string, role: ResolvedReference["role"]) =>
    must(projectTarget(pointer, role, { references }))
  return project.accessDimensions
    .map((dimension, index): AccessDimensionContract => {
      const at = `/accessDimensions/${index}`
      const dimensionId = must(dimension.id)
      const targetId = toId(`${at}/target`, "dimension.target")
      if ("function" in dimension.values) {
        const { schema, name } = dimension.values.function
        return {
          dimensionId,
          name: dimension.name,
          targetId,
          values: {
            function: { schema: schema ?? project.defaultSchema, name },
          },
        }
      }
      const { relation } = dimension.values
      const relationAt = `${at}/values/relation`
      const object = must(
        ctx.byId.get(toId(`${relationAt}/object`, "dimension.relationObject"))
      )
      const table = must(mainTableOf(physical, must(object.id)))
      const field = (name: "subject" | "value") =>
        must(
          elementField(
            object,
            toId(`${relationAt}/${name}`, "dimension.relationField"),
            relation[name],
            ctx
          )
        )
      const column = (name: "subject" | "value") => field(name).column
      // Ціль суб'єкта стадія 4 вже звузила до «Користувачів» чи довідника
      // членства виду зв'язку (Р2a1-27).
      const subject = must(field("subject").target)
      return {
        dimensionId,
        name: dimension.name,
        targetId,
        values: {
          relation: {
            objectId: must(object.id),
            table: { schema: table.schema, name: table.name },
            subject: column("subject"),
            subjectTarget: isUsers(subject)
              ? { users: true }
              : { membership: must(scopeKindOf(subject, references)) },
            value: column("value"),
          },
        },
      }
    })
    .sort((a, b) => compareStrings(a.dimensionId, b.dimensionId))
}

/**
 * Контракти прийнятих джерел (спека прав §4.7): ідентичність, рівень і
 * таблиця з фізичними колонками. Викликається лише на моделі без помилок:
 * таблиці, колонки, види й контейнери вже резолвила стадія 2 і перевірила
 * стадія 4.
 */
export function sourceContracts(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  physical: PhysicalSnapshot,
  project: Project
): Pick<Contracts, "membershipSources" | "assignmentSources"> {
  const { byId } = carrierContext({ objects, references, physical, project })
  const toId = (pointer: string, role: ResolvedReference["role"]) =>
    projectTarget(pointer, role, { references })
  // Таблиця джерела й фізична колонка за логічним полем мапінгу.
  const tableOf = (at: string) => {
    const object = must(byId.get(must(toId(`${at}/table`, "source.table"))))
    const table = must(mainTableOf(physical, must(object.id)))
    const columns = elementColumns(object, table, project.naming.attributeCase)
    const column = (field: string) =>
      must(
        columns.get(must(toId(`${at}/columns/${field}`, "source.column")))?.[0]
      )
    // Учасник — одноколонковий uuid-ключ (Р2d1-2), його перевірила стадія 4.
    const key = () =>
      must(
        columns.get(
          must(singleUuidKeyColumn(object.data as CustomTable)?.id)
        )?.[0]
      )
    return {
      table: { schema: table.schema, name: table.name },
      column,
      key,
    }
  }
  const membershipSources = project.membershipSources
    .map((source, index): MembershipSourceContract => {
      const at = `/membershipSources/${index}`
      const { table, column, key } = tableOf(at)
      return {
        sourceId: must(source.id),
        name: source.name,
        scopeKindId: must(toId(`${at}/scopeKind`, "source.scopeKind")),
        table,
        scope: column("scope"),
        member: key(),
        user: column("user"),
        ...(source.columns.active === undefined
          ? {}
          : { active: column("active") }),
      }
    })
    .sort((a, b) => compareStrings(a.sourceId, b.sourceId))
  const assignmentSources = project.assignmentSources
    .map((source, index): AssignmentSourceContract => {
      const at = `/assignmentSources/${index}`
      const { table, column } = tableOf(at)
      return {
        sourceId: must(source.id),
        name: source.name,
        assignedOn: must(sourceLevel(project, index, references)),
        table,
        member: column("member"),
        role: column("role"),
        ...(source.columns.container === undefined
          ? {}
          : { container: column("container") }),
        ...(source.columns.active === undefined
          ? {}
          : { active: column("active") }),
      }
    })
    .sort((a, b) => compareStrings(a.sourceId, b.sourceId))
  return { membershipSources, assignmentSources }
}

/**
 * Транзитивне замикання включень декларації (набору чи ролі) — id наборів за
 * зростанням. Викликається лише на моделі без помилок: цикли включень уже
 * відхилила стадія 4, тож обхід скінченний; ромб дає набір один раз.
 */
function includeClosure(
  object: ParsedObject,
  byId: ReadonlyMap<string, ParsedObject>,
  references: readonly ResolvedReference[]
): string[] {
  const seen = new Set<string>()
  const walk = (from: ParsedObject) => {
    for (const id of includedSets(from, references)) {
      if (seen.has(must(id))) continue
      seen.add(must(id))
      walk(must(byId.get(must(id))))
    }
  }
  walk(object)
  return [...seen].sort(compareStrings)
}

/**
 * Контракти ролей (спека прав §4.1): рівень з id цілей, загальні властивості
 * й замкнені включення. Викликається лише на моделі без помилок.
 */
export function roleContracts(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[]
): RoleContract[] {
  const byId = new Map(objects.map((o) => [must(o.id), o]))
  return declarationsOf(objects, "role")
    .map((object): RoleContract => {
      const role = object.data as Role
      return {
        roleId: must(object.id),
        name: object.name,
        assignedOn: must(roleLevel(object, references)),
        fullAccess: role.fullAccess,
        ...(role.order === undefined ? {} : { order: role.order }),
        assignable: role.assignable,
        ...(role.maxHolders === undefined
          ? {}
          : { maxHolders: role.maxHolders }),
        rootCreator: role.rootCreator,
        sourceKeys: role.sourceKeys.map((entry, index) => ({
          sourceId: must(
            objectTarget(
              object,
              `/sourceKeys/${index}/source`,
              "role.sourceKey",
              references
            )
          ),
          key: entry.key,
        })),
        sets: includeClosure(object, byId, references),
      }
    })
    .sort((a, b) => compareStrings(a.roleId, b.roleId))
}

/**
 * Проєкція прав (спека прав §3, §4.1): рядки всіх ролей за `roleId`,
 * `objectId`, дією й обсягом. Викликається на моделі без помилок стадій 2–5:
 * цілі грантів резолвлено, а перевірки без рівня вже пройдено. Діагностики
 * рівня й вимог — свої: набір, включений кількома ролями, звітує однакову
 * помилку один раз.
 */
export function rightsProjection(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  rights: readonly RightsContract[],
  roles: readonly RoleContract[],
  project: Pick<Project, "accessDimensions">
): { rows: RightsProjectionRow[]; diagnostics: Diagnostic[] } {
  const inputs = new Map<string, DeclarationInput>()
  for (const object of [
    ...declarationsOf(objects, "set"),
    ...declarationsOf(objects, "role"),
  ]) {
    inputs.set(must(object.id), {
      id: must(object.id),
      grants: grantRecords(object).map((record, index): ResolvedGrant => {
        const selector = record.objects
        const extent = record.extent
        return {
          form: record.form,
          file: object.file,
          index,
          ...(selector === undefined
            ? {}
            : {
                objects: Array.isArray(selector)
                  ? { ids: recordObjects(object, record, references).map(must) }
                  : selector,
              }),
          actions: record.actions.map(
            (name, at) =>
              recordCustomAction(object, record, at, references) ?? name
          ),
          ...(extent === undefined
            ? {}
            : { extent: must(recordExtent(object, record, references)) }),
        }
      }),
      include: includedSets(object, references).map(must),
    })
  }
  const ctx = {
    rights: new Map(rights.map((c) => [c.objectId, c])),
    objectNames: new Map(objects.map((o) => [must(o.id), o.name])),
    dimensionNames: new Map(
      project.accessDimensions.map((d) => [must(d.id), d.name])
    ),
  }
  const rows: RightsProjectionRow[] = []
  const diagnostics = new Map<string, Diagnostic>()
  for (const role of roles) {
    const expanded = expandRole(
      {
        ...must(inputs.get(role.roleId)),
        assignedOn: role.assignedOn,
        sets: role.sets.map((id) => must(inputs.get(id))),
      },
      ctx
    )
    rows.push(...expanded.rows)
    for (const d of expanded.diagnostics) {
      diagnostics.set(JSON.stringify([d.code, d.file, d.pointer, d.params]), d)
    }
  }
  rows.sort(
    (a, b) =>
      compareStrings(a.roleId, b.roleId) ||
      compareStrings(a.objectId, b.objectId) ||
      compareStrings(a.action, b.action) ||
      compareExtents(a.extent, b.extent)
  )
  return { rows, diagnostics: [...diagnostics.values()] }
}
