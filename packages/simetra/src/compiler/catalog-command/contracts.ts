import {
  KIND_REGISTRY,
  authorColumns,
  deletionMarkColumn,
  keyColumn,
  lineNumberColumn,
  predefinedNameColumn,
  standardLogicalName,
  tabularParentColumn,
  versionColumn,
  type Attribute,
  type AttributeCase,
  type Catalog,
  type MetadataRef,
  type PhysicalSnapshot,
  type PhysicalTable,
  type StandardColumnDef,
} from "simetra/model"
import {
  derived,
  mainTableOf,
  writesByCommandContract,
  type AccessContract,
  type EventSubscriptionContract,
  type QualifiedName,
  type RightsContract,
} from "../contracts"
import { compareStrings } from "../diagnostics"
import { carrierLinks, type CarrierLink } from "../rights/carrier-units"
import type { SqlParser } from "../sql/parse"
import type { PlpgsqlParser } from "../sql/plpgsql"
import { functionIdentity, type SqlUnit } from "../sql/units"
import {
  findStandardColumn,
  findStyleFreeColumn,
  standardColumn,
  styleFreeColumn,
} from "../standard-column"
import { objectKey, type ParsedObject } from "../stages/files"
import { handlerAssigns } from "../stages/links"
import { fieldForeignKey, kindLabelOf } from "../stages/model"

/** Мітки імен функцій ядра довідника: ім'я — `derived(<таблиця>, <мітка>)`. */
export const CATALOG_COMMAND_LABELS = {
  save: "save",
  markDeletion: "mark_deletion",
  delete: "delete",
} as const

/**
 * Контракт ядра команд основної таблиці довідника (спека П4 §6.6, план A2):
 * з нього генератор ядра будує `<t>_save`, `<t>_mark_deletion` і `<t>_delete`.
 * Колонки названо фізичними іменами, знайденими за `origin`, а не за іменем.
 */
export interface CatalogCommandContract {
  objectId: string
  kindLabel: string
  table: PhysicalTable
  /** Колонка з `origin.scopeKindId`; у кореня виду скоупу — сам ключ. */
  scopeColumn?: string
  key: string
  functions: {
    save: QualifiedName
    markDeletion?: QualifiedName
    delete?: QualifiedName
  }
  /** Дія контексту кожної функції чи гілки (Р-A2-11); немає — немає й гілки. */
  actions: {
    create?: string
    update: string
    markDeletion?: string
    delete?: string
  }
  /** Ключі `p_item` створення й зміни (Р-A2-5) — з гранту ролі команд. */
  createKeys: string[]
  updateKeys: string[]
  tabularSections: CatalogCommandSection[]
  /** Посилання шапки. */
  references: CommandReference[]
  /** Зв'язки копій носіїв основної таблиці — ті самі, що в тригера носіїв. */
  carrierLinks: CarrierLink[]
  predefinedColumn?: string
  versionColumn: string
  /** `lockAlways` — обробник `beforeWrite` може присвоїти батька (Р-A2-17). */
  hierarchy?: { parent: string; lockAlways: boolean }
}

/** ТЧ довідника в контракті ядра; ключ ТЧ у `p_item.tabular` — `table.name`. */
export interface CatalogCommandSection {
  table: PhysicalTable
  key: string
  parent: string
  lineNumber: string
  /**
   * Власна колонка скоупу ТЧ — лише коли вона не `parent`: у ТЧ кореня
   * скоупу скоуп несе сам `parent_id`, і друга колонка INSERT повторила б її.
   */
  scopeColumn?: string
  /** `command.insert` ТЧ без ключа, власника, номера рядка й скоупу. */
  rowKeys: string[]
  /** `command.update` ТЧ без номера рядка: його ядро ставить саме. */
  updateColumns: string[]
  references: CommandReference[]
}

/**
 * Посилання, ціль якого ядро перевіряє видимістю під командою. `single` —
 * одна ціль; `pair` — поліморфна пара з мітками видів цілей.
 */
export type CommandReference =
  | {
      form: "single"
      column: string
      target: PhysicalTable
      targetKey: string
      array: boolean
      /** Свідомо між тенантами: ядро не звіряє скоуп цілі. */
      crossScope?: true
    }
  | {
      form: "pair"
      typeColumn: string
      idColumn: string
      array: boolean
      crossScope?: true
      targets: {
        label: string
        table: PhysicalTable
        key: string
        scopeColumn?: string
      }[]
    }

/**
 * Контракти ядра (план A2, Задача 1): лише основні таблиці об'єктів виду з
 * `commandWrites`, що мають запис ролі команд (`AccessContract.command`) і хоч
 * одну дію з записом. Ключі `p_item` — з того самого `AccessContract.command`,
 * з якого рендеряться гранти: розсинхрон ключа й гранту неможливий побудовою.
 * Викликається на моделі без помилок.
 */
export function catalogCommandContracts(input: {
  access: readonly AccessContract[]
  rights: readonly RightsContract[]
  physical: PhysicalSnapshot
  objects: readonly ParsedObject[]
  attributeCase: AttributeCase
  usersObjectId: string | undefined
  scopeRootIds: ReadonlySet<string>
  subscriptions: readonly EventSubscriptionContract[]
  /** Одиниці SQL, серед яких обробники підписок (ідентичність без аргументів). */
  units: readonly Pick<SqlUnit, "identity" | "sql">[]
  parse: SqlParser
  plpgsql: PlpgsqlParser
}): CatalogCommandContract[] {
  const { physical, attributeCase: style } = input
  const objectsById = new Map(input.objects.map((o) => [o.id ?? "", o]))
  const rightsById = new Map(input.rights.map((r) => [r.objectId, r]))
  const accessByTable = new Map(input.access.map((a) => [tableKey(a.table), a]))
  const links = carrierLinks(physical)
  const reference = referenceResolver(input.objects, physical)

  return input.access
    .flatMap((access): CatalogCommandContract[] => {
      const command = access.command
      const object = objectsById.get(access.objectId)
      const rights = rightsById.get(access.objectId)
      if (
        command === undefined ||
        object === undefined ||
        rights === undefined ||
        KIND_REGISTRY[object.kind].commandWrites !== true ||
        !writesByCommandContract(rights)
      ) {
        return []
      }
      const table = mainTableOf(physical, access.objectId)
      if (table === undefined || tableKey(table) !== tableKey(access.table)) {
        return []
      }
      const actions = actionsOf(rights, {
        users: access.objectId === input.usersObjectId,
        root: input.scopeRootIds.has(access.objectId),
        roleAssignments:
          KIND_REGISTRY[object.kind].rightsSystem?.(object.data) ===
          "roleAssignments",
      })
      if (actions === undefined) return []

      const key = styleFreeColumn(table, keyColumn(false)).name
      // Позначку пише лише `mark_deletion` (Р-A2-5), а переходи — лише
      // дія-перехід: обидва вилучаються з ключів однаково, хоч у системних
      // довідниках прав позначка й не перехід.
      const excluded = new Set([
        ...rights.transitions.map((t) => t.column),
        standardColumn(table, deletionMarkColumn(), style).name,
      ])
      const standard = KIND_REGISTRY[object.kind].standardColumns(object.data)
      const parent = selfParentOf(table, standard, style)
      const scopeColumn = table.columns.find(
        (c) => c.origin.scopeKindId !== undefined
      )?.name
      const predefinedColumn = findStandardColumn(
        table,
        predefinedNameColumn(),
        style
      )?.name
      const sections = (object.data as Catalog).tabularSections

      return [
        {
          objectId: access.objectId,
          kindLabel: rights.kindLabel,
          table,
          ...(scopeColumn === undefined ? {} : { scopeColumn }),
          key,
          functions: {
            save: derived(table, CATALOG_COMMAND_LABELS.save),
            ...(actions.markDeletion === undefined
              ? {}
              : {
                  markDeletion: derived(
                    table,
                    CATALOG_COMMAND_LABELS.markDeletion
                  ),
                }),
            ...(actions.delete === undefined
              ? {}
              : { delete: derived(table, CATALOG_COMMAND_LABELS.delete) }),
          },
          actions,
          createKeys: command.insert.filter((c) => !excluded.has(c)),
          updateKeys: command.update.filter((c) => !excluded.has(c)),
          tabularSections: physical.tables
            .filter(
              (t) =>
                t.origin.objectId === access.objectId &&
                t.origin.tabularSectionId !== undefined &&
                t.origin.part === undefined
            )
            .map((section) =>
              sectionContract(
                section,
                must(accessByTable.get(tableKey(section))?.command),
                {
                  style,
                  // Стандартної ТЧ (дельта «Ролей») серед ТЧ файлу немає, а
                  // посилань-реквізитів вона не має.
                  attributes:
                    sections.find(
                      (s) => s.id === section.origin.tabularSectionId
                    )?.attributes ?? [],
                  reference,
                }
              )
            ),
          references: [
            ...standardReferences(
              physical,
              table,
              standard,
              style,
              scopeColumn
            ),
            ...ownerReferences(object, table, standard, style, reference),
            ...reference.attributes((object.data as Catalog).attributes, table),
          ],
          carrierLinks: links.filter(
            (l) => tableKey(l.table) === tableKey(table)
          ),
          ...(predefinedColumn === undefined ? {} : { predefinedColumn }),
          versionColumn: standardColumn(table, versionColumn(), style).name,
          ...(parent === undefined
            ? {}
            : {
                hierarchy: {
                  parent,
                  lockAlways: assignsParent(table, parent, input),
                },
              }),
        },
      ]
    })
    .sort(
      (a, b) =>
        compareStrings(a.table.schema, b.table.schema) ||
        compareStrings(a.table.name, b.table.name)
    )
}

/**
 * Дії функцій ядра з реєстру дій об'єкта (Р-A2-11): стандартна дія, коли
 * вона є, інакше `administerRights` (системні довідники прав, Р2c2-1). Без
 * дії зміни ядра немає зовсім; корінь скоупу й «Користувачі» не створюються
 * командою (Р-A2-10, спека П4 §6.6), «Користувачі» — лише `save`.
 */
function actionsOf(
  rights: RightsContract,
  facts: { users: boolean; root: boolean; roleAssignments: boolean }
): CatalogCommandContract["actions"] | undefined {
  const present = new Set(rights.actions.map((a) => a.action))
  const admin = present.has("administerRights") ? "administerRights" : undefined
  const pick = (action: string) => (present.has(action) ? action : admin)
  const update = pick("update")
  if (update === undefined) return undefined
  const create = facts.users || facts.root ? undefined : pick("create")
  const markDeletion = facts.users ? undefined : pick("markDeletion")
  const remove = facts.roleAssignments ? pick("delete") : undefined
  return {
    ...(create === undefined ? {} : { create }),
    update,
    ...(markDeletion === undefined ? {} : { markDeletion }),
    ...(remove === undefined ? {} : { delete: remove }),
  }
}

function sectionContract(
  table: PhysicalTable,
  command: NonNullable<AccessContract["command"]>,
  facts: {
    style: AttributeCase
    attributes: readonly Attribute[]
    reference: ReferenceResolver
  }
): CatalogCommandSection {
  const key = styleFreeColumn(table, keyColumn(false)).name
  const parent = styleFreeColumn(table, tabularParentColumn()).name
  const lineNumber = standardColumn(table, lineNumberColumn(), facts.style).name
  const scope = table.columns.find(
    (c) => c.origin.scopeKindId !== undefined
  )?.name
  const scopeColumn = scope === parent ? undefined : scope
  const fixed = new Set([key, parent, lineNumber, scopeColumn])
  return {
    table,
    key,
    parent,
    lineNumber,
    ...(scopeColumn === undefined ? {} : { scopeColumn }),
    rowKeys: command.insert.filter((c) => !fixed.has(c)),
    updateColumns: command.update.filter((c) => c !== lineNumber),
    references: facts.reference.attributes(facts.attributes, table),
  }
}

/**
 * Стандартні колонки-посилання шапки з однією ціллю (`ref` визначення
 * реєстру: батько ієрархії, авторство, суб'єкт і кастомна роль призначень
 * тощо) — кожне нове чи змінене значення `Ref` ядро перевіряє видимістю.
 * Ціль і її ключ — з FK колонки: стадія 3 будує його для кожної такої
 * колонки й резолвить ціль за рівнем таблиці, тож друга резолюція тут лише
 * розійшлася б із нею. Власник (`owners`) — окремо (пара без FK); колонка
 * скоупу — не посилання команди: її значення тримає межа тенанта.
 */
function standardReferences(
  physical: PhysicalSnapshot,
  table: PhysicalTable,
  defs: readonly StandardColumnDef[],
  style: AttributeCase,
  scopeColumn: string | undefined
): CommandReference[] {
  // Авторство ставить платформа (`current_user_id()`), не вхід команди: оракула
  // видимості тут немає, а перевірка під RLS «Користувачів» відмовила б
  // користувачу без права їх читати — тому, кого описує Р-A2-14.
  const author = new Set(authorColumns().map((a) => a.logicalName))
  const names = new Set(
    defs
      .filter(
        (d) =>
          d.ref !== undefined &&
          d.ref !== "owners" &&
          !author.has(d.logicalName)
      )
      .map((d) => findStandardColumn(table, d, style)?.name)
  )
  return table.columns
    .filter((c) => names.has(c.name) && c.name !== scopeColumn)
    .flatMap((column): CommandReference[] => {
      const fk = fieldForeignKey(table, column.name)
      if (fk === undefined) {
        throw new Error(
          `internal: standard reference ${tableKey(table)}.${column.name} has no foreign key`
        )
      }
      return [
        {
          form: "single",
          column: column.name,
          target: must(
            physical.tables.find(
              (t) =>
                t.schema === fk.references.schema &&
                t.name === fk.references.table
            )
          ),
          targetKey: must(
            fk.references.columns[fk.columns.indexOf(column.name)]
          ),
          array: false,
        },
      ]
    })
}

/**
 * Власник підпорядкованого довідника (`ref: "owners"`): одна ціль — `single`,
 * кілька — пара. Без цього `owner_id` невидимого рядка свого тенанта
 * розрізняв би «є» й «нема» відмовою FK — оракул поза §6.10.
 */
function ownerReferences(
  object: ParsedObject,
  table: PhysicalTable,
  standard: readonly StandardColumnDef[],
  style: AttributeCase,
  reference: ReferenceResolver
): CommandReference[] {
  const columns = ownerColumnsOf(table, standard, style)
  if (columns.length === 0) return []
  const owners = (object.data as Catalog).owners
  if (columns.length === 1) {
    const target = reference.single(must(owners[0]))
    return target === undefined
      ? []
      : [{ form: "single", column: columns[0]!, ...target, array: false }]
  }
  return [
    {
      form: "pair",
      typeColumn: columns[0]!,
      idColumn: columns[1]!,
      array: false,
      targets: reference.pair(owners),
    },
  ]
}

interface ReferenceResolver {
  single(
    ref: MetadataRef
  ): { target: PhysicalTable; targetKey: string } | undefined
  pair(
    refs: readonly MetadataRef[]
  ): Extract<CommandReference, { form: "pair" }>["targets"]
  /** Посилання реквізитів `Ref` таблиці; колонку знаходить `origin.elementId`. */
  attributes(
    attributes: readonly Attribute[],
    table: PhysicalTable
  ): CommandReference[]
}

/**
 * Цілі посилань — з метаданих, не з FK: масив `Ref` FK не має, а мітки пари
 * в знімку — лише текст CHECK. Ціль без таблиці (перерахування — мітка, а не
 * рядок) посиланням ядра не є.
 */
function referenceResolver(
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot
): ReferenceResolver {
  const byKey = new Map(objects.map((o) => [objectKey(o.kind, o.name), o]))
  const resolve = (ref: MetadataRef) => {
    const object = byKey.get(objectKey(ref.kind, ref.name))
    const table =
      object === undefined ? undefined : mainTableOf(physical, object.id ?? "")
    return object === undefined || table === undefined
      ? undefined
      : { object, table, key: targetKeyOf(table) }
  }
  const single = (ref: MetadataRef) => {
    const found = resolve(ref)
    return found === undefined
      ? undefined
      : { target: found.table, targetKey: found.key }
  }
  const pair = (refs: readonly MetadataRef[]) =>
    refs.flatMap((ref) => {
      const found = resolve(ref)
      if (found === undefined) return []
      const scopeColumn = found.table.columns.find(
        (c) => c.origin.scopeKindId !== undefined
      )?.name
      return [
        {
          label: must(kindLabelOf(found.object)),
          table: found.table,
          key: found.key,
          ...(scopeColumn === undefined ? {} : { scopeColumn }),
        },
      ]
    })
  return {
    single,
    pair,
    attributes: (attributes, table) =>
      attributes.flatMap((attribute): CommandReference[] => {
        if (attribute.type !== "Ref") return []
        // Пара — дві колонки одного елемента в порядку `_type`, `_id`.
        const columns = table.columns
          .filter((c) => c.origin.elementId === attribute.id)
          .map((c) => c.name)
        const array = attribute.array === true
        const cross =
          attribute.crossScope === true ? { crossScope: true as const } : {}
        if (attribute.ref !== undefined) {
          const target = single(attribute.ref)
          return target === undefined
            ? []
            : [
                {
                  form: "single",
                  column: must(columns[0]),
                  ...target,
                  array,
                  ...cross,
                },
              ]
        }
        const targets = pair(attribute.allowedTypes ?? [])
        return targets.length === 0
          ? []
          : [
              {
                form: "pair",
                typeColumn: must(columns[0]),
                idColumn: must(columns[1]),
                array,
                ...cross,
                targets,
              },
            ]
      }),
  }
}

/** Ключ цілі посилання: колонка `ref` виду чи єдиний первинний ключ таблиці. */
function targetKeyOf(table: PhysicalTable): string {
  const ref = findStyleFreeColumn(table, keyColumn(false))?.name
  if (ref !== undefined) return ref
  const [only, ...rest] = table.primaryKey?.columns ?? []
  if (only === undefined || rest.length > 0) {
    throw new Error(
      `internal: reference target ${tableKey(table)} has no single key`
    )
  }
  return only
}

/**
 * Чи присвоює батька хоч один обробник `beforeWrite` таблиці (Р-A2-17).
 * Обробника без одиниці модель без помилок не має; якщо так сталося —
 * «присвоює» (fail-closed), як і нерозбірне тіло.
 */
function assignsParent(
  table: PhysicalTable,
  parent: string,
  input: {
    subscriptions: readonly EventSubscriptionContract[]
    units: readonly Pick<SqlUnit, "identity" | "sql">[]
    parse: SqlParser
    plpgsql: PlpgsqlParser
  }
): boolean {
  const columns = new Set([parent.toLowerCase()])
  return input.subscriptions.some((subscription) => {
    if (subscription.event !== "beforeWrite") return false
    if (
      !subscription.sources.some(
        (s) => s.schema === table.schema && s.table === table.name
      )
    ) {
      return false
    }
    const identity = functionIdentity(
      subscription.handler.schema,
      subscription.handler.name,
      []
    )
    const unit = input.units.find((u) => u.identity === identity)
    return (
      unit === undefined ||
      handlerAssigns(unit.sql, columns, input.parse, input.plpgsql)
    )
  })
}

/** Колонка батька ієрархії: стандартна колонка реєстру виду з ціллю `self`. */
function selfParentOf(
  table: PhysicalTable,
  defs: readonly StandardColumnDef[],
  style: AttributeCase
): string | undefined {
  return defs
    .filter((d) => d.ref === "self")
    .map((d) => findStandardColumn(table, d, style)?.name)
    .find((name) => name !== undefined)
}

/**
 * Фізичні колонки власника (`ref: "owners"`) у порядку таблиці. Помічник
 * `findStandardColumn` повертає одну колонку, а поліморфний власник — одне
 * визначення на пару `_type`, `_id` з тим самим `origin.standard`, тож тут
 * фільтр за стилізованим ім'ям визначення реєстру.
 */
function ownerColumnsOf(
  table: PhysicalTable,
  defs: readonly StandardColumnDef[],
  style: AttributeCase
): string[] {
  const logical = new Set(
    defs
      .filter((d) => d.ref === "owners")
      .map((d) => standardLogicalName(d, style))
  )
  return table.columns
    .filter((c) => logical.has(c.origin.standard ?? ""))
    .map((c) => c.name)
}

const tableKey = (t: { schema: string; name: string }) =>
  `${t.schema}.${t.name}`

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("internal: missing command input")
  return value
}
