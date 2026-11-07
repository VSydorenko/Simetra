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
  ORG_KIND_ID,
  adminRoles,
  commandCoreLayer,
  GAUGE_FILE,
  gaugeLineCheckLayer,
  GAUGE_LOG_FILE,
  GAUGE_LOG_TABLE,
  GAUGE_TABLE,
  GAUGE_WRITER_ID,
  GLOBAL_ADMIN_ID,
  GLOBAL_FOUNDER_ID,
  MEMBER_CREATOR_ID,
  MEMBER_FILE,
  MEMBER_FOCUS,
  MEMBER_REGIONS,
  memberScopedReferences,
  MEMBER_EDITOR_ID,
  MEMBER_TITLE,
  memberCreator,
  RIGHTS_ADMIN_ID,
  rightsAdminReadingMembers,
  runtimeValuesLayer,
  readQueryLayer,
  policyDomain,
  requiredMemberAttribute,
  ROLE_FILE,
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
  TENANT_AUDITOR_ID,
  TENANT_OPERATOR_ID,
  TENANT_OWNER_ID,
  TENANT_READER_ID,
  tenantOperator,
  tenantSelfService,
  writableRegister,
  writeRoles,
  type Layer,
} from "../src/compiler/__tests__/fixtures/rights"
export * from "../src/schema/__tests__/fixtures/e1-fixtures"
export { SNAPSHOT_TABLES } from "../src/compiler/rights/actor-snapshot"
export {
  fakeDatabase,
  type Answer,
  type Script,
} from "../src/server/__tests__/fake-database"
export { planNodes } from "./db/explain-plan"
export { signUp } from "./db/auth"
export { insertOrphan } from "./db/rights-seed"
export * from "./db/connection"
export * from "./db/fingerprint"
export { readCatalog, type CatalogShape, type CatalogTable } from "./db/catalog"
