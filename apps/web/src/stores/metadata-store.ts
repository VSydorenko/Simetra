import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { temporal } from 'zundo'
import {
  type ProjectModel,
  type MetadataObject,
  type MetadataKind,
  type Project,
  projectModelSchema,
  metadataObjectSchema,
} from '@simetra/core'

// Маппінг MetadataKind → ключ у ProjectModel
const KIND_TO_KEY: Record<MetadataKind, keyof Omit<ProjectModel, 'project'>> = {
  Catalog: 'catalogs',
  Document: 'documents',
  Enumeration: 'enumerations',
  InformationRegister: 'informationRegisters',
  AccumulationRegister: 'accumulationRegisters',
  Constant: 'constants',
  CustomTable: 'customTables',
}

export interface ValidationError {
  path: string
  message: string
}

export interface MetadataState {
  model: ProjectModel
  // Лічильник версій — збільшується при кожній мутації model
  version: number
  // Помилки object-level валідації, ключ — `${kind}/${name}`
  validationErrors: Record<string, ValidationError[]>
}

export interface MetadataActions {
  /** Завантажити повну модель (при open project) */
  loadModel: (model: ProjectModel) => void
  /** Скинути до порожнього проєкту */
  resetModel: (projectName: string) => void
  /** Оновити налаштування проєкту */
  updateProject: (updates: Partial<Project>) => void

  /** Створити новий обʼєкт метаданих */
  createObject: (obj: MetadataObject) => ValidationError[] | null
  /** Оновити обʼєкт за kind + name */
  updateObject: (
    kind: MetadataKind,
    name: string,
    updates: Partial<MetadataObject>,
  ) => ValidationError[] | null
  /** Видалити обʼєкт за kind + name */
  deleteObject: (kind: MetadataKind, name: string) => void
  /** Перейменувати обʼєкт */
  renameObject: (
    kind: MetadataKind,
    oldName: string,
    newName: string,
  ) => ValidationError[] | null
  /** Дублювати обʼєкт */
  duplicateObject: (
    kind: MetadataKind,
    sourceName: string,
    newName: string,
  ) => ValidationError[] | null
}

function createEmptyModel(projectName: string): ProjectModel {
  return projectModelSchema.parse({
    project: { name: projectName },
    catalogs: [],
    documents: [],
    enumerations: [],
    informationRegisters: [],
    accumulationRegisters: [],
    constants: [],
    customTables: [],
  })
}

/** Валідація обʼєкта через discriminated union — автоматично вибирає схему за kind */
function validateObject(obj: MetadataObject): ValidationError[] | null {
  const result = metadataObjectSchema.safeParse(obj)
  if (result.success) return null
  return result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }))
}

/** Знайти індекс обʼєкта в масиві за іменем */
function findObjectIndex(
  objects: MetadataObject[],
  name: string,
): number {
  return objects.findIndex((o) => o.name === name)
}

export type MetadataStore = MetadataState & MetadataActions

export const useMetadataStore = create<MetadataStore>()(
  temporal(
    immer((set, get) => ({
      model: createEmptyModel('NewProject'),
      version: 0,
      validationErrors: {},

      loadModel: (model) => {
        set((state) => {
          state.model = model
          state.version++
          state.validationErrors = {}
        })
        // Caller відповідає за очищення undo-стеку через
        // useMetadataStore.temporal.getState().clear()
      },

      resetModel: (projectName) => {
        set((state) => {
          state.model = createEmptyModel(projectName)
          state.version++
          state.validationErrors = {}
        })
      },

      updateProject: (updates) => {
        set((state) => {
          Object.assign(state.model.project, updates)
          state.version++
        })
      },

      createObject: (obj) => {
        const errors = validateObject(obj)
        if (errors) return errors

        const key = KIND_TO_KEY[obj.kind]
        const objects = get().model[key] as MetadataObject[]
        // Перевірка унікальності імені в межах типу
        if (objects.some((o) => o.name === obj.name)) {
          return [{ path: 'name', message: `Name "${obj.name}" already exists in ${obj.kind}` }]
        }

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          arr.push(obj as never)
          state.version++
        })
        return null
      },

      updateObject: (kind, name, updates) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const index = findObjectIndex(objects, name)
        if (index === -1) {
          return [{ path: '', message: `Object "${name}" not found in ${kind}` }]
        }

        const merged = { ...objects[index], ...updates }
        const errors = validateObject(merged as MetadataObject)
        if (errors) return errors

        const errorKey = `${kind}/${name}`
        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          Object.assign(arr[index], updates)
          delete state.validationErrors[errorKey]
          state.version++
        })

        return null
      },

      deleteObject: (kind, name) => {
        const key = KIND_TO_KEY[kind]

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const index = findObjectIndex(arr, name)
          if (index !== -1) {
            arr.splice(index, 1)
          }
          delete state.validationErrors[`${kind}/${name}`]
          state.version++
        })
      },

      renameObject: (kind, oldName, newName) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const index = findObjectIndex(objects, oldName)
        if (index === -1) {
          return [{ path: '', message: `Object "${oldName}" not found in ${kind}` }]
        }

        // Перевірка унікальності нового імені
        if (objects.some((o) => o.name === newName)) {
          return [{ path: 'name', message: `Name "${newName}" already exists in ${kind}` }]
        }

        const renamed = { ...objects[index], name: newName }
        const errors = validateObject(renamed as MetadataObject)
        if (errors) return errors

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          arr[index].name = newName
          const oldKey = `${kind}/${oldName}`
          const newKey = `${kind}/${newName}`
          if (state.validationErrors[oldKey]) {
            state.validationErrors[newKey] = state.validationErrors[oldKey]
            delete state.validationErrors[oldKey]
          }
          state.version++
        })
        return null
      },

      duplicateObject: (kind, sourceName, newName) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const source = objects.find((o) => o.name === sourceName)
        if (!source) {
          return [{ path: '', message: `Object "${sourceName}" not found in ${kind}` }]
        }

        const duplicate = { ...structuredClone(source), name: newName }
        return get().createObject(duplicate as MetadataObject)
      },
    })),
    {
      // zundo: відстежувати тільки зміни model, без validationErrors
      equality: (pastState, currentState) =>
        pastState.model === currentState.model,
      // Обмеження розміру стеку undo
      limit: 100,
    },
  ),
)
