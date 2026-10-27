import type { QualifiedName } from "../contracts"
import { generatedTableFunctionName } from "./generated-names"

const TABLE_GUARDS = [
  ["simetra_rights_snapshot", "simetra_rights_snapshot"],
  ["simetra_rights_insert", "simetra_rights"],
  ["simetra_rights_update", "simetra_rights"],
  ["simetra_rights_delete", "simetra_rights"],
  ["simetra_rights_truncate", "simetra_rights_truncate"],
  ["simetra_rights_members_insert", "simetra_rights_members_insert"],
  ["simetra_rights_members_update", "simetra_rights_members_update"],
  ["simetra_rights_members_delete", "simetra_rights_members_delete"],
  ["simetra_rights_users_insert", "simetra_rights_users_insert"],
  ["simetra_rights_users_update", "simetra_rights_users_update"],
  ["simetra_rights_id", "simetra_rights_id"],
  ["simetra_rights_relation_insert", "simetra_rights_relation"],
  ["simetra_rights_relation_update", "simetra_rights_relation"],
  ["simetra_rights_relation_delete", "simetra_rights_relation"],
] as const

/** Одна пара потрібна і генератору, і зворотному розпізнаванню. */
export function rightsGuardNames(
  table: QualifiedName
): readonly { trigger: string; function: QualifiedName }[] {
  return TABLE_GUARDS.map(([trigger, fn]) => ({
    trigger: generatedTableFunctionName(table.name, trigger),
    function: {
      schema: table.schema,
      name: generatedTableFunctionName(table.name, fn),
    },
  }))
}
