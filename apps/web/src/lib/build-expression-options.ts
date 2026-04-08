import {
  getStandardAttributes,
  getTabularSectionStandardAttributes,
  type Attribute,
  type Document,
} from "@simetra/core"
import {
  canUseLiteralExpression,
  inferExpressionType,
  isExpressionSuggestionRelevant,
  type ExpressionValidationContext,
} from "@/lib/expression-validation"

export interface ExpressionOption {
  value: string
  label: string
}

export interface ExpressionOptionGroup {
  group: string
  options: ExpressionOption[]
}

/**
 * Будує опції виразів для маппінгу полів document → register.
 * Динамічно перезбирається при зміні source.
 *
 * @param document — метадані документа
 * @param source — "document" або "tabularSection:{name}"
 * @param t — функція локалізації (ключ → текст)
 */
export function buildExpressionOptions(
  document: Document,
  source: string,
  targetField: Attribute,
  t: (key: string, options?: Record<string, unknown>) => string
): ExpressionOptionGroup[] {
  const groups: ExpressionOptionGroup[] = []
  const context: ExpressionValidationContext = {
    source,
    document,
  }

  const isTabularSection = source.startsWith("tabularSection:")
  const tsName = isTabularSection ? source.replace("tabularSection:", "") : null

  const shouldIncludeExpression = (expression: string): boolean => {
    if (expression === "literal:") {
      return canUseLiteralExpression(targetField)
    }

    if (expression === "now()") {
      return targetField.type === "Date" || targetField.type === "DateTime"
    }

    const inferredType = inferExpressionType(expression, context)
    if (!inferredType) {
      return true
    }

    return isExpressionSuggestionRelevant(inferredType.type, targetField.type)
  }

  if (isTabularSection && tsName) {
    // Рядок ТЧ — row.{field}
    const ts = document.tabularSections.find((s) => s.name === tsName)
    if (ts) {
      const rowOptions: ExpressionOption[] = []

      // Стандартні реквізити ТЧ
      const tsStandard = getTabularSectionStandardAttributes()
      for (const attr of tsStandard) {
        if (attr.name === "id") continue
        const expression = `row.${attr.name}`
        if (shouldIncludeExpression(expression)) {
          rowOptions.push({
            value: expression,
            label: expression,
          })
        }
      }

      // Користувацькі реквізити ТЧ
      for (const attr of ts.attributes) {
        const expression = `row.${attr.name}`
        if (shouldIncludeExpression(expression)) {
          rowOptions.push({
            value: expression,
            label: expression,
          })
        }
      }

      if (rowOptions.length > 0) {
        groups.push({
          group: t("expression.tsRow", { name: tsName }),
          options: rowOptions,
        })
      }
    }

    // Документ — doc.{field} (стандартні + custom)
    const docOptions: ExpressionOption[] = []
    const docStandard = getStandardAttributes("Document")
    for (const attr of docStandard) {
      if (attr.name === "id") continue
      const expression = `doc.${attr.name}`
      if (shouldIncludeExpression(expression)) {
        docOptions.push({
          value: expression,
          label: expression,
        })
      }
    }
    for (const attr of document.attributes) {
      const expression = `doc.${attr.name}`
      if (shouldIncludeExpression(expression)) {
        docOptions.push({
          value: expression,
          label: expression,
        })
      }
    }
    if (docOptions.length > 0) {
      groups.push({
        group: t("expression.document"),
        options: docOptions,
      })
    }

    // Вирази
    groups.push({
      group: t("expression.freeInput"),
      options: [{ value: "", label: t("expression.freeInputHint") }],
    })
  } else {
    // Source = document
    // Документ — doc.{field}
    const docOptions: ExpressionOption[] = []
    const docStandard = getStandardAttributes("Document")
    for (const attr of docStandard) {
      if (attr.name === "id") continue
      const expression = `doc.${attr.name}`
      if (shouldIncludeExpression(expression)) {
        docOptions.push({
          value: expression,
          label: expression,
        })
      }
    }
    for (const attr of document.attributes) {
      const expression = `doc.${attr.name}`
      if (shouldIncludeExpression(expression)) {
        docOptions.push({
          value: expression,
          label: expression,
        })
      }
    }
    if (docOptions.length > 0) {
      groups.push({
        group: t("expression.document"),
        options: docOptions,
      })
    }

    // Агрегати — sum({ts}.{field}), count({ts})
    if (document.tabularSections.length > 0) {
      const aggOptions: ExpressionOption[] = []
      // Стандартні реквізити ТЧ для агрегатів (без id)
      const tsStdAttrs = getTabularSectionStandardAttributes().filter(
        (a) => a.name !== 'id',
      )
      for (const ts of document.tabularSections) {
        const countExpression = `count(${ts.name})`
        if (shouldIncludeExpression(countExpression)) {
          aggOptions.push({
            value: countExpression,
            label: countExpression,
          })
        }
        // Стандартні реквізити ТЧ (напр. line_number)
        for (const stdAttr of tsStdAttrs) {
          if (stdAttr.type !== "Integer" && stdAttr.type !== "Numeric") {
            continue
          }
          const expression = `sum(${ts.name}.${stdAttr.name})`
          if (shouldIncludeExpression(expression)) {
            aggOptions.push({
              value: expression,
              label: expression,
            })
          }
        }
        for (const attr of ts.attributes) {
          if (attr.type !== "Integer" && attr.type !== "Numeric") {
            continue
          }
          const expression = `sum(${ts.name}.${attr.name})`
          if (shouldIncludeExpression(expression)) {
            aggOptions.push({
              value: expression,
              label: expression,
            })
          }
        }
      }
      if (aggOptions.length > 0) {
        groups.push({
          group: t("expression.aggregates"),
          options: aggOptions,
        })
      }
    }

    // Константи
    const constantOptions: ExpressionOption[] = []
    if (shouldIncludeExpression("now()")) {
      constantOptions.push({ value: "now()", label: "now()" })
    }
    if (shouldIncludeExpression("literal:")) {
      constantOptions.push({
        value: "literal:",
        label: t("expression.literalHint"),
      })
    }

    if (constantOptions.length > 0) {
      groups.push({
        group: t("expression.constants"),
        options: constantOptions,
      })
    }
  }

  return groups
}
