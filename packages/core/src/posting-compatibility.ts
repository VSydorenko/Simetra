import type { AccumulationRegister, InformationRegister } from "./schemas"

type RegisterDef = AccumulationRegister | InformationRegister

export interface PostingCompatibilityResult {
  compatible: boolean
  reason?: string
}

/** Перевіряє чи регістр може бути цільовим для posting документа */
export function isPostingCompatible(
  register: RegisterDef
): PostingCompatibilityResult {
  // AccumulationRegister — завжди compatible
  if (register.kind === "AccumulationRegister") {
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
        "InformationRegister with writeMode=Independent has no recorder lifecycle and cannot be used as posting target",
    }
  }

  return { compatible: false, reason: "Unknown register kind" }
}
