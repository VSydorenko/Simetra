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
  ["simetra_rights_relation_insert", "simetra_rights_relation"],
  ["simetra_rights_relation_update", "simetra_rights_relation"],
  ["simetra_rights_relation_delete", "simetra_rights_relation"],
] as const

/**
 * Одна пара потрібна і генератору, і зворотному розпізнаванню; генератор шукає
 * її за міткою, бо ім'я тригера будується по-різному.
 */
export function rightsGuardNames(
  table: QualifiedName
): readonly { label: string; trigger: string; function: QualifiedName }[] {
  return TABLE_GUARDS.map(([trigger, fn]) => ({
    label: trigger,
    // Запобіжники прав — операторні чи `AFTER`, тож з рядковими `BEFORE`
    // платформи не перемежовуються й спільного префікса групи не потребують.
    trigger: generatedTableFunctionName(table.name, trigger),
    function: {
      schema: table.schema,
      name: generatedTableFunctionName(table.name, fn),
    },
  }))
}
