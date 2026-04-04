import type { TFunction } from 'i18next'
import type { Attribute } from '@simetra/core'

/**
 * User-facing локалізований формат типу атрибута.
 * formatRefDisplay залишається для технічного display (tree field nodes).
 */
export function formatTypeLabel(attr: Attribute, t: TFunction): string {
  if (attr.type !== 'Ref') {
    return t(`fieldType.${attr.type}`)
  }

  if (attr.ref) {
    return `${t('fieldType.Ref')}: ${attr.ref.name}`
  }

  if (attr.allowedTypes && attr.allowedTypes.length > 0) {
    return `${t('fieldType.Ref')} (${attr.allowedTypes.length})`
  }

  return t('fieldType.Ref')
}
