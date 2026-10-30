// Єдина точка, через яку тести @simetrajs/designer беруть фікстури `simetra`
// (план designer-1, рішення 12): лише реекспорти, без логіки. Тека `test/` не
// входить в `exports` пакета, тож виробничий код designer її не імпортує —
// це тримає лінт-зона `packages/designer/eslint.zones.js`.
export {
  readReferenceDomain,
  REFERENCE_METADATA,
} from "../src/compiler/__tests__/fixtures/reference-domain"
export * from "../src/compiler/__tests__/helpers"
export * from "../src/compiler/__tests__/fixtures/promotion"
export {
  ATTACHMENTS_TABLE,
  CHECKLIST_TABLE,
  COMMENT_FILE,
  COMMENT_TABLE,
  ORG_ADMIN_ID,
  adminRoles,
  commandCoreLayer,
  policyDomain,
  promotableTaskNote,
  refAttribute,
  TASK_FILE,
  TASK_NOTE_ADOPTED_TABLE,
  taskNoteMapping,
  writableRegister,
  writeRoles,
  type Layer,
} from "../src/compiler/__tests__/fixtures/rights"
export * from "../src/schema/__tests__/fixtures/e1-fixtures"
export * from "./db/connection"
export * from "./db/fingerprint"
export { readCatalog, type CatalogShape, type CatalogTable } from "./db/catalog"
