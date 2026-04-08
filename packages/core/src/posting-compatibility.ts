import type {
  AccumulationRegister,
  InformationRegister,
  MetadataRef,
} from "./schemas"
import { createValidationMessage } from "./validation-message"

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
  options: PostingCompatibilityOptions = {},
): PostingCompatibilityResult {
  const warnings: string[] = []

  // AccumulationRegister — compatible, але може обмежуватися recorderTypes
  if (register.kind === "AccumulationRegister") {
    if (register.recorderTypes.length === 0) {
      warnings.push(
        createValidationMessage("validation.posting.acceptsAnyRecorder"),
      )
      return { compatible: true, warnings }
    }

    if (!options.recorder) {
      warnings.push(
        createValidationMessage("validation.posting.missingRecorderContext"),
      )
      return { compatible: true, warnings }
    }

    const isAllowed = register.recorderTypes.some(
      (recorder) =>
        recorder.kind === options.recorder?.kind &&
        recorder.name === options.recorder?.name,
    )

    if (!isAllowed) {
      return {
        compatible: false,
        reason: createValidationMessage(
          "validation.posting.allowedRecorderTypes",
          {
            types: register.recorderTypes
              .map((recorder) => `${recorder.kind}/${recorder.name}`)
              .join(", "),
          }
        ),
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
      reason: createValidationMessage(
        "validation.posting.informationRegisterIndependent"
      ),
    }
  }

  return {
    compatible: false,
    reason: createValidationMessage("validation.posting.unknownRegisterKind"),
  }
}
