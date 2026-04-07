import type { Attribute } from '@simetra/core'

// Тип компонента для рендерингу поля форми
export type FieldComponentType =
  | 'input'
  | 'textarea'
  | 'number-input'
  | 'switch'
  | 'date-picker'
  | 'datetime-picker'
  | 'enum-select'
  | 'catalog-combobox'
  | 'document-combobox'
  | 'polymorphic-ref-placeholder'
  | 'uuid-input'
  | 'binary-placeholder'

export interface FieldMappingResult {
  component: FieldComponentType
  props: Record<string, unknown>
}

// Поріг довжини для String -> Textarea
const STRING_TEXTAREA_THRESHOLD = 255

export function resolveFieldComponent(attr: Attribute): FieldMappingResult {
  switch (attr.type) {
    case 'String':
      if (attr.length && attr.length > STRING_TEXTAREA_THRESHOLD) {
        return { component: 'textarea', props: {} }
      }
      return { component: 'input', props: { type: 'text' } }

    case 'Text':
      return { component: 'textarea', props: {} }

    case 'Integer':
      return { component: 'number-input', props: { step: 1 } }

    case 'Numeric':
      return {
        component: 'number-input',
        props: {
          step: attr.scale != null ? Math.pow(10, -attr.scale) : 0.01,
        },
      }

    case 'Boolean':
      return { component: 'switch', props: {} }

    case 'Date':
      return { component: 'date-picker', props: {} }

    case 'DateTime':
      return { component: 'datetime-picker', props: {} }

    case 'UUID':
      return { component: 'uuid-input', props: { readOnly: true } }

    case 'Binary':
      return { component: 'binary-placeholder', props: {} }

    case 'Ref': {
      // Polymorphic ref
      if (attr.allowedTypes && attr.allowedTypes.length > 0) {
        return { component: 'polymorphic-ref-placeholder', props: {} }
      }
      // Single ref
      if (attr.ref) {
        switch (attr.ref.kind) {
          case 'Enumeration':
            return { component: 'enum-select', props: { enumRef: attr.ref } }
          case 'Catalog':
            return {
              component: 'catalog-combobox',
              props: { targetRef: attr.ref },
            }
          case 'Document':
            return {
              component: 'document-combobox',
              props: { targetRef: attr.ref },
            }
        }
      }
      // Ref без цільового об'єкта — fallback
      return { component: 'input', props: { type: 'text', readOnly: true } }
    }
  }
}
