import type { MetadataKind, MetadataRef, ProjectModel } from "@simetra/core"
import { KIND_TO_KEY } from "@/lib/metadata-defaults"

/** Обчислює kindCheckedStates для checkbox mode у tree selector */
export function computeKindCheckedStates(
  model: ProjectModel,
  allowedKinds: readonly MetadataKind[],
  selectedRefs: MetadataRef[]
): Record<string, boolean | "indeterminate"> {
  const states: Record<string, boolean | "indeterminate"> = {}
  for (const k of allowedKinds) {
    const modelKey = KIND_TO_KEY[k]
    const objects = (model[modelKey] as { name: string }[]) ?? []
    if (objects.length === 0) {
      states[k] = false
      continue
    }
    const selectedCount = objects.filter((obj) =>
      selectedRefs.some((ref) => ref.kind === k && ref.name === obj.name)
    ).length
    if (selectedCount === 0) states[k] = false
    else if (selectedCount === objects.length) states[k] = true
    else states[k] = "indeterminate"
  }
  return states
}
