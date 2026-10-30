import {
  AUTHOR_FUNCTION,
  authorTriggerName,
  authorUpdateTriggerName,
} from "./author-units"
import type { QualifiedName } from "./contracts"
import { hierarchyNames } from "./hierarchy-units"
import { KEY_FUNCTION, keyTriggerNames } from "./key-units"
import {
  MECHANICS_FUNCTION,
  mechanicsTriggerName,
  mechanicsUpdateTriggerName,
} from "./mechanics-units"
import {
  carrierFunctionNames,
  carrierTriggerNames,
} from "./rights/carrier-units"
import {
  effectsFunctionName,
  effectsTriggerNames,
} from "./rights/effects-names"
import { rightsGuardNames } from "./rights/guard-names"

export type PlatformTriggerFamily =
  | "mechanics"
  | "author"
  | "key"
  | "carriers"
  | "hierarchy"
  | "effects"
  | "rightsGuards"

export interface PlatformTrigger {
  family: PlatformTriggerFamily
  trigger: string
  function: QualifiedName
  /** Генератор одиниці тригера (`SqlUnit.generator`). */
  generator: "mechanics" | "key" | "carriers" | "effects" | "rightsGuards"
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
  ]
}
