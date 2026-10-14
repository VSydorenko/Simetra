export {
  foreignSequenceRefusals,
  promotionTransition,
  type PromotionInput,
  type TransitionVerdict,
} from "./transition"
export { renameIntent, withTempNames, type RenameIntent } from "./intent"
export {
  castProbeQuery,
  preservationPlan,
  preservationQuery,
} from "./preservation"
export {
  canonicalRenames,
  readEquivalenceObjects,
  type EquivalenceObject,
} from "./equivalence"
export {
  adoptedReplacements,
  classifyRemovals,
  stepConversions,
  unclassifiedRemovals,
  unrealizedRenames,
  type Removal,
  type RemovalCover,
} from "./removals"
export {
  accessChanges,
  promotionPermissionItems,
  readAccessDependents,
  type AccessChange,
} from "./access"
export { readWritePath, type WritePath } from "./write-path"
export { readReservedNames } from "./reserved-names"
export {
  platformReplacements,
  propertyReproductions,
  valueElementColumns,
  type ColumnName,
} from "./replacements"
export type { CanonicalRename } from "./equivalence"
