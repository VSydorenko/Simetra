import {
  formatValidationMessage,
} from "@simetra/core"
import i18n from "@/i18n"

export function translateValidationMessage(message: string): string {
  return formatValidationMessage(message, {
    translate: (key, values) => i18n.t(key, values),
  })
}
