import { useEffect } from "react"
import { metadataObjectSchema, isPostingCompatible, KIND_TO_KEY } from "@simetra/core"
import type {
  AccumulationRegister,
  InformationRegister,
  MetadataKind,
  MetadataObject,
  Attribute,
  ProjectModel,
} from "@simetra/core"
import { useMetadataStore, type ValidationError } from "@/stores/metadata-store"
import { resolveZodPath } from "@/lib/resolve-zod-path"

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

/** Збирає всі атрибути обʼєкта з усіх колекцій з path-міткою */
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
        result.push({ path: `tabularSections.${ts.name}.${attr.name}`, attr })
      }
    }
  }

  return result
}

/** Валідує один обʼєкт і повертає масив помилок (порожній якщо валідний) */
function validateSingleObject(
  model: ProjectModel,
  _kind: MetadataKind,
  obj: MetadataObject
): ValidationError[] {
  const errors: ValidationError[] = []

  // 1. Валідація Zod-схемою (required fields, формат тощо)
  const zodResult = metadataObjectSchema.safeParse(obj)
  if (!zodResult.success) {
    for (const issue of zodResult.error.issues) {
      errors.push({
        path: resolveZodPath(obj, issue.path as (string | number)[]),
        message: issue.message,
      })
    }
  }

  // 2. FR-050: перевірка існування reference targets
  const allAttrs = collectAllAttributes(obj)
  for (const { path, attr } of allAttrs) {
    if (attr.type === "Ref" && attr.ref) {
      if (!refExists(model, attr.ref.kind, attr.ref.name)) {
        errors.push({
          path,
          message: `ref:${attr.ref.kind}/${attr.ref.name}`,
        })
      }
    }
    if (attr.allowedTypes) {
      for (const allowed of attr.allowedTypes) {
        if (!refExists(model, allowed.kind, allowed.name)) {
          errors.push({
            path: `${path}.allowedTypes`,
            message: `ref:${allowed.kind}/${allowed.name}`,
          })
        }
      }
    }
  }

  // 3. Перевірка object-level refs (owners, recorderTypes, registerMovements)
  if ("owners" in obj && Array.isArray(obj.owners)) {
    for (const ref of obj.owners as { kind: MetadataKind; name: string }[]) {
      if (!refExists(model, ref.kind, ref.name)) {
        errors.push({ path: "owners", message: `ref:${ref.kind}/${ref.name}` })
      }
    }
  }
  if ("recorderTypes" in obj && Array.isArray(obj.recorderTypes)) {
    for (const ref of obj.recorderTypes as {
      kind: MetadataKind
      name: string
    }[]) {
      if (!refExists(model, ref.kind, ref.name)) {
        errors.push({
          path: "recorderTypes",
          message: `ref:${ref.kind}/${ref.name}`,
        })
      }
    }
  }
  if ("registerMovements" in obj && Array.isArray(obj.registerMovements)) {
    for (const ref of obj.registerMovements as {
      kind: MetadataKind
      name: string
    }[]) {
      if (!refExists(model, ref.kind, ref.name)) {
        errors.push({
          path: "registerMovements",
          message: `ref:${ref.kind}/${ref.name}`,
        })
      }
    }
  }

  // 4. Перевірка posting refs (movements + validations)
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
        if (!refExists(model, movement.register.kind, movement.register.name)) {
          errors.push({
            path: "posting.movements",
            message: `ref:${movement.register.kind}/${movement.register.name}`,
          })
        }
      }
    }
    if (posting.validations) {
      for (const validation of posting.validations) {
        if (
          !refExists(model, validation.register.kind, validation.register.name)
        ) {
          errors.push({
            path: "posting.validations",
            message: `ref:${validation.register.kind}/${validation.register.name}`,
          })
        }
      }
    }
  }

  // 5. Cross-check: posting register refs мають бути підмножиною registerMovements
  if (
    "posting" in obj &&
    typeof obj.posting === "object" &&
    obj.posting !== null &&
    "registerMovements" in obj &&
    Array.isArray(obj.registerMovements)
  ) {
    const posting = obj.posting as {
      movements?: { register: { kind: string; name: string } }[]
    }
    const regMovements = obj.registerMovements as { kind: string; name: string }[]
    if (posting.movements) {
      for (const movement of posting.movements) {
        const declared = regMovements.some(
          (r) =>
            r.kind === movement.register.kind &&
            r.name === movement.register.name,
        )
        if (!declared) {
          errors.push({
            path: "posting.movements",
            message: `posting.movements contains register ${movement.register.kind}/${movement.register.name} not declared in registerMovements`,
          })
        }
      }
    }
  }

  // 6. Перевірка сумісності регістрів у posting.movements
  if (
    "posting" in obj &&
    typeof obj.posting === "object" &&
    obj.posting !== null
  ) {
    const posting = obj.posting as {
      movements?: {
        register: { kind: MetadataKind; name: string }
        mappings: { dimensions: Record<string, string> }
      }[]
    }
    if (posting.movements) {
      for (const movement of posting.movements) {
        const reg = findRegisterInModel(model, movement.register)
        if (reg) {
          const compat = isPostingCompatible(reg)
          if (!compat.compatible) {
            errors.push({
              path: 'posting.movements',
              message: `Регістр ${movement.register.kind}/${movement.register.name} не сумісний з проведенням: ${compat.reason}`,
            })
          }
          // Перевірка неповних маппінгів dimensions
          const missingDims = reg.dimensions.filter(
            (d) => !movement.mappings.dimensions[d.name],
          )
          if (missingDims.length > 0) {
            errors.push({
              path: 'posting.movements',
              message: `Рух до ${movement.register.name}: не заповнені dimensions: ${missingDims.map((d) => d.name).join(', ')}`,
            })
          }
        }
      }
    }
  }

  // 7. Warning: validations без movements не мають сенсу
  if (
    "posting" in obj &&
    typeof obj.posting === "object" &&
    obj.posting !== null
  ) {
    const posting = obj.posting as {
      movements?: unknown[]
      validations?: unknown[]
    }
    if (
      posting.validations &&
      posting.validations.length > 0 &&
      (!posting.movements || posting.movements.length === 0)
    ) {
      errors.push({
        path: "posting.validations",
        message:
          "posting has validations but no movements — validations will have no effect",
      })
    }
  }

  return errors
}

const ALL_KINDS: MetadataKind[] = [
  "Catalog",
  "Document",
  "Enumeration",
  "InformationRegister",
  "AccumulationRegister",
  "Constant",
  "CustomTable",
]

/**
 * Хук project-level валідації (debounced 300ms).
 * Перевіряє всі обʼєкти моделі на:
 * - Zod-відповідність (required fields, формат)
 * - FR-050: існування reference targets
 * - Унікальність імен обʼєктів в межах kind (для імпортованих моделей)
 * Результат зберігається у `modelErrors` store.
 */
export function useModelValidation() {
  const model = useMetadataStore((s) => s.model)
  const setModelErrors = useMetadataStore((s) => s.setModelErrors)

  useEffect(() => {
    const timer = setTimeout(() => {
      const newErrors: Record<string, ValidationError[]> = {}

      // Перевірка дублікатів імен в межах kind — рівно одна помилка на дублюючий ключ
      for (const kind of ALL_KINDS) {
        const key = KIND_TO_KEY[kind]
        const objects = model[key] as MetadataObject[]
        const nameCounts = new Map<string, number>()
        for (const obj of objects) {
          nameCounts.set(obj.name, (nameCounts.get(obj.name) ?? 0) + 1)
        }
        for (const [name, count] of nameCounts) {
          if (count > 1) {
            const dupKey = `${kind}/${name}`
            const existing = newErrors[dupKey] ?? []
            existing.push({
              path: "name",
              message: `Duplicate name "${name}" in ${kind}`,
            })
            newErrors[dupKey] = existing
          }
        }
      }

      // Валідація кожного обʼєкта: Zod + reachable refs
      for (const kind of ALL_KINDS) {
        const key = KIND_TO_KEY[kind]
        const objects = model[key] as MetadataObject[]

        for (const obj of objects) {
          const objErrors = validateSingleObject(model, kind, obj)
          if (objErrors.length > 0) {
            const objKey = `${kind}/${obj.name}`
            const existing = newErrors[objKey] ?? []
            newErrors[objKey] = [...existing, ...objErrors]
          }
        }
      }

      setModelErrors(newErrors)
    }, 300)

    return () => clearTimeout(timer)
  }, [model, setModelErrors])
}
