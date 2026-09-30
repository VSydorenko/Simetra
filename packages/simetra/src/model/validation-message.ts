export interface ValidationMessageValues {
  [key: string]: string | number | boolean
}

export interface ValidationMessageDescriptor {
  key: string
  values?: ValidationMessageValues
}

const VALIDATION_MESSAGE_PREFIX = "__simetra_i18n__:"

export function createValidationMessage(
  key: string,
  values?: ValidationMessageValues
): string {
  return `${VALIDATION_MESSAGE_PREFIX}${JSON.stringify({ key, values })}`
}

export function parseValidationMessage(
  message: string
): ValidationMessageDescriptor | null {
  if (!message.startsWith(VALIDATION_MESSAGE_PREFIX)) {
    return null
  }

  try {
    return JSON.parse(
      message.slice(VALIDATION_MESSAGE_PREFIX.length)
    ) as ValidationMessageDescriptor
  } catch {
    return null
  }
}

function formatDefaultValidationMessage(
  descriptor: ValidationMessageDescriptor
): string {
  const values = descriptor.values ?? {}

  switch (descriptor.key) {
    case "validation.enumValue.nameRequired":
      return "Enumeration value name must not be empty"
    case "validation.enumValue.namePascalCase":
      return "Enumeration value name must use PascalCase with Latin letters and digits only"
    case "validation.field.stringLengthRequired":
      return `String type requires length. Default value: ${values.defaultValue}.`
    case "validation.field.numericPrecisionRequired":
      return `Numeric type requires precision. Default value: ${values.defaultValue}.`
    case "validation.field.numericScaleRequired":
      return `Numeric type requires scale. Default value: ${values.defaultValue}.`
    case "validation.field.refTargetRequired":
      return "Ref type requires a target object or at least one allowed type."
    case "validation.posting.acceptsAnyRecorder":
      return "AccumulationRegister has an empty recorderTypes list and accepts movements from any document"
    case "validation.posting.missingRecorderContext":
      return "Cannot verify recorderTypes without the current document reference"
    case "validation.posting.allowedRecorderTypes":
      return `AccumulationRegister allows only ${values.types} in recorderTypes`
    case "validation.posting.informationRegisterIndependent":
      return "InformationRegister with writeMode=Independent has no recorder lifecycle and cannot be used as a posting target"
    case "validation.posting.unknownRegisterKind":
      return "Unknown register kind"
    default:
      return descriptor.key
  }
}

export function formatValidationMessage(
  message: string,
  options?: {
    translate?: (key: string, values?: ValidationMessageValues) => string
  }
): string {
  const descriptor = parseValidationMessage(message)
  if (!descriptor) {
    return message
  }

  if (options?.translate) {
    return options.translate(descriptor.key, descriptor.values)
  }

  return formatDefaultValidationMessage(descriptor)
}
