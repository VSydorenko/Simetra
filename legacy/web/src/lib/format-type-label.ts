import type { TFunction } from "i18next"

interface TypeLabelSource {
  type: string
  ref?: { name: string }
  allowedTypes?: Array<{ name: string }>
}

/**
 * User-facing локалізований формат типу атрибута.
 * formatRefDisplay залишається для технічного display (tree field nodes).
 */
export function formatTypeLabel(source: TypeLabelSource, t: TFunction): string {
  if (source.type !== "Ref") {
    return t(`fieldType.${source.type}`)
  }

  if (source.ref) {
    return `${t("fieldType.Ref")}: ${source.ref.name}`
  }

  if (source.allowedTypes && source.allowedTypes.length > 0) {
    const targetNames = source.allowedTypes.map(({ name }) => name).join(", ")

    return `${t("fieldType.Ref")}: ${targetNames}`
  }

  return t("fieldType.Ref")
}
