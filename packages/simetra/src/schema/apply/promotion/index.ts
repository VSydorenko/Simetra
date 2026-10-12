export {
  promotionTransition,
  type PromotionInput,
  type TransitionVerdict,
} from "./transition"
export { renameIntent, withTempNames, type RenameIntent } from "./intent"
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
