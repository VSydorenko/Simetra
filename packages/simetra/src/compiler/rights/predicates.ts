import { quoteIdent, type PhysicalTable } from "simetra/model"
import type {
  CarrierContract,
  OwnershipContract,
  ProjectionExtent,
  RightsContract,
} from "../contracts"
import { CURRENT_USER } from "../membership-functions"
import { RIGHTS_FUNCTIONS, call, literal, uuidLiteral } from "./functions"
import { must } from "./references"

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
 * Предикати дії над основною таблицею (правило некорельованої форми §5.4):
 * кожна множина — функція від сталих, тож обчислюється раз на запит, а AND
 * множини з гранту й множини, що залежить лише від користувача, не дає
 * декартового добутку. На кожен підтриманий обсяг і кожен його носій — один
 * предикат на рівні скоупу (нескоуплений об'єкт — булева перевірка права) і
 * один у контейнері, якщо об'єкт до нього прив'язаний.
 *
 * Носій зі шляхом (Рх21) предиката тут не отримує: у 2a2 будівник бере
 * `CarrierContract.value` — копію шляху в основній таблиці (план 2a2,
 * Р2a2-6); до того без предиката рядок лише не відкривається цим обсягом
 * (fail-closed).
 */
export function rightsPredicates(
  contract: RightsContract,
  action: string,
  table: PhysicalTable
): RightsPredicate[] {
  const { extents } = must(contract.actions.find((a) => a.action === action))
  const F = RIGHTS_FUNCTIONS
  const head = [literal(action), literal(contract.kindLabel)]
  const own = extents.some((e) => e.form === "own")
  const dimensions = new Set(
    extents.flatMap((e) => (e.form === "dimension" ? [e.dimensionId] : []))
  )
  const inners: Inner[] = [
    { extent: "any", mine: [] },
    ...(own ? direct(contract.ownership) : []).map((carrier): Inner => ({
      extent: "own",
      carrier: carrier.column,
      mine: [ownerCondition(carrier)],
    })),
    ...contract.access
      .filter(
        ({ dimensionId, carrier }) =>
          dimensions.has(dimensionId) && carrier.via === undefined
      )
      .map(({ dimensionId, carrier }): Inner => ({
        extent: { dimensionId },
        carrier: carrier.column,
        mine: [
          {
            kind: "column",
            column: carrier.column,
            set: call(F.dimensionValues, [uuidLiteral(dimensionId)]),
            grantDependent: false,
          },
        ],
      })),
  ]

  // Корінь виду скоупу несе скоуп у колонці `id`: колонку дає модель
  // (`origin.scopeKindId`), а не ім'я.
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
  // Прив'язка зі шляхом — до `CarrierContract.value` у 2a2 (Р2a2-6).
  if (binding === undefined || binding.carrier.via !== undefined) return atScope
  const inContainer = inners.map(
    ({ extent, carrier, mine }): RightsPredicate => ({
      extent: { container: binding.containerId, inner: extent },
      carrier: carrier ?? binding.carrier.column,
      conditions: [
        ...mine,
        {
          kind: "column",
          column: binding.carrier.column,
          set: call(F.container, [...head, ...extentArgs(extent)]),
          grantDependent: true,
        },
      ],
    })
  )
  return [...atScope, ...inContainer]
}

/** Текст умови для `USING`/`WITH CHECK` політики. */
export function renderCondition(condition: RightsCondition): string {
  switch (condition.kind) {
    case "column":
      return `${quoteIdent(condition.column)} = ANY (ARRAY(SELECT ${condition.set}))`
    case "currentUser":
      return `${quoteIdent(condition.column)} = ${CURRENT_USER}`
    case "boolean":
      return `(SELECT ${condition.expression})`
  }
}

/** Носії без шляху; шлях — через `CarrierContract.value` у 2a2 (Р2a2-6). */
function direct<T extends CarrierContract>(carriers: readonly T[]): T[] {
  return carriers.filter((c) => c.via === undefined)
}

/**
 * «Мій» рядок за носієм власності (Р2a1-10): мої id учасника — лише свого
 * виду скоупу (Р2a1-26), бо `id` довідника задає той, хто пише; носій на
 * «Користувачів» — сам поточний користувач.
 */
function ownerCondition(carrier: OwnershipContract): RightsCondition {
  return "users" in carrier.owner
    ? { kind: "currentUser", column: carrier.column }
    : {
        kind: "column",
        column: carrier.column,
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
    ? [literal(extent), "NULL"]
    : [literal("dimension"), uuidLiteral(extent.dimensionId)]
}
