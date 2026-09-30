import type { MetadataKind } from "../schemas/metadata-kind"
import { accumulationRegisterKind } from "./accumulation-register"
import { catalogKind } from "./catalog"
import { constantKind } from "./constant"
import { customTableKind } from "./custom-table"
import { documentKind } from "./document"
import { enumerationKind } from "./enumeration"
import { informationRegisterKind } from "./information-register"
import { pgEnumKind } from "./pg-enum"
import type { KindDefinition } from "./standard"

export {
  singletonColumn,
  standardLogicalName,
  type FoundReference,
  type KindDefinition,
  type ReferenceRole,
  type RegisterKeySpec,
  type StandardColumnDef,
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
}

const KINDS_BY_DIR = new Map(
  Object.values(KIND_REGISTRY).map((def) => [def.dir, def])
)

/** Вид за текою `metadata/<тека>/`: тека задає очікуваний вид файлу. */
export function kindByDir(dir: string): KindDefinition | undefined {
  return KINDS_BY_DIR.get(dir)
}
