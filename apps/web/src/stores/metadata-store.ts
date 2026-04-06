import { create } from "zustand"
import { immer } from "zustand/middleware/immer"
import { temporal } from "zundo"
import {
  type ProjectModel,
  type MetadataObject,
  type MetadataKind,
  type MetadataRef,
  type Project,
  type Attribute,
  type TabularSection,
  type PostingMovement,
  type PostingValidation,
  projectModelSchema,
  metadataObjectSchema,
} from "@simetra/core"
import { KIND_TO_KEY } from "@/lib/metadata-defaults"
import { resolveZodPath } from "@/lib/resolve-zod-path"

export interface ValidationError {
  path: string
  message: string
}

export interface MetadataState {
  model: ProjectModel
  // Лічильник версій — збільшується при кожній мутації model
  version: number
  // Per-object версії для dirty tracking, ключ — `${kind}/${name}`
  objectVersions: Record<string, number>
  // Помилки мутацій, ключ — `${kind}/${name}`
  validationErrors: Record<string, ValidationError[]>
  // Помилки project-level валідації (debounced), ключ — `${kind}/${name}`
  modelErrors: Record<string, ValidationError[]>
}

export interface MetadataActions {
  /** Завантажити повну модель (при open project) */
  loadModel: (model: ProjectModel) => void
  /** Скинути до порожнього проєкту */
  resetModel: (projectName: string) => void
  /** Оновити налаштування проєкту */
  updateProject: (updates: Partial<Project>) => void
  /** Встановити помилки project-level валідації (debounced hook) */
  setModelErrors: (errors: Record<string, ValidationError[]>) => void

  /** Створити новий обʼєкт метаданих */
  createObject: (obj: MetadataObject) => ValidationError[] | null
  /** Оновити обʼєкт за kind + name */
  updateObject: (
    kind: MetadataKind,
    name: string,
    updates: Partial<MetadataObject>
  ) => ValidationError[] | null
  /** Видалити обʼєкт за kind + name */
  deleteObject: (kind: MetadataKind, name: string) => void
  /** Перейменувати обʼєкт */
  renameObject: (
    kind: MetadataKind,
    oldName: string,
    newName: string
  ) => ValidationError[] | null
  /** Дублювати обʼєкт */
  duplicateObject: (
    kind: MetadataKind,
    sourceName: string,
    newName: string
  ) => ValidationError[] | null

  // --- Granular attribute actions ---
  /** Додати атрибут до обʼєкта */
  addAttribute: (
    kind: MetadataKind,
    name: string,
    attribute: Attribute
  ) => ValidationError[] | null
  /** Видалити атрибут з обʼєкта */
  removeAttribute: (kind: MetadataKind, name: string, attrName: string) => void
  /** Оновити атрибут обʼєкта */
  updateAttribute: (
    kind: MetadataKind,
    name: string,
    attrName: string,
    updates: Partial<Attribute>
  ) => ValidationError[] | null
  /** Змінити порядок атрибутів */
  reorderAttributes: (
    kind: MetadataKind,
    name: string,
    fromIndex: number,
    toIndex: number
  ) => void

  // --- Tabular section actions ---
  /** Додати табличну частину */
  addTabularSection: (
    kind: MetadataKind,
    name: string,
    section: TabularSection
  ) => ValidationError[] | null
  /** Видалити табличну частину */
  removeTabularSection: (
    kind: MetadataKind,
    name: string,
    sectionName: string
  ) => void
  /** Оновити табличну частину */
  updateTabularSection: (
    kind: MetadataKind,
    name: string,
    sectionName: string,
    updates: Partial<TabularSection>
  ) => ValidationError[] | null
  /** Перейменувати табличну частину */
  renameTabularSection: (
    kind: MetadataKind,
    name: string,
    oldSectionName: string,
    newSectionName: string
  ) => ValidationError[] | null
  /** Додати атрибут до табличної частини */
  addTabularSectionAttribute: (
    kind: MetadataKind,
    name: string,
    sectionName: string,
    attribute: Attribute
  ) => ValidationError[] | null
  /** Видалити атрибут з табличної частини */
  removeTabularSectionAttribute: (
    kind: MetadataKind,
    name: string,
    sectionName: string,
    attrName: string
  ) => void
  /** Оновити атрибут табличної частини */
  updateTabularSectionAttribute: (
    kind: MetadataKind,
    name: string,
    sectionName: string,
    attrName: string,
    updates: Partial<Attribute>
  ) => ValidationError[] | null
  /** Змінити порядок атрибутів табличної частини */
  reorderTabularSectionAttributes: (
    kind: MetadataKind,
    name: string,
    sectionName: string,
    fromIndex: number,
    toIndex: number
  ) => void

  // --- Enum value actions ---
  /** Додати значення enum */
  addEnumValue: (
    name: string,
    value: {
      name: string
      displayName?: { uk?: string; en?: string }
      order?: number
    }
  ) => ValidationError[] | null
  /** Видалити значення enum */
  removeEnumValue: (name: string, valueName: string) => void
  /** Оновити значення enum */
  updateEnumValue: (
    name: string,
    valueName: string,
    updates: {
      name?: string
      displayName?: { uk?: string; en?: string }
      order?: number
    }
  ) => ValidationError[] | null
  /** Змінити порядок значень enum */
  reorderEnumValues: (name: string, fromIndex: number, toIndex: number) => void

  // --- Register dimension/resource actions (делегують до attribute actions з відповідним полем) ---
  /** Додати dimension до регістру */
  addDimension: (
    kind: MetadataKind,
    name: string,
    attribute: Attribute
  ) => ValidationError[] | null
  /** Видалити dimension з регістру */
  removeDimension: (kind: MetadataKind, name: string, attrName: string) => void
  /** Оновити dimension регістру */
  updateDimension: (
    kind: MetadataKind,
    name: string,
    attrName: string,
    updates: Partial<Attribute>
  ) => ValidationError[] | null
  /** Змінити порядок dimensions */
  reorderDimensions: (
    kind: MetadataKind,
    name: string,
    fromIndex: number,
    toIndex: number
  ) => void
  /** Додати resource до регістру */
  addResource: (
    kind: MetadataKind,
    name: string,
    attribute: Attribute
  ) => ValidationError[] | null
  /** Видалити resource з регістру */
  removeResource: (kind: MetadataKind, name: string, attrName: string) => void
  /** Оновити resource регістру */
  updateResource: (
    kind: MetadataKind,
    name: string,
    attrName: string,
    updates: Partial<Attribute>
  ) => ValidationError[] | null
  /** Змінити порядок resources */
  reorderResources: (
    kind: MetadataKind,
    name: string,
    fromIndex: number,
    toIndex: number
  ) => void

  // --- Posting actions (Document) ---
  /** Оновити або додати один movement для документа */
  updateMovement: (
    name: string,
    registerRef: MetadataRef,
    movement: PostingMovement,
  ) => ValidationError[] | null
  /** Видалити movement для документа */
  removeMovement: (
    name: string,
    registerRef: MetadataRef,
  ) => void
  /** Додати валідацію проведення */
  addPostingValidation: (
    name: string,
    validation: PostingValidation,
  ) => ValidationError[] | null
  /** Видалити валідацію проведення за індексом */
  removePostingValidation: (
    name: string,
    index: number,
  ) => void
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
    path: resolveZodPath(obj, issue.path as (string | number)[]),
    message: issue.message,
  }))
}

/** Знайти індекс обʼєкта в масиві за іменем */
function findObjectIndex(objects: MetadataObject[], name: string): number {
  return objects.findIndex((o) => o.name === name)
}

/** Інкрементувати per-object version (immer draft) */
function bumpObjectVersion(
  state: { objectVersions: Record<string, number> },
  kind: MetadataKind | string,
  name: string
): void {
  const key = `${kind}/${name}`
  state.objectVersions[key] = (state.objectVersions[key] ?? 0) + 1
}

/** Cascade-оновлення посилань на перейменований обʼєкт у всій моделі (immer draft) */
function cascadeRenameRefs(
  state: { model: ProjectModel; objectVersions: Record<string, number> },
  kind: MetadataKind,
  oldName: string,
  newName: string
): void {
  const allKinds: MetadataKind[] = [
    "Catalog",
    "Document",
    "Enumeration",
    "InformationRegister",
    "AccumulationRegister",
    "Constant",
    "CustomTable",
  ]

  for (const k of allKinds) {
    const key = KIND_TO_KEY[k]
    const objects = state.model[key] as MetadataObject[]
    for (const obj of objects) {
      let changed = false

      // Оновити owners (Catalog)
      if ("owners" in obj && Array.isArray(obj.owners)) {
        for (const ref of obj.owners as {
          kind: MetadataKind
          name: string
        }[]) {
          if (ref.kind === kind && ref.name === oldName) {
            ref.name = newName
            changed = true
          }
        }
      }

      // Оновити recorderTypes (InformationRegister, AccumulationRegister)
      if ("recorderTypes" in obj && Array.isArray(obj.recorderTypes)) {
        for (const ref of obj.recorderTypes as {
          kind: MetadataKind
          name: string
        }[]) {
          if (ref.kind === kind && ref.name === oldName) {
            ref.name = newName
            changed = true
          }
        }
      }

      // Оновити registerMovements (Document)
      if ("registerMovements" in obj && Array.isArray(obj.registerMovements)) {
        for (const ref of obj.registerMovements as {
          kind: MetadataKind
          name: string
        }[]) {
          if (ref.kind === kind && ref.name === oldName) {
            ref.name = newName
            changed = true
          }
        }
      }

      // Оновити posting.movements[].register та posting.validations[].register (Document)
      if (
        "posting" in obj &&
        typeof obj.posting === "object" &&
        obj.posting !== null
      ) {
        const posting = obj.posting as {
          movements?: { register: { kind: MetadataKind; name: string } }[]
          validations?: { register: { kind: MetadataKind; name: string } }[]
        }
        if (posting.movements) {
          for (const movement of posting.movements) {
            if (
              movement.register.kind === kind &&
              movement.register.name === oldName
            ) {
              movement.register.name = newName
              changed = true
            }
          }
        }
        if (posting.validations) {
          for (const validation of posting.validations) {
            if (
              validation.register.kind === kind &&
              validation.register.name === oldName
            ) {
              validation.register.name = newName
              changed = true
            }
          }
        }
      }

      // Оновити attribute.ref і attribute.allowedTypes
      const attrCollections: Attribute[][] = []
      if ("attributes" in obj && Array.isArray(obj.attributes)) {
        attrCollections.push(obj.attributes as Attribute[])
      }
      if ("dimensions" in obj && Array.isArray(obj.dimensions)) {
        attrCollections.push(obj.dimensions as Attribute[])
      }
      if ("resources" in obj && Array.isArray(obj.resources)) {
        attrCollections.push(obj.resources as Attribute[])
      }
      if ("tabularSections" in obj && Array.isArray(obj.tabularSections)) {
        for (const ts of obj.tabularSections as { attributes: Attribute[] }[]) {
          if (Array.isArray(ts.attributes)) {
            attrCollections.push(ts.attributes)
          }
        }
      }

      for (const attrs of attrCollections) {
        for (const attr of attrs) {
          // Single ref (Ref + MetadataRef)
          if (attr.ref && attr.ref.kind === kind && attr.ref.name === oldName) {
            attr.ref.name = newName
            changed = true
          }
          // Polymorphic ref allowedTypes
          if (attr.allowedTypes) {
            for (const allowed of attr.allowedTypes) {
              if (allowed.kind === kind && allowed.name === oldName) {
                allowed.name = newName
                changed = true
              }
            }
          }
        }
      }

      if (changed) {
        bumpObjectVersion(state, k, obj.name)
      }
    }
  }
}

export type MetadataStore = MetadataState & MetadataActions

export const useMetadataStore = create<MetadataStore>()(
  temporal(
    immer((set, get) => ({
      model: createEmptyModel("NewProject"),
      version: 0,
      objectVersions: {},
      validationErrors: {},
      modelErrors: {},

      loadModel: (model) => {
        set((state) => {
          state.model = model
          state.version++
          state.objectVersions = {}
          state.validationErrors = {}
          state.modelErrors = {}
        })
        // Caller відповідає за очищення undo-стеку через
        // useMetadataStore.temporal.getState().clear()
      },

      resetModel: (projectName) => {
        set((state) => {
          state.model = createEmptyModel(projectName)
          state.version++
          state.objectVersions = {}
          state.validationErrors = {}
          state.modelErrors = {}
        })
      },

      setModelErrors: (errors) => {
        set((state) => {
          state.modelErrors = errors
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
        const errorKey = `${obj.kind}/${obj.name}`
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        const key = KIND_TO_KEY[obj.kind]
        const objects = get().model[key] as MetadataObject[]
        // Перевірка унікальності імені в межах типу
        if (objects.some((o) => o.name === obj.name)) {
          const dupErrors = [
            {
              path: "name",
              message: `Name "${obj.name}" already exists in ${obj.kind}`,
            },
          ]
          set((state) => {
            state.validationErrors[errorKey] = dupErrors
          })
          return dupErrors
        }

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          arr.push(obj as never)
          delete state.validationErrors[errorKey]
          state.version++
          bumpObjectVersion(state, obj.kind, obj.name)
        })
        return null
      },

      updateObject: (kind, name, updates) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const index = findObjectIndex(objects, name)
        const errorKey = `${kind}/${name}`
        if (index === -1) {
          const notFoundErrors = [
            { path: "", message: `Object "${name}" not found in ${kind}` },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const merged = { ...objects[index], ...updates }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          Object.assign(arr[index], updates)

          // Sync posting ↔ registerMovements: при оновленні registerMovements чистимо стейл записи
          if (updates.registerMovements && arr[index].kind === 'Document') {
            const doc = arr[index] as Record<string, unknown>
            const newRegs = updates.registerMovements as MetadataRef[]
            const regSet = new Set(newRegs.map((r) => `${r.kind}/${r.name}`))

            if (typeof doc.posting === 'object' && doc.posting !== null) {
              const posting = doc.posting as {
                movements: { register: MetadataRef }[]
                validations: { register: MetadataRef }[]
              }
              const filteredMovements = posting.movements.filter((m) =>
                regSet.has(`${m.register.kind}/${m.register.name}`),
              )
              const filteredValidations = posting.validations.filter((v) =>
                regSet.has(`${v.register.kind}/${v.register.name}`),
              )
              if (
                filteredMovements.length !== posting.movements.length ||
                filteredValidations.length !== posting.validations.length
              ) {
                ;(doc.posting as Record<string, unknown>).movements =
                  filteredMovements
                ;(doc.posting as Record<string, unknown>).validations =
                  filteredValidations
                // Нормалізація: порожній posting -> undefined
                if (filteredMovements.length === 0 && filteredValidations.length === 0) {
                  doc.posting = undefined
                }
              }
            }
          }

          delete state.validationErrors[errorKey]
          state.version++
          bumpObjectVersion(state, kind, name)
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
            delete state.validationErrors[`${kind}/${name}`]
            delete state.objectVersions[`${kind}/${name}`]
            state.version++
          }
        })
      },

      renameObject: (kind, oldName, newName) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const index = findObjectIndex(objects, oldName)
        const errorKey = `${kind}/${oldName}`
        if (index === -1) {
          const notFoundErrors = [
            { path: "", message: `Object "${oldName}" not found in ${kind}` },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        // Перевірка унікальності нового імені
        if (objects.some((o) => o.name === newName)) {
          const dupErrors = [
            {
              path: "name",
              message: `Name "${newName}" already exists in ${kind}`,
            },
          ]
          set((state) => {
            state.validationErrors[errorKey] = dupErrors
          })
          return dupErrors
        }

        const renamed = { ...objects[index], name: newName }
        const errors = validateObject(renamed as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          arr[index].name = newName
          const oldKey = `${kind}/${oldName}`
          const newKey = `${kind}/${newName}`
          // Успішний rename — очищаємо stale mutation errors для старого ключа
          delete state.validationErrors[oldKey]
          delete state.validationErrors[newKey]
          // Міграція per-object version при rename
          if (state.objectVersions[oldKey] != null) {
            state.objectVersions[newKey] = state.objectVersions[oldKey]
            delete state.objectVersions[oldKey]
          }
          // Cascade: оновити всі посилання на перейменований обʼєкт
          cascadeRenameRefs(state, kind, oldName, newName)
          bumpObjectVersion(state, kind, newName)
          state.version++
        })
        return null
      },

      duplicateObject: (kind, sourceName, newName) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const source = objects.find((o) => o.name === sourceName)
        if (!source) {
          return [
            {
              path: "",
              message: `Object "${sourceName}" not found in ${kind}`,
            },
          ]
        }

        const duplicate = { ...structuredClone(source), name: newName }
        return get().createObject(duplicate as MetadataObject)
      },

      // --- Granular attribute actions ---

      addAttribute: (kind, name, attribute) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const obj = objects.find((o) => o.name === name)
        const errorKey = `${kind}/${name}`
        if (!obj || !("attributes" in obj)) {
          const notFoundErrors = [
            { path: "", message: "Object not found or has no attributes" },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const attrs = (obj as { attributes: Attribute[] }).attributes
        if (attrs.some((a) => a.name === attribute.name)) {
          const dupErrors = [
            {
              path: "name",
              message: `Attribute "${attribute.name}" already exists`,
            },
          ]
          set((state) => {
            state.validationErrors[errorKey] = dupErrors
          })
          return dupErrors
        }

        const merged = { ...obj, attributes: [...attrs, attribute] }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const idx = findObjectIndex(arr, name)
          if (idx !== -1) {
            ;(
              arr[idx] as unknown as { attributes: Attribute[] }
            ).attributes.push(attribute)
            delete state.validationErrors[errorKey]
            state.version++
            bumpObjectVersion(state, kind, name)
          }
        })
        return null
      },

      removeAttribute: (kind, name, attrName) => {
        const key = KIND_TO_KEY[kind]
        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const idx = findObjectIndex(arr, name)
          if (idx !== -1 && "attributes" in arr[idx]) {
            const obj = arr[idx] as unknown as { attributes: Attribute[] }
            obj.attributes = obj.attributes.filter((a) => a.name !== attrName)
            delete state.validationErrors[`${kind}/${name}`]
            state.version++
            bumpObjectVersion(state, kind, name)
          }
        })
      },

      updateAttribute: (kind, name, attrName, updates) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const obj = objects.find((o) => o.name === name)
        const errorKey = `${kind}/${name}`
        if (!obj || !("attributes" in obj)) {
          const notFoundErrors = [{ path: "", message: "Object not found" }]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const attrs = (obj as { attributes: Attribute[] }).attributes
        const attrIdx = attrs.findIndex((a) => a.name === attrName)
        if (attrIdx === -1) {
          const notFoundErrors = [
            { path: "", message: `Attribute "${attrName}" not found` },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const updatedAttrs = attrs.map((a, i) =>
          i === attrIdx ? { ...a, ...updates } : a
        )
        const merged = { ...obj, attributes: updatedAttrs }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const idx = findObjectIndex(arr, name)
          if (idx !== -1) {
            const target = arr[idx] as unknown as { attributes: Attribute[] }
            Object.assign(target.attributes[attrIdx], updates)
            delete state.validationErrors[errorKey]
            state.version++
            bumpObjectVersion(state, kind, name)
          }
        })
        return null
      },

      reorderAttributes: (kind, name, fromIndex, toIndex) => {
        const key = KIND_TO_KEY[kind]
        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const idx = findObjectIndex(arr, name)
          if (idx !== -1 && "attributes" in arr[idx]) {
            const obj = arr[idx] as unknown as { attributes: Attribute[] }
            const attrs = obj.attributes
            if (
              fromIndex >= 0 &&
              fromIndex < attrs.length &&
              toIndex >= 0 &&
              toIndex < attrs.length
            ) {
              const [moved] = attrs.splice(fromIndex, 1)
              attrs.splice(toIndex, 0, moved)
              delete state.validationErrors[`${kind}/${name}`]
              state.version++
              bumpObjectVersion(state, kind, name)
            }
          }
        })
      },

      // --- Tabular section actions ---

      addTabularSection: (kind, name, section) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const obj = objects.find((o) => o.name === name)
        const errorKey = `${kind}/${name}`
        if (!obj || !("tabularSections" in obj)) {
          const notFoundErrors = [
            {
              path: "",
              message: "Object not found or has no tabular sections",
            },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const sections = (obj as { tabularSections: TabularSection[] })
          .tabularSections
        if (sections.some((s) => s.name === section.name)) {
          const dupErrors = [
            {
              path: "name",
              message: `Tabular section "${section.name}" already exists`,
            },
          ]
          set((state) => {
            state.validationErrors[errorKey] = dupErrors
          })
          return dupErrors
        }

        const merged = { ...obj, tabularSections: [...sections, section] }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const idx = findObjectIndex(arr, name)
          if (idx !== -1) {
            ;(
              arr[idx] as unknown as { tabularSections: TabularSection[] }
            ).tabularSections.push(section)
            delete state.validationErrors[errorKey]
            state.version++
            bumpObjectVersion(state, kind, name)
          }
        })
        return null
      },

      removeTabularSection: (kind, name, sectionName) => {
        const key = KIND_TO_KEY[kind]
        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const idx = findObjectIndex(arr, name)
          if (idx !== -1 && "tabularSections" in arr[idx]) {
            const obj = arr[idx] as unknown as {
              tabularSections: TabularSection[]
            }
            obj.tabularSections = obj.tabularSections.filter(
              (s) => s.name !== sectionName
            )
            delete state.validationErrors[`${kind}/${name}`]
            state.version++
            bumpObjectVersion(state, kind, name)
          }
        })
      },

      updateTabularSection: (kind, name, sectionName, updates) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const obj = objects.find((candidate) => candidate.name === name)
        const errorKey = `${kind}/${name}`

        if (!obj || !("tabularSections" in obj)) {
          const notFoundErrors = [
            {
              path: "",
              message: "Object not found or has no tabular sections",
            },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const sections = (obj as { tabularSections: TabularSection[] })
          .tabularSections
        const sectionIndex = sections.findIndex((s) => s.name === sectionName)
        if (sectionIndex === -1) {
          const notFoundErrors = [
            { path: "", message: `Tabular section "${sectionName}" not found` },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const updatedSections = sections.map((section, index) =>
          index === sectionIndex ? { ...section, ...updates } : section
        )
        const merged = { ...obj, tabularSections: updatedSections }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const objIdx = findObjectIndex(arr, name)
          if (objIdx !== -1) {
            const target = arr[objIdx] as unknown as {
              tabularSections: TabularSection[]
            }
            Object.assign(target.tabularSections[sectionIndex], updates)
            delete state.validationErrors[errorKey]
            state.version++
            bumpObjectVersion(state, kind, name)
          }
        })

        return null
      },

      renameTabularSection: (kind, name, oldSectionName, newSectionName) => {
        if (oldSectionName === newSectionName) {
          return null
        }

        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const obj = objects.find((candidate) => candidate.name === name)
        const errorKey = `${kind}/${name}`

        if (!obj || !("tabularSections" in obj)) {
          const notFoundErrors = [
            {
              path: "",
              message: "Object not found or has no tabular sections",
            },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const sections = (obj as { tabularSections: TabularSection[] })
          .tabularSections
        const sectionIndex = sections.findIndex(
          (s) => s.name === oldSectionName
        )
        if (sectionIndex === -1) {
          const notFoundErrors = [
            {
              path: "",
              message: `Tabular section "${oldSectionName}" not found`,
            },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        if (sections.some((s) => s.name === newSectionName)) {
          const dupErrors = [
            {
              path: "name",
              message: `Tabular section "${newSectionName}" already exists`,
            },
          ]
          set((state) => {
            state.validationErrors[errorKey] = dupErrors
          })
          return dupErrors
        }

        const updatedSections = sections.map((section, index) =>
          index === sectionIndex
            ? { ...section, name: newSectionName }
            : section
        )
        const merged = { ...obj, tabularSections: updatedSections }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const objIdx = findObjectIndex(arr, name)
          if (objIdx !== -1) {
            const target = arr[objIdx] as unknown as {
              tabularSections: TabularSection[]
            }
            target.tabularSections[sectionIndex].name = newSectionName
            delete state.validationErrors[errorKey]
            state.version++
            bumpObjectVersion(state, kind, name)
          }
        })

        return null
      },

      addTabularSectionAttribute: (kind, name, sectionName, attribute) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const obj = objects.find((o) => o.name === name)
        const errorKey = `${kind}/${name}`
        if (!obj || !("tabularSections" in obj)) {
          const notFoundErrors = [{ path: "", message: "Object not found" }]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const sections = (obj as { tabularSections: TabularSection[] })
          .tabularSections
        const section = sections.find((s) => s.name === sectionName)
        if (!section) {
          const notFoundErrors = [
            { path: "", message: `Tabular section "${sectionName}" not found` },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        if (section.attributes.some((a) => a.name === attribute.name)) {
          const dupErrors = [
            {
              path: "name",
              message: `Attribute "${attribute.name}" already exists in section "${sectionName}"`,
            },
          ]
          set((state) => {
            state.validationErrors[errorKey] = dupErrors
          })
          return dupErrors
        }

        const updatedSections = sections.map((s) =>
          s.name === sectionName
            ? { ...s, attributes: [...s.attributes, attribute] }
            : s
        )
        const merged = { ...obj, tabularSections: updatedSections }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const objIdx = findObjectIndex(arr, name)
          if (objIdx !== -1) {
            const target = arr[objIdx] as unknown as {
              tabularSections: TabularSection[]
            }
            const sec = target.tabularSections.find(
              (s) => s.name === sectionName
            )
            if (sec) {
              sec.attributes.push(attribute)
              delete state.validationErrors[errorKey]
              state.version++
              bumpObjectVersion(state, kind, name)
            }
          }
        })
        return null
      },

      removeTabularSectionAttribute: (kind, name, sectionName, attrName) => {
        const key = KIND_TO_KEY[kind]
        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const objIdx = findObjectIndex(arr, name)
          if (objIdx !== -1 && "tabularSections" in arr[objIdx]) {
            const target = arr[objIdx] as unknown as {
              tabularSections: TabularSection[]
            }
            const sec = target.tabularSections.find(
              (s) => s.name === sectionName
            )
            if (sec) {
              sec.attributes = sec.attributes.filter((a) => a.name !== attrName)
              delete state.validationErrors[`${kind}/${name}`]
              state.version++
              bumpObjectVersion(state, kind, name)
            }
          }
        })
      },

      updateTabularSectionAttribute: (
        kind,
        name,
        sectionName,
        attrName,
        updates
      ) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const obj = objects.find((o) => o.name === name)
        const errorKey = `${kind}/${name}`
        if (!obj || !("tabularSections" in obj)) {
          const notFoundErrors = [{ path: "", message: "Object not found" }]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const sections = (obj as { tabularSections: TabularSection[] })
          .tabularSections
        const section = sections.find((s) => s.name === sectionName)
        if (!section) {
          const notFoundErrors = [
            { path: "", message: `Section "${sectionName}" not found` },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const attrIdx = section.attributes.findIndex((a) => a.name === attrName)
        if (attrIdx === -1) {
          const notFoundErrors = [
            { path: "", message: `Attribute "${attrName}" not found` },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const updatedSections = sections.map((s) =>
          s.name === sectionName
            ? {
                ...s,
                attributes: s.attributes.map((a, i) =>
                  i === attrIdx ? { ...a, ...updates } : a
                ),
              }
            : s
        )
        const merged = { ...obj, tabularSections: updatedSections }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const objIdx = findObjectIndex(arr, name)
          if (objIdx !== -1) {
            const target = arr[objIdx] as unknown as {
              tabularSections: TabularSection[]
            }
            const sec = target.tabularSections.find(
              (s) => s.name === sectionName
            )
            if (sec) {
              Object.assign(sec.attributes[attrIdx], updates)
              delete state.validationErrors[errorKey]
              state.version++
              bumpObjectVersion(state, kind, name)
            }
          }
        })
        return null
      },

      reorderTabularSectionAttributes: (
        kind,
        name,
        sectionName,
        fromIndex,
        toIndex
      ) => {
        const key = KIND_TO_KEY[kind]
        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const objIdx = findObjectIndex(arr, name)
          if (objIdx !== -1 && "tabularSections" in arr[objIdx]) {
            const target = arr[objIdx] as unknown as {
              tabularSections: TabularSection[]
            }
            const sec = target.tabularSections.find(
              (s) => s.name === sectionName
            )
            if (sec) {
              const attrs = sec.attributes
              if (
                fromIndex >= 0 &&
                fromIndex < attrs.length &&
                toIndex >= 0 &&
                toIndex < attrs.length
              ) {
                const [moved] = attrs.splice(fromIndex, 1)
                attrs.splice(toIndex, 0, moved)
                delete state.validationErrors[`${kind}/${name}`]
                state.version++
                bumpObjectVersion(state, kind, name)
              }
            }
          }
        })
      },

      // --- Enum value actions ---

      addEnumValue: (name, value) => {
        const objects = get().model.enumerations
        const obj = objects.find((o) => o.name === name)
        const errorKey = `Enumeration/${name}`
        if (!obj) {
          const notFoundErrors = [
            { path: "", message: `Enumeration "${name}" not found` },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        if (obj.values.some((v) => v.name === value.name)) {
          const dupErrors = [
            { path: "name", message: `Value "${value.name}" already exists` },
          ]
          set((state) => {
            state.validationErrors[errorKey] = dupErrors
          })
          return dupErrors
        }

        const merged = { ...obj, values: [...obj.values, value] }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const target = state.model.enumerations.find((o) => o.name === name)
          if (target) {
            target.values.push(value)
            delete state.validationErrors[errorKey]
            state.version++
            bumpObjectVersion(state, "Enumeration", name)
          }
        })
        return null
      },

      removeEnumValue: (name, valueName) => {
        set((state) => {
          const target = state.model.enumerations.find((o) => o.name === name)
          if (target) {
            target.values = target.values.filter((v) => v.name !== valueName)
            delete state.validationErrors[`Enumeration/${name}`]
            state.version++
            bumpObjectVersion(state, "Enumeration", name)
          }
        })
      },

      updateEnumValue: (name, valueName, updates) => {
        const objects = get().model.enumerations
        const obj = objects.find((o) => o.name === name)
        const errorKey = `Enumeration/${name}`
        if (!obj) {
          const notFoundErrors = [
            { path: "", message: `Enumeration "${name}" not found` },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const valIdx = obj.values.findIndex((v) => v.name === valueName)
        if (valIdx === -1) {
          const notFoundErrors = [
            { path: "", message: `Value "${valueName}" not found` },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const updatedValues = obj.values.map((v, i) =>
          i === valIdx ? { ...v, ...updates } : v
        )
        const merged = { ...obj, values: updatedValues }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const target = state.model.enumerations.find((o) => o.name === name)
          if (target) {
            Object.assign(target.values[valIdx], updates)
            delete state.validationErrors[errorKey]
            state.version++
            bumpObjectVersion(state, "Enumeration", name)
          }
        })
        return null
      },

      reorderEnumValues: (name, fromIndex, toIndex) => {
        set((state) => {
          const target = state.model.enumerations.find((o) => o.name === name)
          if (
            target &&
            fromIndex >= 0 &&
            fromIndex < target.values.length &&
            toIndex >= 0 &&
            toIndex < target.values.length
          ) {
            const [moved] = target.values.splice(fromIndex, 1)
            target.values.splice(toIndex, 0, moved)
            delete state.validationErrors[`Enumeration/${name}`]
            state.version++
            bumpObjectVersion(state, "Enumeration", name)
          }
        })
      },

      // --- Register dimension/resource actions ---

      addDimension: (kind, name, attribute) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const obj = objects.find((o) => o.name === name)
        const errorKey = `${kind}/${name}`
        if (!obj || !("dimensions" in obj)) {
          const notFoundErrors = [
            { path: "", message: "Object not found or has no dimensions" },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const dims = (obj as { dimensions: Attribute[] }).dimensions
        if (dims.some((d) => d.name === attribute.name)) {
          const dupErrors = [
            {
              path: "name",
              message: `Dimension "${attribute.name}" already exists`,
            },
          ]
          set((state) => {
            state.validationErrors[errorKey] = dupErrors
          })
          return dupErrors
        }

        const merged = { ...obj, dimensions: [...dims, attribute] }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const idx = findObjectIndex(arr, name)
          if (idx !== -1) {
            ;(
              arr[idx] as unknown as { dimensions: Attribute[] }
            ).dimensions.push(attribute)
            delete state.validationErrors[errorKey]
            state.version++
            bumpObjectVersion(state, kind, name)
          }
        })
        return null
      },

      removeDimension: (kind, name, attrName) => {
        const key = KIND_TO_KEY[kind]
        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const idx = findObjectIndex(arr, name)
          if (idx !== -1 && "dimensions" in arr[idx]) {
            const obj = arr[idx] as unknown as { dimensions: Attribute[] }
            obj.dimensions = obj.dimensions.filter((d) => d.name !== attrName)
            delete state.validationErrors[`${kind}/${name}`]
            state.version++
            bumpObjectVersion(state, kind, name)
          }
        })
      },

      addResource: (kind, name, attribute) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const obj = objects.find((o) => o.name === name)
        const errorKey = `${kind}/${name}`
        if (!obj || !("resources" in obj)) {
          const notFoundErrors = [
            { path: "", message: "Object not found or has no resources" },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const res = (obj as { resources: Attribute[] }).resources
        if (res.some((r) => r.name === attribute.name)) {
          const dupErrors = [
            {
              path: "name",
              message: `Resource "${attribute.name}" already exists`,
            },
          ]
          set((state) => {
            state.validationErrors[errorKey] = dupErrors
          })
          return dupErrors
        }

        const merged = { ...obj, resources: [...res, attribute] }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const idx = findObjectIndex(arr, name)
          if (idx !== -1) {
            ;(arr[idx] as unknown as { resources: Attribute[] }).resources.push(
              attribute
            )
            delete state.validationErrors[errorKey]
            state.version++
            bumpObjectVersion(state, kind, name)
          }
        })
        return null
      },

      removeResource: (kind, name, attrName) => {
        const key = KIND_TO_KEY[kind]
        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const idx = findObjectIndex(arr, name)
          if (idx !== -1 && "resources" in arr[idx]) {
            const obj = arr[idx] as unknown as { resources: Attribute[] }
            obj.resources = obj.resources.filter((r) => r.name !== attrName)
            delete state.validationErrors[`${kind}/${name}`]
            state.version++
            bumpObjectVersion(state, kind, name)
          }
        })
      },

      updateDimension: (kind, name, attrName, updates) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const obj = objects.find((o) => o.name === name)
        const errorKey = `${kind}/${name}`
        if (!obj || !("dimensions" in obj)) {
          const notFoundErrors = [{ path: "", message: "Object not found" }]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const dims = (obj as { dimensions: Attribute[] }).dimensions
        const attrIdx = dims.findIndex((a) => a.name === attrName)
        if (attrIdx === -1) {
          const notFoundErrors = [
            { path: "", message: `Dimension "${attrName}" not found` },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const updatedDims = dims.map((a, i) =>
          i === attrIdx ? { ...a, ...updates } : a
        )
        const merged = { ...obj, dimensions: updatedDims }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const idx = findObjectIndex(arr, name)
          if (idx !== -1) {
            const target = arr[idx] as unknown as { dimensions: Attribute[] }
            Object.assign(target.dimensions[attrIdx], updates)
            delete state.validationErrors[errorKey]
            state.version++
            bumpObjectVersion(state, kind, name)
          }
        })
        return null
      },

      reorderDimensions: (kind, name, fromIndex, toIndex) => {
        const key = KIND_TO_KEY[kind]
        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const idx = findObjectIndex(arr, name)
          if (idx !== -1 && "dimensions" in arr[idx]) {
            const obj = arr[idx] as unknown as { dimensions: Attribute[] }
            const dims = obj.dimensions
            if (
              fromIndex >= 0 &&
              fromIndex < dims.length &&
              toIndex >= 0 &&
              toIndex < dims.length
            ) {
              const [moved] = dims.splice(fromIndex, 1)
              dims.splice(toIndex, 0, moved)
              delete state.validationErrors[`${kind}/${name}`]
              state.version++
              bumpObjectVersion(state, kind, name)
            }
          }
        })
      },

      updateResource: (kind, name, attrName, updates) => {
        const key = KIND_TO_KEY[kind]
        const objects = get().model[key] as MetadataObject[]
        const obj = objects.find((o) => o.name === name)
        const errorKey = `${kind}/${name}`
        if (!obj || !("resources" in obj)) {
          const notFoundErrors = [{ path: "", message: "Object not found" }]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const res = (obj as { resources: Attribute[] }).resources
        const attrIdx = res.findIndex((a) => a.name === attrName)
        if (attrIdx === -1) {
          const notFoundErrors = [
            { path: "", message: `Resource "${attrName}" not found` },
          ]
          set((state) => {
            state.validationErrors[errorKey] = notFoundErrors
          })
          return notFoundErrors
        }

        const updatedRes = res.map((a, i) =>
          i === attrIdx ? { ...a, ...updates } : a
        )
        const merged = { ...obj, resources: updatedRes }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const idx = findObjectIndex(arr, name)
          if (idx !== -1) {
            const target = arr[idx] as unknown as { resources: Attribute[] }
            Object.assign(target.resources[attrIdx], updates)
            delete state.validationErrors[errorKey]
            state.version++
            bumpObjectVersion(state, kind, name)
          }
        })
        return null
      },

      reorderResources: (kind, name, fromIndex, toIndex) => {
        const key = KIND_TO_KEY[kind]
        set((state) => {
          const arr = state.model[key] as MetadataObject[]
          const idx = findObjectIndex(arr, name)
          if (idx !== -1 && "resources" in arr[idx]) {
            const obj = arr[idx] as unknown as { resources: Attribute[] }
            const res = obj.resources
            if (
              fromIndex >= 0 &&
              fromIndex < res.length &&
              toIndex >= 0 &&
              toIndex < res.length
            ) {
              const [moved] = res.splice(fromIndex, 1)
              res.splice(toIndex, 0, moved)
              delete state.validationErrors[`${kind}/${name}`]
              state.version++
              bumpObjectVersion(state, kind, name)
            }
          }
        })
      },

      // --- Posting actions (Document) ---

      updateMovement: (name, registerRef, movement) => {
        const objects = get().model.documents as MetadataObject[]
        const index = findObjectIndex(objects, name)
        const errorKey = `Document/${name}`
        if (index === -1) return [{ path: '', message: `Object "${name}" not found` }]

        const doc = objects[index] as Record<string, unknown>
        const currentPosting =
          typeof doc.posting === 'object' && doc.posting !== null
            ? (doc.posting as { movements: PostingMovement[]; validations: PostingValidation[] })
            : { movements: [] as PostingMovement[], validations: [] as PostingValidation[] }

        const existingIdx = currentPosting.movements.findIndex(
          (m) =>
            m.register.kind === registerRef.kind &&
            m.register.name === registerRef.name,
        )
        const updatedMovements =
          existingIdx >= 0
            ? currentPosting.movements.map((m, i) =>
                i === existingIdx ? movement : m,
              )
            : [...currentPosting.movements, movement]

        const updatedPosting = { ...currentPosting, movements: updatedMovements }
        const merged = { ...objects[index], posting: updatedPosting }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const arr = state.model.documents as MetadataObject[]
          ;(arr[index] as Record<string, unknown>).posting = updatedPosting
          delete state.validationErrors[errorKey]
          state.version++
          bumpObjectVersion(state, 'Document', name)
        })
        return null
      },

      removeMovement: (name, registerRef) => {
        const objects = get().model.documents as MetadataObject[]
        const index = findObjectIndex(objects, name)
        if (index === -1) return

        const doc = objects[index] as Record<string, unknown>
        if (typeof doc.posting !== 'object' || doc.posting === null) return

        set((state) => {
          const arr = state.model.documents as MetadataObject[]
          const d = arr[index] as Record<string, unknown>
          const posting = d.posting as {
            movements: PostingMovement[]
            validations: PostingValidation[]
          }
          d.posting = {
            ...posting,
            movements: posting.movements.filter(
              (m) =>
                !(
                  m.register.kind === registerRef.kind &&
                  m.register.name === registerRef.name
                ),
            ),
            // Також видаляємо validations для цього регістру
            validations: posting.validations.filter(
              (v) =>
                !(
                  v.register.kind === registerRef.kind &&
                  v.register.name === registerRef.name
                ),
            ),
          }
          // Нормалізація: порожній posting -> undefined
          const updated = d.posting as { movements: unknown[]; validations: unknown[] }
          if (updated.movements.length === 0 && updated.validations.length === 0) {
            d.posting = undefined
          }
          state.version++
          bumpObjectVersion(state, 'Document', name)
        })
      },

      addPostingValidation: (name, validation) => {
        const objects = get().model.documents as MetadataObject[]
        const index = findObjectIndex(objects, name)
        const errorKey = `Document/${name}`
        if (index === -1) return [{ path: '', message: `Object "${name}" not found` }]

        const doc = objects[index] as Record<string, unknown>
        const currentPosting =
          typeof doc.posting === 'object' && doc.posting !== null
            ? (doc.posting as { movements: PostingMovement[]; validations: PostingValidation[] })
            : { movements: [] as PostingMovement[], validations: [] as PostingValidation[] }

        const updatedPosting = {
          ...currentPosting,
          validations: [...currentPosting.validations, validation],
        }
        const merged = { ...objects[index], posting: updatedPosting }
        const errors = validateObject(merged as MetadataObject)
        if (errors) {
          set((state) => {
            state.validationErrors[errorKey] = errors
          })
          return errors
        }

        set((state) => {
          const arr = state.model.documents as MetadataObject[]
          ;(arr[index] as Record<string, unknown>).posting = updatedPosting
          delete state.validationErrors[errorKey]
          state.version++
          bumpObjectVersion(state, 'Document', name)
        })
        return null
      },

      removePostingValidation: (name, validationIndex) => {
        const objects = get().model.documents as MetadataObject[]
        const objIdx = findObjectIndex(objects, name)
        if (objIdx === -1) return

        const doc = objects[objIdx] as Record<string, unknown>
        if (typeof doc.posting !== 'object' || doc.posting === null) return

        set((state) => {
          const arr = state.model.documents as MetadataObject[]
          const d = arr[objIdx] as Record<string, unknown>
          const posting = d.posting as {
            movements: PostingMovement[]
            validations: PostingValidation[]
          }
          d.posting = {
            ...posting,
            validations: posting.validations.filter(
              (_, i) => i !== validationIndex,
            ),
          }
          // Нормалізація: порожній posting -> undefined
          const updated = d.posting as { movements: unknown[]; validations: unknown[] }
          if (updated.movements.length === 0 && updated.validations.length === 0) {
            d.posting = undefined
          }
          state.version++
          bumpObjectVersion(state, 'Document', name)
        })
      },
    })),
    {
      // zundo: відстежувати тільки зміни model, без validationErrors/objectVersions
      equality: (pastState, currentState) =>
        pastState.model === currentState.model,
      // Обмеження розміру стеку undo
      limit: 100,
    }
  )
)
