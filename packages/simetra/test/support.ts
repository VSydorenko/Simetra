// Єдина точка, через яку тести @simetra/designer беруть фікстури `simetra`
// (план designer-1, рішення 12): лише реекспорти, без логіки. Тека `test/` не
// входить в `exports` пакета, тож виробничий код designer її не імпортує —
// це тримає лінт-зона `packages/designer/eslint.zones.js`.
export {
  readReferenceDomain,
  REFERENCE_METADATA,
} from "../src/compiler/__tests__/fixtures/reference-domain"
export * from "../src/compiler/__tests__/helpers"
export * from "../src/schema/__tests__/fixtures/e1-fixtures"
export * from "./db/connection"
