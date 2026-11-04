// Єдина точка, через яку тести @simetrajs/designer беруть фікстури `simetra`
// — лише реекспорти, без логіки. Тека `test/` не
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
  GAUGE_LOG_TABLE,
  GAUGE_TABLE,
  GAUGE_WRITER_ID,
  GLOBAL_ADMIN_ID,
  MEMBER_CREATOR_ID,
  MEMBER_EDITOR_ID,
  MEMBER_TITLE,
  memberCreator,
  RIGHTS_ADMIN_ID,
  rightsAdminReadingMembers,
  runtimeValuesLayer,
  policyDomain,
  requiredMemberAttribute,
  ticketMoveToHandler,
  ticketNoticeHandler,
  withSql,
  type HandlerFixture,
  promotableTaskNote,
  refAttribute,
  TASK_FILE,
  TASK_NOTE_ADOPTED_TABLE,
  TASK_VIEWER_ID,
  taskNoteMapping,
  TICKET_CHECKLIST_TABLE,
  TICKET_OWN_WRITER_ID,
  TICKET_REGION_WRITER_ID,
  TICKET_TABLE,
  TICKET_TARGETS_READER_ID,
  TICKET_WRITER_ID,
  writableRegister,
  writeRoles,
  type Layer,
} from "../src/compiler/__tests__/fixtures/rights"
export * from "../src/schema/__tests__/fixtures/e1-fixtures"
export { signUp } from "./db/auth"
export { insertOrphan } from "./db/rights-seed"
export * from "./db/connection"
export * from "./db/fingerprint"
export { readCatalog, type CatalogShape, type CatalogTable } from "./db/catalog"
