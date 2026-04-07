import type { Attribute, StandardAttribute } from '@simetra/core'

/**
 * Визначити реальне ім'я колонки для кастомного атрибута (з урахуванням _id суфікса).
 * - Polymorphic Ref (allowedTypes) → [name_type, name_id]
 * - Single Ref (не enum) → [name_id]
 * - Enum Ref → [name] (без суфікса)
 * - Все інше → [name]
 */
export function resolveColumnName(
  attr: Attribute,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
): string[] {
  if (attr.type === 'Ref' && attr.allowedTypes?.length) {
    return [`${attr.name}_type`, `${attr.name}_id`]
  }
  if (attr.type === 'Ref' && attr.ref) {
    const isEnumRef = resolveEnumType(attr.ref) != null
    return [isEnumRef ? attr.name : `${attr.name}_id`]
  }
  return [attr.name]
}

/**
 * Визначити реальне ім'я колонки для стандартного реквізиту.
 * - Polymorphic Ref (allowedTypes) → [name_type, name_id]
 * - Single Ref → [name] (стандартні імена вже канонічно містять _id)
 * - Все інше → [name]
 */
export function resolveStdColumnName(attr: StandardAttribute): string[] {
  if (attr.type === 'Ref' && attr.allowedTypes?.length) {
    return [`${attr.name}_type`, `${attr.name}_id`]
  }
  if (attr.type === 'Ref' && attr.ref) {
    return [`${attr.name}`]
  }
  return [attr.name]
}
