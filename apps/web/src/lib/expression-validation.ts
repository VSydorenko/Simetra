import type { Attribute } from '@simetra/core'
import {
  getStandardAttributes,
  getTabularSectionStandardAttributes,
} from '@simetra/core'

/**
 * Перевіряє чи вираз невалідний для поточного джерела.
 * row.* не можна використовувати в document source,
 * sum()/count() не можна використовувати в TS source.
 */
export function isExpressionInvalid(expr: string, source: string): boolean {
  if (!expr) return false
  const isDocSource = source === 'document'
  // row.* тільки для tabularSection
  if (isDocSource && /\brow\.\w+/.test(expr)) return true
  // sum()/count() тільки для document source
  if (!isDocSource && /^(sum|count)\(/.test(expr)) return true
  return false
}

/**
 * Валідує посилання на поля у виразах маппінгу.
 * Перевіряє що doc.field та row.field реально існують в документі/ТЧ.
 * Для агрегатів sum(ts.field) / count(ts) перевіряє існування ТЧ та полів.
 */
export function validateExpressionFields(
  expr: string,
  source: string,
  docAttributes: Attribute[],
  tabularSectionAttributes?: Attribute[],
  allTabularSections?: { name: string; attributes: Attribute[] }[],
): string | null {
  if (!expr) return null

  // Перевірка doc.field
  const docFieldMatch = expr.match(/\bdoc\.(\w+)/)
  if (docFieldMatch) {
    const fieldName = docFieldMatch[1]
    const docStdAttrs = getStandardAttributes('Document')
    const exists =
      docStdAttrs.some((a) => a.name !== 'id' && a.name === fieldName) ||
      docAttributes.some((a) => a.name === fieldName)
    if (!exists) return `Поле doc.${fieldName} не існує в документі`
  }

  // Перевірка row.field (тільки для TS source)
  if (source.startsWith('tabularSection:') && tabularSectionAttributes) {
    const rowFieldMatch = expr.match(/\brow\.(\w+)/)
    if (rowFieldMatch) {
      const fieldName = rowFieldMatch[1]
      const tsStdAttrs = getTabularSectionStandardAttributes()
      const exists =
        tsStdAttrs.some((a) => a.name !== 'id' && a.name === fieldName) ||
        tabularSectionAttributes.some((a) => a.name === fieldName)
      if (!exists) return `Поле row.${fieldName} не існує в ТЧ`
    }
  }

  // Перевірка sum(tsName.fieldName) — ТЧ і поле мають існувати
  const sumMatch = expr.match(/^sum\((\w+)\.(\w+)\)$/)
  if (sumMatch && allTabularSections) {
    const [, tsName, fieldName] = sumMatch
    const ts = allTabularSections.find((t) => t.name === tsName)
    if (!ts) return `Таблична частина ${tsName} не існує`
    const tsStdAttrs = getTabularSectionStandardAttributes()
    const exists =
      tsStdAttrs.some((a) => a.name !== 'id' && a.name === fieldName) ||
      ts.attributes.some((a) => a.name === fieldName)
    if (!exists) return `Поле ${tsName}.${fieldName} не існує в ТЧ`
  }

  // Перевірка count(tsName) — ТЧ має існувати
  const countMatch = expr.match(/^count\((\w+)\)$/)
  if (countMatch && allTabularSections) {
    const [, tsName] = countMatch
    const ts = allTabularSections.find((t) => t.name === tsName)
    if (!ts) return `Таблична частина ${tsName} не існує`
  }

  return null
}
