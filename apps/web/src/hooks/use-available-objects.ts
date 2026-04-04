import { useMemo } from "react"
import type { MetadataKind, MetadataRef } from "@simetra/core"
import { useMetadataStore } from "@/stores/metadata-store"
import { KIND_TO_KEY } from "@/lib/metadata-defaults"

/** Хук для отримання списку доступних обʼєктів за kinds */
export function useAvailableObjects<TAllowedKind extends MetadataKind>(
  allowedKinds: readonly TAllowedKind[]
): Array<MetadataRef & { kind: TAllowedKind }> {
  const model = useMetadataStore((s) => s.model)

  return useMemo(() => {
    const result: Array<MetadataRef & { kind: TAllowedKind }> = []
    for (const kind of allowedKinds) {
      const key = KIND_TO_KEY[kind]
      const objects = model[key] as { name: string }[]
      for (const obj of objects) {
        result.push({ kind, name: obj.name })
      }
    }
    return result
  }, [model, allowedKinds])
}
