import {
  KIND_REGISTRY,
  lineNumberColumn,
  markDeletionAction,
  predefinedNameColumn,
  standardLogicalName,
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
import { objectKey, type ParsedObject } from "../stages/files"
import { handlerAssigns } from "../stages/links"
import { kindLabelOf } from "../stages/model"

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
    }
  | {
      form: "pair"
      typeColumn: string
      idColumn: string
      array: boolean
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
  // Стилізовані імена реєстру: `origin.standard` несе логічне ім'я в стилі
  // проєкту, тож порівняння з літералом зламало б snake_case-проєкт.
  const names = {
    deletionMark: standardLogicalName(
      { logicalName: must(markDeletionAction.transition).column },
      style
    ),
    lineNumber: standardLogicalName(lineNumberColumn(), style),
    predefined: standardLogicalName(predefinedNameColumn(), style),
    version: standardLogicalName(versionColumn(), style),
  }
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

      const key = mustColumn(table, "ref")
      // Позначку пише лише `mark_deletion` (Р-A2-5), а переходи — лише
      // дія-перехід: обидва вилучаються з ключів однаково, хоч у системних
      // довідниках прав позначка й не перехід.
      const excluded = new Set([
        ...rights.transitions.map((t) => t.column),
        mustColumn(table, names.deletionMark),
      ])
      const standard = KIND_REGISTRY[object.kind].standardColumns(object.data)
      const parent = standardColumnsOf(table, standard, style, "self")[0]
      const scopeColumn = table.columns.find(
        (c) => c.origin.scopeKindId !== undefined
      )?.name
      const predefinedColumn = columnOf(table, names.predefined)
      const sectionDefs =
        KIND_REGISTRY[object.kind].tabularSectionColumns?.(object.data) ?? []
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
                  lineNumber: names.lineNumber,
                  defs: sectionDefs,
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
            ...(parent === undefined
              ? []
              : [
                  {
                    form: "single" as const,
                    column: parent,
                    target: table,
                    targetKey: key,
                    array: false,
                  },
                ]),
            ...ownerReferences(object, table, standard, style, reference),
            ...reference.attributes((object.data as Catalog).attributes, table),
          ],
          carrierLinks: links.filter(
            (l) => tableKey(l.table) === tableKey(table)
          ),
          ...(predefinedColumn === undefined ? {} : { predefinedColumn }),
          versionColumn: mustColumn(table, names.version),
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
    lineNumber: string
    defs: readonly StandardColumnDef[]
    attributes: readonly Attribute[]
    reference: ReferenceResolver
  }
): CatalogCommandSection {
  const key = mustColumn(table, "ref")
  const parent = must(
    standardColumnsOf(table, facts.defs, facts.style, "owningObject")[0]
  )
  const lineNumber = mustColumn(table, facts.lineNumber)
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
  const columns = standardColumnsOf(table, standard, style, "owners")
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
        if (attribute.ref !== undefined) {
          const target = single(attribute.ref)
          return target === undefined
            ? []
            : [{ form: "single", column: must(columns[0]), ...target, array }]
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
                targets,
              },
            ]
      }),
  }
}

/** Ключ цілі посилання: колонка `ref` виду чи єдиний первинний ключ таблиці. */
function targetKeyOf(table: PhysicalTable): string {
  const ref = columnOf(table, "ref")
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

/**
 * Фізичні колонки стандартних колонок реєстру з ціллю `ref` у порядку таблиці:
 * поліморфна колонка дає пару `_type`, `_id`.
 */
function standardColumnsOf(
  table: PhysicalTable,
  defs: readonly StandardColumnDef[],
  style: AttributeCase,
  ref: NonNullable<StandardColumnDef["ref"]>
): string[] {
  const logical = new Set(
    defs.filter((d) => d.ref === ref).map((d) => standardLogicalName(d, style))
  )
  return table.columns
    .filter((c) => logical.has(c.origin.standard ?? ""))
    .map((c) => c.name)
}

function columnOf(table: PhysicalTable, standard: string): string | undefined {
  return table.columns.find((c) => c.origin.standard === standard)?.name
}

/** Стандартна колонка, яку вид гарантує; відсутність — дефект компілятора. */
function mustColumn(table: PhysicalTable, standard: string): string {
  const name = columnOf(table, standard)
  if (name === undefined) {
    throw new Error(
      `internal: ${tableKey(table)} has no standard column ${standard}`
    )
  }
  return name
}

const tableKey = (t: { schema: string; name: string }) =>
  `${t.schema}.${t.name}`

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("internal: missing command input")
  return value
}
