import {
  getStandardAttributes,
  getTabularSectionStandardAttributes,
  type Document,
} from "@simetra/core"

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
  t: (key: string, fallback?: string) => string
): ExpressionOptionGroup[] {
  const groups: ExpressionOptionGroup[] = []

  const isTabularSection = source.startsWith("tabularSection:")
  const tsName = isTabularSection ? source.replace("tabularSection:", "") : null

  if (isTabularSection && tsName) {
    // Рядок ТЧ — row.{field}
    const ts = document.tabularSections.find((s) => s.name === tsName)
    if (ts) {
      const rowOptions: ExpressionOption[] = []

      // Стандартні реквізити ТЧ
      const tsStandard = getTabularSectionStandardAttributes()
      for (const attr of tsStandard) {
        if (attr.name === "id") continue
        rowOptions.push({
          value: `row.${attr.name}`,
          label: `row.${attr.name}`,
        })
      }

      // Користувацькі реквізити ТЧ
      for (const attr of ts.attributes) {
        rowOptions.push({
          value: `row.${attr.name}`,
          label: `row.${attr.name}`,
        })
      }

      groups.push({
        group: t("expression.tsRow", `ТЧ "${tsName}"`),
        options: rowOptions,
      })
    }

    // Документ — doc.{field} (стандартні + custom)
    const docOptions: ExpressionOption[] = []
    const docStandard = getStandardAttributes("Document")
    for (const attr of docStandard) {
      if (attr.name === "id") continue
      docOptions.push({
        value: `doc.${attr.name}`,
        label: `doc.${attr.name}`,
      })
    }
    for (const attr of document.attributes) {
      docOptions.push({
        value: `doc.${attr.name}`,
        label: `doc.${attr.name}`,
      })
    }
    groups.push({
      group: t("expression.document", "Документ"),
      options: docOptions,
    })

    // Вирази
    groups.push({
      group: t("expression.freeInput", "Вираз"),
      options: [
        { value: "", label: t("expression.freeInputHint", "Вільний ввід") },
      ],
    })
  } else {
    // Source = document
    // Документ — doc.{field}
    const docOptions: ExpressionOption[] = []
    const docStandard = getStandardAttributes("Document")
    for (const attr of docStandard) {
      if (attr.name === "id") continue
      docOptions.push({
        value: `doc.${attr.name}`,
        label: `doc.${attr.name}`,
      })
    }
    for (const attr of document.attributes) {
      docOptions.push({
        value: `doc.${attr.name}`,
        label: `doc.${attr.name}`,
      })
    }
    groups.push({
      group: t("expression.document", "Документ"),
      options: docOptions,
    })

    // Агрегати — sum({ts}.{field}), count({ts})
    if (document.tabularSections.length > 0) {
      const aggOptions: ExpressionOption[] = []
      // Стандартні реквізити ТЧ для агрегатів (без id)
      const tsStdAttrs = getTabularSectionStandardAttributes().filter(
        (a) => a.name !== 'id',
      )
      for (const ts of document.tabularSections) {
        aggOptions.push({
          value: `count(${ts.name})`,
          label: `count(${ts.name})`,
        })
        // Стандартні реквізити ТЧ (напр. line_number)
        for (const stdAttr of tsStdAttrs) {
          aggOptions.push({
            value: `sum(${ts.name}.${stdAttr.name})`,
            label: `sum(${ts.name}.${stdAttr.name})`,
          })
        }
        for (const attr of ts.attributes) {
          aggOptions.push({
            value: `sum(${ts.name}.${attr.name})`,
            label: `sum(${ts.name}.${attr.name})`,
          })
        }
      }
      groups.push({
        group: t("expression.aggregates", "Агрегати"),
        options: aggOptions,
      })
    }

    // Константи
    groups.push({
      group: t("expression.constants", "Константи"),
      options: [
        { value: "now()", label: "now()" },
        {
          value: "literal:",
          label: t("expression.literalHint", "literal:{значення}"),
        },
      ],
    })
  }

  return groups
}
