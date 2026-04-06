import { create } from "zustand"
import type { GeneratorOutput } from "@simetra/generator-api"
import { PostgresGenerator } from "@simetra/generator-pg"
import { KIND_TO_KEY } from "@simetra/core"
import type {
  Attribute,
  MetadataKind,
  MetadataObject,
  ProjectModel,
} from "@simetra/core"
import { useMetadataStore } from "@/stores/metadata-store"

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

/** Збирає помилки валідації broken refs перед генерацією DDL */
function collectValidationErrors(model: ProjectModel): string[] {
  const errors: string[] = []

  for (const kind of ALL_KINDS) {
    const key = KIND_TO_KEY[kind]
    const objects = model[key] as MetadataObject[]

    for (const obj of objects) {
      const allAttrs = collectAllAttributes(obj)
      for (const { path, attr } of allAttrs) {
        if (attr.type === "Ref" && attr.ref) {
          if (!refExists(model, attr.ref.kind, attr.ref.name)) {
            errors.push(
              `${kind}.${obj.name}.${path}: посилання на неіснуючий обʼєкт ${attr.ref.kind}/${attr.ref.name}`
            )
          }
        }
        if (attr.allowedTypes) {
          for (const allowed of attr.allowedTypes) {
            if (!refExists(model, allowed.kind, allowed.name)) {
              errors.push(
                `${kind}.${obj.name}.${path}: посилання на неіснуючий обʼєкт ${allowed.kind}/${allowed.name}`
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
              `${kind}.${obj.name}.owners: посилання на неіснуючий обʼєкт ${ref.kind}/${ref.name}`
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
              `${kind}.${obj.name}.recorderTypes: посилання на неіснуючий обʼєкт ${ref.kind}/${ref.name}`
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
              `${kind}.${obj.name}.registerMovements: посилання на неіснуючий обʼєкт ${ref.kind}/${ref.name}`
            )
          }
        }
      }
    }
  }

  return errors
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
function runGeneration(set: (partial: Partial<DdlState>) => void) {
  set({ isGenerating: true, generationError: null })
  try {
    const { model } = useMetadataStore.getState()
    const generator = new PostgresGenerator()
    const output = generator.generate(model)
    set({
      output,
      selectedFilePath: output.files[0]?.path ?? null,
      validationErrors: [],
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

  generateDdl: () => {
    const { model } = useMetadataStore.getState()
    const errors = collectValidationErrors(model)
    if (errors.length > 0) {
      set({ validationErrors: errors })
      return
    }
    runGeneration(set)
  },

  generateDdlForce: () => {
    runGeneration(set)
  },

  selectFile: (path) => {
    set({ selectedFilePath: path })
  },

  clearOutput: () => {
    set({
      output: null,
      selectedFilePath: null,
      generationError: null,
    })
  },

  clearValidationErrors: () => {
    set({ validationErrors: [] })
  },
}))
