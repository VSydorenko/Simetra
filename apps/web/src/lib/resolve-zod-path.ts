import type { MetadataObject } from '@simetra/core'

/** Перетворює Zod index-based path [attributes, 0, name] → "attributes.AttrName.name" */
export function resolveZodPath(obj: MetadataObject, issuePath: (string | number)[]): string {
  const parts: string[] = []
  let current: unknown = obj
  let insideTabularSection = false
  for (const segment of issuePath) {
    if (typeof segment === 'number' && Array.isArray(current)) {
      const item = current[segment] as { name?: string } | undefined
      parts.push(item?.name ?? String(segment))
      // TabularSection має attributes + name, але не має kind (на відміну від MetadataObject)
      insideTabularSection = !!(
        item &&
        typeof item === 'object' &&
        'attributes' in item &&
        !('kind' in item)
      )
      current = item
    } else if (insideTabularSection && segment === 'attributes') {
      // Пропускаємо проміжний 'attributes' всередині tabularSection
      // щоб зберегти формат tabularSections.SecName.AttrName
      insideTabularSection = false
      if (current && typeof current === 'object') {
        current = (current as Record<string, unknown>).attributes
      }
    } else {
      parts.push(String(segment))
      insideTabularSection = false
      if (current && typeof current === 'object') {
        current = (current as Record<string, unknown>)[String(segment)]
      }
    }
  }
  return parts.join('.')
}
