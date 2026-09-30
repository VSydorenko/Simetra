import { KIND_REGISTRY } from "./kinds/registry"
import type {
  AccumulationRegister,
  InformationRegister,
  MetadataRef,
} from "./schemas"

type RegisterDef = AccumulationRegister | InformationRegister

export interface PostingCompatibilityOptions {
  recorder?: MetadataRef
}

export interface PostingCompatibilityResult {
  compatible: boolean
  reason?: string
  warnings?: string[]
}

/**
 * Перевіряє, чи регістр може бути цільовим для проведення документа. Рухи
 * пише лише оболонка проведення через реєстратора, тож ціллю годиться регістр,
 * чиї стандартні колонки (реєстр видів) мають реєстратора.
 */
export function isPostingCompatible(
  register: RegisterDef,
  options: PostingCompatibilityOptions = {}
): PostingCompatibilityResult {
  const hasRecorder = KIND_REGISTRY[register.kind]
    .standardColumns(register)
    .some((column) => column.ref === "recorders")

  if (!hasRecorder) {
    return {
      compatible: false,
      reason: `${register.kind} "${register.name}" has no recorder and cannot be used as a posting target`,
    }
  }

  const warnings: string[] = []
  if (register.recorderTypes.length === 0) {
    warnings.push(
      `${register.kind} "${register.name}" has an empty recorderTypes list and accepts movements from any document`
    )
    return { compatible: true, warnings }
  }

  if (!options.recorder) {
    warnings.push(
      "Cannot verify recorderTypes without the current document reference"
    )
    return { compatible: true, warnings }
  }

  const { recorder } = options
  const isAllowed = register.recorderTypes.some(
    (allowed) =>
      allowed.kind === recorder.kind && allowed.name === recorder.name
  )
  if (!isAllowed) {
    return {
      compatible: false,
      reason: `${register.kind} "${register.name}" allows only ${register.recorderTypes
        .map((allowed) => `${allowed.kind}/${allowed.name}`)
        .join(", ")} in recorderTypes`,
    }
  }

  return { compatible: true }
}
