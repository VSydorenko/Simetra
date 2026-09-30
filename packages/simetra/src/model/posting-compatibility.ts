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

/** Перевіряє чи регістр може бути цільовим для posting документа */
export function isPostingCompatible(
  register: RegisterDef,
  options: PostingCompatibilityOptions = {}
): PostingCompatibilityResult {
  const warnings: string[] = []

  // AccumulationRegister — compatible, але може обмежуватися recorderTypes
  if (register.kind === "AccumulationRegister") {
    if (register.recorderTypes.length === 0) {
      warnings.push(
        "AccumulationRegister has an empty recorderTypes list and accepts movements from any document"
      )
      return { compatible: true, warnings }
    }

    if (!options.recorder) {
      warnings.push(
        "Cannot verify recorderTypes without the current document reference"
      )
      return { compatible: true, warnings }
    }

    const isAllowed = register.recorderTypes.some(
      (recorder) =>
        recorder.kind === options.recorder?.kind &&
        recorder.name === options.recorder?.name
    )

    if (!isAllowed) {
      return {
        compatible: false,
        reason: `AccumulationRegister allows only ${register.recorderTypes
          .map((recorder) => `${recorder.kind}/${recorder.name}`)
          .join(", ")} in recorderTypes`,
      }
    }

    return { compatible: true }
  }

  // InformationRegister writeMode=RecorderSubordinate — compatible
  if (register.kind === "InformationRegister") {
    if (register.writeMode === "RecorderSubordinate") {
      return { compatible: true }
    }
    return {
      compatible: false,
      reason:
        "InformationRegister with writeMode=Independent has no recorder lifecycle and cannot be used as a posting target",
    }
  }

  return {
    compatible: false,
    reason: "Unknown register kind",
  }
}
