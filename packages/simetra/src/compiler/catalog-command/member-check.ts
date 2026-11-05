import { quoteIdent } from "simetra/model"
import type { MembershipContract } from "../contracts"
import { sqlLiteral } from "../stages/model"
import {
  memberCheckFunctionName,
  type CatalogCommandContract,
} from "./contracts"
import {
  coreFunction,
  defaultOf,
  inputLines,
  newRow,
  referenceChecks,
} from "./units"

const q = quoteIdent

/**
 * Перевірка рядка членства творця кореня (спека П4 §6.12, §6.13):
 * `<членство>_simetra_member_check(p_member jsonb, p_scope uuid) RETURNS text`
 * — колонка першого порушення чи `NULL`. Ті самі будівники, що й гілка
 * створення `<членство>_save`: дозволені ключі (ключі вставки мінус примушені
 * ключ, скоуп і користувач, без `tabular`), приведення типів і перевірки
 * посилань над рядком «після» — значення за замовчуванням з накладеним входом
 * і скоупом `p_scope`, як `v_new` гілки створення. Примушені колонки не
 * перевіряються: їх пише функція гранту, а не вхід. `SECURITY INVOKER`: ядро
 * кореня кличе її під RLS команди — видимість цілі; інструмент обслуговування
 * — від власника з `row_security = off` (лише «ціль існує в тому самому
 * скоупі»). Відмова — `RETURN` колонки замість `RAISE`: ядро кладе її під
 * префікс `creatorMember.`, а інструмент — у свій шлях.
 */
export function memberCheckFunction(
  contract: CatalogCommandContract,
  membership: MembershipContract
): string {
  const { table } = contract
  const forced = new Set([
    membership.keyColumn,
    membership.scopeColumn,
    membership.userColumn,
  ])
  const keys = contract.createKeys.filter((c) => !forced.has(c))
  const fail = (detail: string) => `RETURN ${detail};`
  const scope = `v_new.${q(membership.scopeColumn)}`
  const references = contract.references.filter((reference) =>
    (reference.form === "single"
      ? [reference.column]
      : [reference.typeColumn, reference.idColumn]
    ).every((c) => !forced.has(c))
  )
  return coreFunction(
    memberCheckFunctionName(table),
    "p_member jsonb, p_scope uuid",
    ["v_in record;", "v_new record;", "v_key text;"],
    [
      ...inputLines({
        table,
        param: "p_member",
        shape: "p_member",
        keys,
        tabular: false,
        fail,
      }),
      // Поле `record` без структури дає `55000`: форму рядка — першою.
      `v_new := jsonb_populate_record(NULL::${q(table.schema)}.${q(table.name)}, ${sqlLiteral("{}")});`,
      ...keys.map(
        (c) =>
          `v_new.${q(c)} := CASE WHEN p_member ? ${sqlLiteral(c)} THEN v_in.${q(c)} ELSE ${defaultOf(table, c)} END;`
      ),
      `${scope} := p_scope;`,
      ...referenceChecks(
        references,
        newRow({
          scope,
          ownScopeKind: table.columns.find(
            (c) => c.name === membership.scopeColumn
          )?.origin.scopeKindId,
        }),
        fail
      ),
      "RETURN NULL;",
    ]
  )
}
