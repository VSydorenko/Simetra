import { create } from "zustand"
import type { GeneratorOutput } from "@simetra/generator-api"
import { PostgresGenerator } from "@simetra/generator-pg"
import { KIND_TO_KEY, isPostingCompatible } from "@simetra/core"
import type {
  AccumulationRegister,
  Attribute,
  Document,
  InformationRegister,
  MetadataKind,
  MetadataObject,
  ProjectModel,
} from "@simetra/core"
import i18n from "@/i18n"
import { useMetadataStore } from "@/stores/metadata-store"
import {
  validateExpressionCompatibility,
  validateExpressionFields,
} from "@/lib/expression-validation"
import { translateValidationMessage } from "@/lib/translate-validation-message"

const ALL_KINDS: MetadataKind[] = [
  "Catalog",
  "Document",
  "Enumeration",
  "InformationRegister",
  "AccumulationRegister",
  "Constant",
  "CustomTable",
]

/** Перевіряє, чи існує обʼєкт за kind/name у моделі */
function refExists(
  model: ProjectModel,
  kind: MetadataKind,
  name: string
): boolean {
  const key = KIND_TO_KEY[kind]
  const objects = model[key] as MetadataObject[]
  return objects.some((o) => o.name === name)
}

/** Знаходить регістр у моделі за ref */
function findRegisterInModel(
  model: ProjectModel,
  ref: { kind: MetadataKind; name: string },
): AccumulationRegister | InformationRegister | undefined {
  if (ref.kind === 'AccumulationRegister') {
    return model.accumulationRegisters.find((r) => r.name === ref.name)
  }
  if (ref.kind === 'InformationRegister') {
    return model.informationRegisters.find((r) => r.name === ref.name)
  }
  return undefined
}

/** Збирає всі атрибути обʼєкта з path-міткою */
function collectAllAttributes(
  obj: MetadataObject
): { path: string; attr: Attribute }[] {
  const result: { path: string; attr: Attribute }[] = []

  if ("attributes" in obj && Array.isArray(obj.attributes)) {
    for (const attr of obj.attributes as Attribute[]) {
      result.push({ path: `attributes.${attr.name}`, attr })
    }
  }
  if ("dimensions" in obj && Array.isArray(obj.dimensions)) {
    for (const attr of obj.dimensions as Attribute[]) {
      result.push({ path: `dimensions.${attr.name}`, attr })
    }
  }
  if ("resources" in obj && Array.isArray(obj.resources)) {
    for (const attr of obj.resources as Attribute[]) {
      result.push({ path: `resources.${attr.name}`, attr })
    }
  }
  if ("tabularSections" in obj && Array.isArray(obj.tabularSections)) {
    for (const ts of obj.tabularSections as {
      name: string
      attributes: Attribute[]
    }[]) {
      for (const attr of ts.attributes) {
        result.push({
          path: `tabularSections.${ts.name}.${attr.name}`,
          attr,
        })
      }
    }
  }

  return result
}

function addAttributePreflightWarnings(
  warnings: string[],
  kind: MetadataKind,
  objectName: string,
  path: string,
  attr: Attribute
): void {
  if (attr.type === "String" && attr.length == null) {
    warnings.push(
      i18n.t("validation.preflight.stringLengthMissing", {
        path: `${kind}.${objectName}.${path}.length`,
      })
    )
  }

  if (attr.type === "Numeric" && attr.precision == null) {
    warnings.push(
      i18n.t("validation.preflight.numericPrecisionMissing", {
        path: `${kind}.${objectName}.${path}.precision`,
      })
    )
  }

  if (attr.type === "Numeric" && attr.scale == null) {
    warnings.push(
      i18n.t("validation.preflight.numericScaleMissing", {
        path: `${kind}.${objectName}.${path}.scale`,
      })
    )
  }

  if (
    attr.type === "Ref" &&
    !attr.ref &&
    !(attr.allowedTypes && attr.allowedTypes.length > 0)
  ) {
    warnings.push(
      i18n.t("validation.preflight.refTargetMissing", {
        path: `${kind}.${objectName}.${path}`,
      })
    )
  }
}

/** Збирає помилки та warnings preflight перед генерацією DDL */
function collectValidationMessages(model: ProjectModel): {
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []

  for (const kind of ALL_KINDS) {
    const key = KIND_TO_KEY[kind]
    const objects = model[key] as MetadataObject[]

    for (const obj of objects) {
      const allAttrs = collectAllAttributes(obj)
      for (const { path, attr } of allAttrs) {
        addAttributePreflightWarnings(warnings, kind, obj.name, path, attr)
        if (attr.type === "Ref" && attr.ref) {
          if (!refExists(model, attr.ref.kind, attr.ref.name)) {
            errors.push(
              i18n.t("validation.preflight.refObjectMissing", {
                path: `${kind}.${obj.name}.${path}`,
                target: `${attr.ref.kind}/${attr.ref.name}`,
              })
            )
          }
        }
        if (attr.allowedTypes) {
          for (const allowed of attr.allowedTypes) {
            if (!refExists(model, allowed.kind, allowed.name)) {
              errors.push(
                i18n.t("validation.preflight.refObjectMissing", {
                  path: `${kind}.${obj.name}.${path}`,
                  target: `${allowed.kind}/${allowed.name}`,
                })
              )
            }
          }
        }
      }

      // Object-level refs: owners, recorderTypes, registerMovements
      if ("owners" in obj && Array.isArray(obj.owners)) {
        for (const ref of obj.owners as {
          kind: MetadataKind
          name: string
        }[]) {
          if (!refExists(model, ref.kind, ref.name)) {
            errors.push(
              i18n.t("validation.preflight.refObjectMissing", {
                path: `${kind}.${obj.name}.owners`,
                target: `${ref.kind}/${ref.name}`,
              })
            )
          }
        }
      }
      if ("recorderTypes" in obj && Array.isArray(obj.recorderTypes)) {
        for (const ref of obj.recorderTypes as {
          kind: MetadataKind
          name: string
        }[]) {
          if (!refExists(model, ref.kind, ref.name)) {
            errors.push(
              i18n.t("validation.preflight.refObjectMissing", {
                path: `${kind}.${obj.name}.recorderTypes`,
                target: `${ref.kind}/${ref.name}`,
              })
            )
          }
        }
      }
      if ("registerMovements" in obj && Array.isArray(obj.registerMovements)) {
        for (const ref of obj.registerMovements as {
          kind: MetadataKind
          name: string
        }[]) {
          if (!refExists(model, ref.kind, ref.name)) {
            errors.push(
              i18n.t("validation.preflight.refObjectMissing", {
                path: `${kind}.${obj.name}.registerMovements`,
                target: `${ref.kind}/${ref.name}`,
              })
            )
          }
        }
      }
      // Posting refs: movements + validations
      if (
        "posting" in obj &&
        typeof obj.posting === "object" &&
        obj.posting !== null
      ) {
        const documentObject = obj as Document
        const recorderRef = { kind: "Document" as const, name: obj.name }
        const posting = obj.posting as {
          movements?: {
            register: { kind: MetadataKind; name: string }
            source: string
            mappings: {
              dimensions: Record<string, string>
              resources: Record<string, string>
              attributes: Record<string, string>
            }
          }[]
          validations?: {
            register: { kind: MetadataKind; name: string }
            resource: string
          }[]
        }
        if (posting.movements) {
          for (const m of posting.movements) {
            if (!refExists(model, m.register.kind, m.register.name)) {
              errors.push(
                i18n.t("validation.preflight.refObjectMissing", {
                  path: `${kind}.${obj.name}.posting.movements`,
                  target: `${m.register.kind}/${m.register.name}`,
                })
              )
            }
            // Перевірка сумісності регістру з проведенням
            const reg = findRegisterInModel(model, m.register)
            if (reg) {
              const compat = isPostingCompatible(reg, { recorder: recorderRef })
              if (!compat.compatible) {
                errors.push(
                  `${kind}/${obj.name}: ${i18n.t(
                    "validation.posting.registerIncompatible",
                    {
                      register: m.register.name,
                      reason: translateValidationMessage(compat.reason ?? ""),
                    }
                  )}`
                )
              }
              for (const warning of compat.warnings ?? []) {
                warnings.push(
                  `${kind}/${obj.name}: ${i18n.t(
                    "validation.posting.registerWarning",
                    {
                      register: m.register.name,
                      warning: translateValidationMessage(warning),
                    }
                  )}`
                )
              }
              // Перевірка неповних dimensions
              // AR — всі dimensions обов'язкові (ключ агрегації), IR — тільки required
              const missingDims = reg.dimensions.filter((d) =>
                reg.kind === 'AccumulationRegister'
                  ? !m.mappings.dimensions[d.name]
                  : d.required && !m.mappings.dimensions[d.name],
              )
              if (missingDims.length > 0) {
                const label =
                  reg.kind === "AccumulationRegister"
                    ? i18n.t("validation.posting.missingDimensionsLabel")
                    : i18n.t("validation.posting.missingRequiredDimensionsLabel")
                errors.push(
                  `${kind}/${obj.name}: ${i18n.t(
                    "validation.posting.movementMissingDimensions",
                    {
                      register: m.register.name,
                      label,
                      dimensions: missingDims.map((d) => d.name).join(", "),
                    }
                  )}`
                )
              }

              const selectedTsAttributes = m.source.startsWith("tabularSection:")
                ? documentObject.tabularSections.find(
                    (section) =>
                      section.name === m.source.slice("tabularSection:".length)
                  )?.attributes
                : undefined

              const mappingGroups: Array<
                [group: "dimensions" | "resources" | "attributes", fields: Attribute[]]
              > = [
                ["dimensions", reg.dimensions],
                ["resources", reg.resources],
                ["attributes", reg.attributes],
              ]

              for (const [groupName, fields] of mappingGroups) {
                for (const field of fields) {
                  const expr = m.mappings[groupName]?.[field.name]
                  if (!expr) {
                    continue
                  }

                  const fieldError = validateExpressionFields(
                    expr,
                    m.source,
                    documentObject.attributes,
                    selectedTsAttributes,
                    documentObject.tabularSections
                  )
                  if (fieldError) {
                    errors.push(
                      `${kind}/${obj.name}: ${m.register.name}.${groupName}.${field.name} — ${fieldError}`
                    )
                    continue
                  }

                  const typeWarning = validateExpressionCompatibility(expr, field, {
                    source: m.source,
                    document: documentObject,
                  })
                  if (typeWarning) {
                    warnings.push(
                      `${kind}/${obj.name}: ${m.register.name}.${groupName}.${field.name} — ${typeWarning}`
                    )
                  }
                }
              }
            }
          }
        }
        if (posting.validations) {
          for (const v of posting.validations) {
            if (!refExists(model, v.register.kind, v.register.name)) {
              errors.push(
                i18n.t("validation.preflight.refObjectMissing", {
                  path: `${kind}.${obj.name}.posting.validations`,
                  target: `${v.register.kind}/${v.register.name}`,
                })
              )
            }
            // Перевірка що ресурс валідації має числовий тип
            const reg = findRegisterInModel(model, v.register)
            if (reg) {
              const resourceAttr = reg.resources.find((r) => r.name === v.resource)
              if (resourceAttr && resourceAttr.type !== 'Numeric' && resourceAttr.type !== 'Integer') {
                errors.push(
                  `${kind}/${obj.name}: ${i18n.t(
                    "validation.posting.nonNegativeBalanceResourceType",
                    {
                      resource: v.resource,
                      type: resourceAttr.type,
                    }
                  )}`
                )
              }
            }
          }
        }
        if (
          posting.validations &&
          posting.validations.length > 0 &&
          (!posting.movements || posting.movements.length === 0)
        ) {
          warnings.push(
            `${kind}/${obj.name}: ${i18n.t(
              "validation.posting.validationsWithoutMovements"
            )}`
          )
        }
      }
    }
  }

  return { errors, warnings }
}

interface DdlState {
  // Результат генерації
  output: GeneratorOutput | null
  // Файл обраний у дереві preview
  selectedFilePath: string | null
  // Стан генерації
  isGenerating: boolean
  // Помилка генерації (якщо є)
  generationError: string | null
  // Помилки валідації перед генерацією
  validationErrors: string[]
  // Non-blocking warnings preflight перед генерацією
  validationWarnings: string[]
}

interface DdlActions {
  // Запустити генерацію DDL з поточної метамоделі
  generateDdl: () => void
  // Генерувати DDL ігноруючи validation errors (force)
  generateDdlForce: () => void
  // Вибрати файл у preview
  selectFile: (path: string | null) => void
  // Очистити результат
  clearOutput: () => void
  // Очистити validation errors
  clearValidationErrors: () => void
}

/** Виконує генерацію DDL без перевірки валідації */
function runGeneration(
  set: (partial: Partial<DdlState>) => void,
  validationWarnings: string[] = []
) {
  set({ isGenerating: true, generationError: null })
  try {
    const { model } = useMetadataStore.getState()
    const generator = new PostgresGenerator()
    const output = generator.generate(model)
    set({
      output,
      selectedFilePath: output.files[0]?.path ?? null,
      validationErrors: [],
      validationWarnings,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    set({ generationError: message })
  } finally {
    set({ isGenerating: false })
  }
}

export const useDdlStore = create<DdlState & DdlActions>()((set) => ({
  output: null,
  selectedFilePath: null,
  isGenerating: false,
  generationError: null,
  validationErrors: [],
  validationWarnings: [],

  generateDdl: () => {
    const { model } = useMetadataStore.getState()
    const { errors, warnings } = collectValidationMessages(model)
    if (errors.length > 0) {
      set({ validationErrors: errors, validationWarnings: warnings, output: null })
      return
    }
    runGeneration(set, warnings)
  },

  generateDdlForce: () => {
    const { model } = useMetadataStore.getState()
    const { warnings } = collectValidationMessages(model)
    runGeneration(set, warnings)
  },

  selectFile: (path) => {
    set({ selectedFilePath: path })
  },

  clearOutput: () => {
    set({
      output: null,
      selectedFilePath: null,
      generationError: null,
      validationWarnings: [],
    })
  },

  clearValidationErrors: () => {
    set({ validationErrors: [], validationWarnings: [] })
  },
}))
