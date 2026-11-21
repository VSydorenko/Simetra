import type { DatabaseProvider } from "simetra/model"
import {
  AUTHOR_FUNCTION,
  authorTriggerName,
  authorUpdateTriggerName,
  renderAuthorFunction,
  renderAuthorTrigger,
} from "./author-units"
import type { QualifiedName } from "./contracts"
import { hierarchyNames } from "./hierarchy-units"
import {
  KEY_COLUMN,
  KEY_FUNCTION,
  keyTriggerNames,
  renderKeyFunction,
  renderKeyTrigger,
} from "./key-units"
import {
  MECHANICS_FUNCTION,
  mechanicsTriggerName,
  mechanicsUpdateTriggerName,
  renderMechanicsFunction,
  renderMechanicsTrigger,
  type RenderedUnit,
} from "./mechanics-units"
import type { SqlParser } from "./sql/parse"
import {
  carrierFunctionNames,
  carrierTriggerNames,
} from "./rights/carrier-units"
import {
  effectsFunctionName,
  effectsTriggerNames,
} from "./rights/effects-names"
import { rightsGuardNames } from "./rights/guard-names"
import {
  rightsSignalFunctionName,
  rightsSignalTriggerNames,
} from "./rights/signal-names"

export type PlatformTriggerFamily =
  | "mechanics"
  | "author"
  | "key"
  | "carriers"
  | "hierarchy"
  | "effects"
  | "rightsGuards"
  | "rightsSignals"

export interface PlatformTrigger {
  family: PlatformTriggerFamily
  trigger: string
  function: QualifiedName
  /** Генератор одиниці тригера (`SqlUnit.generator`). */
  generator:
    | "mechanics"
    | "key"
    | "carriers"
    | "effects"
    | "rightsGuards"
    | "rightsSignal"
  /** Тригер оновлення, платформний лише з умовою змісту таблиці. */
  contentUpdate: boolean
}

/** Функції тригерів, спільні для всіх таблиць проєкту. */
export const SHARED_TRIGGER_FUNCTIONS: readonly QualifiedName[] = [
  MECHANICS_FUNCTION,
  AUTHOR_FUNCTION,
  KEY_FUNCTION,
]

/**
 * Усі платформні тригери, які може мати таблиця, з функцією, яку кожен мусить
 * кликати. Одне джерело для зворотної генерації (спека промоції §9.2),
 * промоції (§9.3) і тесту прийому з нуля: окремі переліки розходилися з
 * кожною новою механікою. Реєстр не знає, які тригери таблиця справді має, —
 * він лише впізнає їх за іменем і функцією.
 */
export function platformTriggers(table: QualifiedName): PlatformTrigger[] {
  const key = keyTriggerNames(table.name)
  const carriers = carrierTriggerNames(table)
  const carrierFns = carrierFunctionNames(table)
  const hierarchy = hierarchyNames(table)
  const effects = effectsTriggerNames(table)
  const effectsFn = effectsFunctionName(table)
  const entry = (
    family: PlatformTriggerFamily,
    generator: PlatformTrigger["generator"],
    fn: QualifiedName,
    trigger: string,
    contentUpdate = false
  ): PlatformTrigger => ({
    family,
    trigger,
    function: fn,
    generator,
    contentUpdate,
  })
  return [
    // Механіка рядка; на таблиці з копіями носіїв оновлення — окремий тригер
    // з умовою змісту (спека промоції §9.3)
    entry(
      "mechanics",
      "mechanics",
      MECHANICS_FUNCTION,
      mechanicsTriggerName(table.name)
    ),
    entry(
      "mechanics",
      "mechanics",
      MECHANICS_FUNCTION,
      mechanicsUpdateTriggerName(table.name),
      true
    ),
    // Авторство (спека П4 §6.8) — з тією самою умовою оновлення, що в механіки
    entry(
      "author",
      "mechanics",
      AUTHOR_FUNCTION,
      authorTriggerName(table.name)
    ),
    entry(
      "author",
      "mechanics",
      AUTHOR_FUNCTION,
      authorUpdateTriggerName(table.name),
      true
    ),
    // Незмінність ключа (спека прав §7)
    entry("key", "key", KEY_FUNCTION, key.before),
    entry("key", "key", KEY_FUNCTION, key.after),
    // Копії носіїв (спека промоції §9.3): прийнятого тригера вони не
    // замінюють, навіть коли той кличе функцію з тим самим іменем
    entry("carriers", "carriers", carrierFns.derive, carriers.derive),
    entry("carriers", "carriers", carrierFns.propagate, carriers.propagate),
    entry(
      "carriers",
      "carriers",
      carrierFns.propagate,
      carriers.propagateInsert
    ),
    // Ієрархія (спека П4 §6.6): обидва тригери кличуть одну функцію таблиці
    entry("hierarchy", "mechanics", hierarchy.fn, hierarchy.insert),
    entry("hierarchy", "mechanics", hierarchy.fn, hierarchy.update),
    // Ефекти дії (спека прав §5.3): одна функція таблиці на обидва тригери
    entry("effects", "effects", effectsFn, effects.all),
    entry("effects", "effects", effectsFn, effects.update),
    ...rightsGuardNames(table).map((guard) =>
      entry("rightsGuards", "rightsGuards", guard.function, guard.trigger)
    ),
    // Сигнали прав таблиці фактів (спека П4-B §8.2): одна функція таблиці
    ...rightsSignalTriggerNames(table).map(({ trigger }) =>
      entry(
        "rightsSignals",
        "rightsSignal",
        rightsSignalFunctionName(table),
        trigger
      )
    ),
  ]
}

/**
 * Шар, що не залежить від моделі, для таблиці: спільні функції механіки,
 * авторства й ключа з їхніми грантами та тригери цих родин у формі без
 * `WHEN` змісту (таблиця без копій носіїв). Той самий текст, що кладуть
 * `build*Units`, — еталон зворотної генерації не має другої копії.
 * Варіанти з `WHEN` залежать від копій носіїв моделі й сюди не входять.
 * Чи таблиця має колонки, яких вимагає тригер, вирішує споживач.
 */
export function renderModelIndependentLayer(
  table: QualifiedName,
  provider: DatabaseProvider,
  parse: SqlParser
): RenderedUnit[] {
  const key = keyTriggerNames(table.name)
  return [
    ...renderSharedTriggerFunctions(provider, parse),
    renderMechanicsTrigger(
      table,
      mechanicsTriggerName(table.name),
      "INSERT OR UPDATE",
      parse
    ),
    renderAuthorTrigger(
      table,
      authorTriggerName(table.name),
      "INSERT OR UPDATE",
      parse
    ),
    renderKeyTrigger(table, key.before, "BEFORE", KEY_COLUMN, parse),
    renderKeyTrigger(table, key.after, "AFTER", KEY_COLUMN, parse),
  ]
}

/**
 * Спільні функції механіки, авторства й ключа з їхніми грантами: частина
 * шару, що не залежить ні від моделі, ні від таблиці, — еталон зворотної
 * генерації бере її й без жодного тригера.
 */
export function renderSharedTriggerFunctions(
  provider: DatabaseProvider,
  parse: SqlParser
): RenderedUnit[] {
  return [
    ...renderMechanicsFunction(provider, parse),
    ...renderAuthorFunction(provider, parse),
    ...renderKeyFunction(provider, parse),
  ]
}
