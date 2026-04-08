export const TECHNICAL_NAME_PATTERNS = {
  PascalCase: /^[A-Z][A-Za-z0-9]*$/,
  snake_case: /^[a-z][a-z0-9_]*$/,
} as const

export type TechnicalNameFormat = keyof typeof TECHNICAL_NAME_PATTERNS

export const STRING_LENGTH = 50
export const NUMERIC_PRECISION = 15
export const NUMERIC_SCALE = 2

export function matchesTechnicalName(
  value: string,
  format: TechnicalNameFormat,
): boolean {
  return TECHNICAL_NAME_PATTERNS[format].test(value)
}
