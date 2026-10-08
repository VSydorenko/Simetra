import type { CustomTable } from "../schemas/custom-table"
import type { MetadataKind } from "../schemas/metadata-kind"
import { accumulationRegisterKind } from "./accumulation-register"
import { catalogKind } from "./catalog"
import { constantKind } from "./constant"
import {
  customTableKind,
  isUuidColumn,
  singleUuidKeyColumn,
} from "./custom-table"
import { documentKind } from "./document"
import { enumerationKind } from "./enumeration"
import { eventSubscriptionKind } from "./event-subscription"
import { informationRegisterKind } from "./information-register"
import { pgEnumKind } from "./pg-enum"
import type { KindDefinition } from "./standard"

export { isUuidColumn, singleUuidKeyColumn }

export {
  monthColumn,
  singletonColumn,
  standardLogicalName,
  type FoundElementReference,
  type FoundReference,
  type KindDefinition,
  type NumberingSpec,
  type ReferenceRole,
  type RegisterKeySpec,
  type StandardColumnDef,
  type SubscriptionSpec,
  type VirtualTableKind,
  type WritePattern,
} from "./standard"

/**
 * Єдине місце знань про вид (спека П2 §8.1): кожне розгалуження за видом
 * читає цей запис, а новий вид — це новий запис плюс тести. Порядок ключів —
 * порядок METADATA_KINDS.
 */
export const KIND_REGISTRY: Readonly<Record<MetadataKind, KindDefinition>> = {
  Catalog: catalogKind,
  Document: documentKind,
  Enumeration: enumerationKind,
  InformationRegister: informationRegisterKind,
  AccumulationRegister: accumulationRegisterKind,
  Constant: constantKind,
  CustomTable: customTableKind,
  PgEnum: pgEnumKind,
  EventSubscription: eventSubscriptionKind,
}

const KINDS_BY_DIR = new Map(
  Object.values(KIND_REGISTRY).map((def) => [def.dir, def])
)

/** Вид за текою `metadata/<тека>/`: тека задає очікуваний вид файлу. */
export function kindByDir(dir: string): KindDefinition | undefined {
  return KINDS_BY_DIR.get(dir)
}

/** Дія виду, що пише рухи: документ, який проводиться. */
const POST_ACTION = "post"

/**
 * Чи вид проводиться (пише рухи в регістри). Факт реєстру, що його читають і
 * перевірка реєстратора, і розбір `.sql`, тож назви дії ніхто не дублює.
 */
export function postsMovements(kind: MetadataKind): boolean {
  return KIND_REGISTRY[kind].actions.includes(POST_ACTION)
}

/**
 * Чи очікується в об'єкта мітка виду: вид її має (факт реєстру), а прийнята
 * таблиця — лише з єдиним uuid-ключем, бо без нього на неї не посилається
 * жодна `Ref`-пара й мітці нема що розрізняти.
 */
export function expectsKindLabel(kind: MetadataKind, data: unknown): boolean {
  const def = KIND_REGISTRY[kind]
  if (def.kindLabel !== true) return false
  if (!def.declared) return true
  const table = data as Partial<CustomTable>
  return (
    Array.isArray(table.columns) &&
    singleUuidKeyColumn(table as CustomTable) !== undefined
  )
}
