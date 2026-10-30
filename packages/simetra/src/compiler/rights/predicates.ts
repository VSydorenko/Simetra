import {
  quoteIdent,
  tabularParentColumn,
  type PhysicalTable,
} from "simetra/model"
import type {
  CarrierContract,
  OwnershipContract,
  ProjectionExtent,
  RightsContract,
} from "../contracts"
import { CURRENT_USER } from "../membership-functions"
import { COMMAND_FUNCTIONS } from "./command-units"
import { uniformExtents } from "./contracts"
import { RIGHTS_FUNCTIONS, call, uuidLiteral } from "./functions"
import { sqlLiteral } from "../stages/model"
import { must } from "./references"
import { styleFreeColumn } from "../standard-column"

/**
 * Дія контексту команди (Р2b1-5): замість літерала дії предикат кличе
 * `command_action()`, тож політики запису кореневого рядка не множаться на
 * кількість дій об'єкта.
 */
export const COMMAND_ACTION: unique symbol = Symbol("command action")

/**
 * Умова предиката прав (спека прав §5.4). `column` — `<колонка> =
 * ANY(ARRAY(SELECT <множина>))`, `grantDependent` — множина з гранту (скоупи чи
 * контейнери з правом); `currentUser` — `<колонка> = (SELECT
 * current_user_id())`; `boolean` — `(SELECT <вираз>)`, завжди з гранту.
 */
export type RightsCondition =
  | { kind: "column"; column: string; set: string; grantDependent: boolean }
  | { kind: "currentUser"; column: string }
  | { kind: "boolean"; expression: string }

/**
 * Предикат прав: AND умов, з яких рівно одна залежить від гранту. Предикати
 * однієї дії з'єднує OR — одна `PERMISSIVE`-політика на предикат (2a2).
 */
export interface RightsPredicate {
  extent: ProjectionExtent | { container: string; inner: ProjectionExtent }
  /** Колонка носія власності, виміру чи (для `any` у контейнері) прив'язки. */
  carrier?: string
  conditions: RightsCondition[]
}

/** Умова обсягу без гранту: «мій» рядок за носієм; `any` — без неї. */
interface Inner {
  extent: ProjectionExtent
  carrier?: string
  mine: RightsCondition[]
}

/**
 * Предикати дії над таблицею об'єкта (правило некорельованої форми §5.4):
 * кожна множина — функція від сталих, тож обчислюється раз на запит, а AND
 * множини з гранту й множини, що залежить лише від користувача, не дає
 * декартового добутку. На кожен підтриманий обсяг і кожен його носій — один
 * предикат на рівні скоупу (нескоуплений об'єкт — булева перевірка права) і
 * один у контейнері, якщо об'єкт до нього прив'язаний.
 *
 * Таблиця — основна, ТЧ чи похідна таблиця регістра (Р2a2-6); для двох
 * останніх `main` — основна таблиця об'єкта. Носій береться з колонки самої
 * таблиці (`carrierColumn`): політика ТЧ і похідної таблиці — та сама
 * некорельована форма, що й власника, без підзапиту до іншої таблиці (§5.2).
 */
export function rightsPredicates(
  contract: RightsContract,
  action: string | typeof COMMAND_ACTION,
  table: PhysicalTable,
  main: PhysicalTable = table
): RightsPredicate[] {
  // Дія контексту має обсяги будь-якої дії об'єкта лише тому, що набір
  // обсягів у всіх дій один (Р2b1-6): інакше політика мовчки розійшлася б з
  // правом. Вираз контексту — скалярний підзапит без посилань на рядок, тож
  // множини лишаються некорельованими (§5.4).
  const extents =
    action === COMMAND_ACTION
      ? uniformExtents(contract.actions, contract.kindLabel)
      : must(contract.actions.find((a) => a.action === action)).extents
  const F = RIGHTS_FUNCTIONS
  const head = [
    action === COMMAND_ACTION
      ? `(SELECT ${call(COMMAND_FUNCTIONS.action)})`
      : sqlLiteral(action),
    sqlLiteral(contract.kindLabel),
  ]
  const own = extents.some((e) => e.form === "own")
  const dimensions = new Set(
    extents.flatMap((e) => (e.form === "dimension" ? [e.dimensionId] : []))
  )
  const column = (carrier: CarrierContract) =>
    carrierColumn(contract, carrier, table, main)
  const inners: Inner[] = [
    { extent: "any", mine: [] },
    ...(own ? contract.ownership : []).map((carrier): Inner => ({
      extent: "own",
      carrier: column(carrier),
      mine: [ownerCondition(carrier, column(carrier))],
    })),
    ...contract.access
      .filter(({ dimensionId }) => dimensions.has(dimensionId))
      .map(({ dimensionId, carrier }): Inner => ({
        extent: { dimensionId },
        carrier: column(carrier),
        mine: [
          {
            kind: "column",
            column: column(carrier),
            set: call(F.dimensionValues, [uuidLiteral(dimensionId)]),
            grantDependent: false,
          },
        ],
      })),
  ]

  // Корінь виду скоупу несе скоуп у колонці `id`, рядок його ТЧ — у
  // `parent_id`: колонку дає модель (`origin.scopeKindId`), а не ім'я.
  const scope =
    contract.scopeKindId === undefined
      ? undefined
      : must(
          table.columns.find(
            (c) => c.origin.scopeKindId === contract.scopeKindId
          )
        ).name
  const atScope = inners.map(({ extent, carrier, mine }): RightsPredicate => {
    const grant: RightsCondition =
      scope === undefined
        ? {
            kind: "boolean",
            expression: call(F.hasRight, [...head, ...extentArgs(extent)]),
          }
        : {
            kind: "column",
            column: scope,
            set: scopeSet(extent, head),
            grantDependent: true,
          }
    return {
      extent,
      ...(carrier === undefined ? {} : { carrier }),
      conditions: [...mine, grant],
    }
  })

  const binding = contract.binding
  if (binding === undefined) return atScope
  const bound = column(binding.carrier)
  const inContainer = inners.map(
    ({ extent, carrier, mine }): RightsPredicate => ({
      extent: { container: binding.containerId, inner: extent },
      carrier: carrier ?? bound,
      conditions: [
        ...mine,
        {
          kind: "column",
          column: bound,
          set: call(F.container, [...head, ...extentArgs(extent)]),
          grantDependent: true,
        },
      ],
    })
  )
  return [...atScope, ...inContainer]
}

/**
 * Колонка таблиці з кінцевим значенням носія (Р2a2-4, Р2a2-6). Основна
 * таблиця — `value` (для шляху — його копія). ТЧ — копія з `copyOf.column ===
 * value` власника; носій-ключ (значення — сам ключ власника) копії не має, його
 * значення в ТЧ — `parent_id`. Похідна таблиця регістра — колонка з тим самим
 * `origin.elementId` (носій регістра — завжди його вимір, Р2a2-4). Колонки
 * немає — дефект моделі: краще гучна помилка, ніж мовчазний предикат на чужій
 * колонці.
 */
function carrierColumn(
  contract: RightsContract,
  carrier: CarrierContract,
  table: PhysicalTable,
  main: PhysicalTable
): string {
  const same = (t: { schema: string; name: string }) =>
    t.schema === contract.table.schema && t.name === contract.table.name
  if (same(table)) return carrier.value
  if (!same(main)) throw new Error("internal: rights predicate without main")
  if (table.origin.tabularSectionId !== undefined) {
    const copy = table.columns.find(
      (c) =>
        c.origin.copyOf !== undefined &&
        same(c.origin.copyOf.table) &&
        c.origin.copyOf.column === carrier.value
    )
    if (copy !== undefined) return copy.name
    const key = main.primaryKey?.columns
    if (key?.length === 1 && key[0] === carrier.value) {
      return styleFreeColumn(table, tabularParentColumn()).name
    }
    throw new Error(`internal: no carrier copy of ${carrier.value}`)
  }
  const elementId = must(
    main.columns.find((c) => c.name === carrier.value)?.origin.elementId
  )
  return must(table.columns.find((c) => c.origin.elementId === elementId)).name
}

/**
 * Текст умови для `USING`/`WITH CHECK` політики. `row` — змінна рядка
 * plpgsql (`v_old`, `v_new`): ядро команди перевіряє право тим самим текстом
 * над станом «до» чи «після», а не другою реалізацією формули (Р-A2-2).
 */
export function renderCondition(
  condition: RightsCondition,
  row?: string
): string {
  const at = (column: string) =>
    row === undefined ? quoteIdent(column) : `${row}.${quoteIdent(column)}`
  switch (condition.kind) {
    case "column":
      return `${at(condition.column)} = ANY (ARRAY(SELECT ${condition.set}))`
    case "currentUser":
      return `${at(condition.column)} = ${CURRENT_USER}`
    case "boolean":
      return `(SELECT ${condition.expression})`
  }
}

/**
 * «Мій» рядок за носієм власності (Р2a1-10): мої id учасника — лише свого
 * виду скоупу (Р2a1-26), бо `id` довідника задає той, хто пише; носій на
 * «Користувачів» — сам поточний користувач.
 */
function ownerCondition(
  carrier: OwnershipContract,
  column: string
): RightsCondition {
  return "users" in carrier.owner
    ? { kind: "currentUser", column }
    : {
        kind: "column",
        column,
        set: call(RIGHTS_FUNCTIONS.myMembers, [
          uuidLiteral(carrier.owner.membership),
        ]),
        grantDependent: false,
      }
}

/** Скоупи з правом в обсязі: своя функція множини на кожну форму (§5.1). */
function scopeSet(extent: ProjectionExtent, head: string[]): string {
  const F = RIGHTS_FUNCTIONS
  if (extent === "any") return call(F.any, head)
  if (extent === "own") return call(F.own, head)
  return call(F.dim, [...head, uuidLiteral(extent.dimensionId)])
}

/** Обсяг і вимір — останні аргументи `has_right` і `rights_container`. */
function extentArgs(extent: ProjectionExtent): string[] {
  return typeof extent === "string"
    ? [sqlLiteral(extent), "NULL"]
    : [sqlLiteral("dimension"), uuidLiteral(extent.dimensionId)]
}
