import type { Attribute, Document, FieldType } from "@simetra/core"
import {
  getStandardAttributes,
  getTabularSectionStandardAttributes,
} from "@simetra/core"
import i18n from "@/i18n"

type StandardLikeField = {
  name: string
  type: string
  ref?: Attribute["ref"]
  allowedTypes?: Attribute["allowedTypes"]
}

type KnownField = {
  name: string
  type: FieldType
  ref?: Attribute["ref"]
  allowedTypes?: Attribute["allowedTypes"]
}

export interface ExpressionValidationContext {
  source: string
  document: Pick<Document, "attributes" | "tabularSections">
}

function normalizeFieldType(type: string): FieldType | null {
  if (
    type === "UUID" ||
    type === "String" ||
    type === "Text" ||
    type === "Integer" ||
    type === "Numeric" ||
    type === "Boolean" ||
    type === "Date" ||
    type === "DateTime" ||
    type === "Binary" ||
    type === "Ref"
  ) {
    return type
  }

  if (type.startsWith("Enum(")) {
    return "String"
  }

  return null
}

function toKnownField(field: Attribute | StandardLikeField): KnownField | null {
  const normalizedType = normalizeFieldType(field.type)
  if (!normalizedType) {
    return null
  }

  return {
    name: field.name,
    type: normalizedType,
    ref: field.ref,
    allowedTypes: field.allowedTypes,
  }
}

function getDocumentFields(document: Pick<Document, "attributes">): KnownField[] {
  return [
    ...getStandardAttributes("Document")
      .filter((attr) => attr.name !== "id")
      .map(toKnownField)
      .filter((field): field is KnownField => field !== null),
    ...document.attributes.map((attr) => toKnownField(attr)).filter(
      (field): field is KnownField => field !== null
    ),
  ]
}

function getTabularSectionFields(
  document: Pick<Document, "tabularSections">,
  source: string
): KnownField[] {
  if (!source.startsWith("tabularSection:")) {
    return []
  }

  const tabularSectionName = source.slice("tabularSection:".length)
  const section = document.tabularSections.find(
    (candidate) => candidate.name === tabularSectionName
  )
  if (!section) {
    return []
  }

  return [
    ...getTabularSectionStandardAttributes()
      .filter((attr) => attr.name !== "id")
      .map(toKnownField)
      .filter((field): field is KnownField => field !== null),
    ...section.attributes.map((attr) => toKnownField(attr)).filter(
      (field): field is KnownField => field !== null
    ),
  ]
}

export function findDocumentField(
  document: Pick<Document, "attributes">,
  fieldName: string
): KnownField | undefined {
  return getDocumentFields(document).find((field) => field.name === fieldName)
}

export function findTabularSectionField(
  document: Pick<Document, "tabularSections">,
  source: string,
  fieldName: string
): KnownField | undefined {
  return getTabularSectionFields(document, source).find(
    (field) => field.name === fieldName
  )
}

/**
 * Перевіряє чи вираз невалідний для поточного джерела.
 * row.* не можна використовувати в document source,
 * sum()/count() не можна використовувати в TS source.
 */
export function isExpressionInvalid(expr: string, source: string): boolean {
  if (!expr) return false
  const isDocSource = source === "document"
  if (isDocSource && /\brow\.\w+/.test(expr)) return true
  if (!isDocSource && /^(sum|count)\(/.test(expr)) return true
  return false
}

export function inferExpressionType(
  expr: string,
  context: ExpressionValidationContext
): KnownField | null {
  if (!expr) return null

  if (expr === "now()") {
    return { name: "now()", type: "DateTime" }
  }

  if (/^count\(\w+\)$/.test(expr)) {
    return { name: "count()", type: "Integer" }
  }

  if (/^sum\(\w+\.\w+\)$/.test(expr)) {
    return { name: "sum()", type: "Numeric" }
  }

  if (/^row\.\w+(\s*[+\-*/]\s*row\.\w+)+$/.test(expr)) {
    return { name: "row-expression", type: "Numeric" }
  }

  if (expr.startsWith("doc.")) {
    return findDocumentField(context.document, expr.slice(4)) ?? null
  }

  if (expr.startsWith("row.")) {
    return (
      findTabularSectionField(context.document, context.source, expr.slice(4)) ??
      null
    )
  }

  return null
}

export function isExpressionTypeCompatible(
  expressionType: FieldType,
  targetType: FieldType
): boolean {
  if (expressionType === targetType) {
    return true
  }

  if (expressionType === "Integer" && targetType === "Numeric") {
    return true
  }

  if (expressionType === "Date" && targetType === "DateTime") {
    return true
  }

  return false
}

export function isExpressionSuggestionRelevant(
  expressionType: FieldType,
  targetType: FieldType
): boolean {
  if (isExpressionTypeCompatible(expressionType, targetType)) {
    return true
  }

  if (
    (expressionType === "String" && targetType === "Text") ||
    (expressionType === "Text" && targetType === "String")
  ) {
    return true
  }

  if (expressionType === "DateTime" && targetType === "Date") {
    return true
  }

  return false
}

export function canUseLiteralExpression(targetField: Attribute): boolean {
  return targetField.type !== "Ref" && targetField.type !== "Binary"
}

function isLiteralCompatible(value: string, targetType: FieldType): boolean {
  switch (targetType) {
    case "String":
    case "Text":
      return true
    case "Integer":
      return /^-?\d+$/.test(value)
    case "Numeric":
      return /^-?\d+(\.\d+)?$/.test(value)
    case "Boolean":
      return /^(true|false)$/i.test(value)
    case "UUID":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value
      )
    case "Date":
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    case "DateTime":
      return !Number.isNaN(Date.parse(value))
    case "Binary":
    case "Ref":
      return false
  }
}

export function validateExpressionCompatibility(
  expr: string,
  targetField: Attribute,
  context: ExpressionValidationContext
): string | null {
  if (!expr) {
    return null
  }

  if (expr.startsWith("literal:")) {
    const literalValue = expr.slice("literal:".length)
    if (!canUseLiteralExpression(targetField)) {
      return i18n.t("validation.expression.literalUnsupported", {
        type: targetField.type,
      })
    }

    if (isLiteralCompatible(literalValue, targetField.type)) {
      return null
    }

    return i18n.t("validation.expression.literalIncompatible", {
      value: literalValue,
      type: targetField.type,
    })
  }

  const inferredType = inferExpressionType(expr, context)
  if (!inferredType) {
    return null
  }

  if (isExpressionTypeCompatible(inferredType.type, targetField.type)) {
    return null
  }

  return i18n.t("validation.expression.typeMismatch", {
    expressionType: inferredType.type,
    targetType: targetField.type,
  })
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
  allTabularSections?: { name: string; attributes: Attribute[] }[]
): string | null {
  if (!expr) return null

  const docStdAttrs = getStandardAttributes("Document")
  for (const docFieldMatch of expr.matchAll(/\bdoc\.(\w+)/g)) {
    const fieldName = docFieldMatch[1]
    const exists =
      docStdAttrs.some((a) => a.name !== "id" && a.name === fieldName) ||
      docAttributes.some((a) => a.name === fieldName)
    if (!exists) {
      return i18n.t("validation.expression.documentFieldMissing", {
        fieldName,
      })
    }
  }

  if (source.startsWith("tabularSection:") && tabularSectionAttributes) {
    const tsStdAttrs = getTabularSectionStandardAttributes()
    for (const rowFieldMatch of expr.matchAll(/\brow\.(\w+)/g)) {
      const fieldName = rowFieldMatch[1]
      const exists =
        tsStdAttrs.some((a) => a.name !== "id" && a.name === fieldName) ||
        tabularSectionAttributes.some((a) => a.name === fieldName)
      if (!exists) {
        return i18n.t("validation.expression.rowFieldMissing", { fieldName })
      }
    }
  }

  const sumMatch = expr.match(/^sum\((\w+)\.(\w+)\)$/)
  if (sumMatch && allTabularSections) {
    const [, tsName, fieldName] = sumMatch
    const ts = allTabularSections.find((t) => t.name === tsName)
    if (!ts) {
      return i18n.t("validation.expression.tabularSectionMissing", {
        name: tsName,
      })
    }
    const tsStdAttrs = getTabularSectionStandardAttributes()
    const exists =
      tsStdAttrs.some((a) => a.name !== "id" && a.name === fieldName) ||
      ts.attributes.some((a) => a.name === fieldName)
    if (!exists) {
      return i18n.t("validation.expression.tabularSectionFieldMissing", {
        tabularSection: tsName,
        fieldName,
      })
    }
  }

  const countMatch = expr.match(/^count\((\w+)\)$/)
  if (countMatch && allTabularSections) {
    const [, tsName] = countMatch
    const ts = allTabularSections.find((t) => t.name === tsName)
    if (!ts) {
      return i18n.t("validation.expression.tabularSectionMissing", {
        name: tsName,
      })
    }
  }

  return null
}
