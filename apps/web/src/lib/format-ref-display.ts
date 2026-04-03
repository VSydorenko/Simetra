import type { Attribute } from '@simetra/core'

/** Derived display format для reference-атрибутів у таблиці та дереві */
export function formatRefDisplay(attr: Attribute): string {
  if (attr.type !== 'Ref') return attr.type

  if (attr.ref) {
    return `${attr.ref.kind}Ref.${attr.ref.name}`
  }

  if (attr.allowedTypes && attr.allowedTypes.length > 0) {
    return `AnyRef(${attr.allowedTypes.length})`
  }

  return 'Ref (не вказано)'
}
