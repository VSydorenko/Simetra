import { matchesTechnicalName, type TechnicalNameFormat } from "@simetra/core"
import i18n from "@/i18n"

export function validateTechnicalName(
  value: string,
  format: TechnicalNameFormat
): string | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return i18n.t("validation.technicalName.required")
  }

  if (!matchesTechnicalName(trimmed, format)) {
    return i18n.t(`validation.technicalName.${format}`)
  }

  return null
}
