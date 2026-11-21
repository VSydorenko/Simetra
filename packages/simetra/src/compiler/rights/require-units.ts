import {
  PLATFORM_SCHEMA,
  RIGHTS_REQUIRE_ERROR,
  quoteIdent,
  type DatabaseProvider,
  type ObjectTable,
  type PhysicalSnapshot,
} from "simetra/model"
import { tenantBoundary, usersBoundary, readBoundaries } from "../access-units"
import { rightsCheck } from "../catalog-command/rights-check"
import { bodyRequires } from "../catalog-command/units"
import {
  mainTableOf,
  qualified,
  type AccessContract,
  type Contracts,
  type RightsContract,
} from "../contracts"
import { compareStrings } from "../diagnostics"
import { dollarTag } from "../movement-functions"
import { executeGrants } from "../sql/execute-grants"
import type { DeclaredFunction } from "../sql/declarations"
import type { SqlParser } from "../sql/parse"
import type { PlpgsqlParser } from "../sql/plpgsql"
import { generatedUnit, type SqlUnit } from "../sql/units"
import { sqlLiteral } from "../stages/model"
import type { ParsedObject } from "../stages/files"
import { RIGHTS_FUNCTIONS, hasVisibleUsers } from "./functions"
import { anyScopeSet, renderCondition, type PredicateDml } from "./predicates"
import { must } from "./references"

export interface RequireInput {
  /** Лише декларації, що пройшли суддю `check-form`: контракт і ціль є. */
  declared: readonly DeclaredFunction[]
  objects: readonly ParsedObject[]
  contracts: Pick<
    Contracts,
    "access" | "rights" | "roles" | "users" | "membership" | "membershipSources"
  >
  physical: PhysicalSnapshot
  provider: DatabaseProvider
  module: string
  /** Одиниці інших генераторів: функції, які кличе тіло, — ребра `requires`. */
  units: readonly Pick<SqlUnit, "class" | "identity">[]
  parse: SqlParser
  plpgsql: PlpgsqlParser
}

type Form = "row" | "scope" | "none"

/** Гілка: пара (мітка, дія) і форма цілі, умова — готовий вираз `boolean`. */
interface Branch {
  label: string
  action: string
  condition: string
}

/** Псевдонім рядка головної таблиці в `EXISTS` гілки. */
const ROW = "r"

/**
 * DML, який судить предикат дії. Кастомна дія змінює наявний рядок — як
 * `update` (спека прав §6.2); `create` — вставка.
 */
function dmlOf(action: string): PredicateDml {
  if (action === "read") return "select"
  if (action === "create") return "insert"
  if (action === "delete") return "delete"
  return "update"
}

/**
 * Межі `RESTRICTIVE` DML дії над рядком `r` — ті самі будівники, що й
 * політики. Дія над наявним рядком (усе, крім `create`) бере й межі читання
 * (`readBoundaries`): Postgres застосовує політики `SELECT` до наявних рядків
 * `UPDATE`/`DELETE`, а запобіжник не слабший за RLS. Межа тенанта `update` і
 * `delete` не залежить від `publicRead` (політики `scope_update`,
 * `scope_delete`), а читання — залежить.
 */
function boundaries(
  action: string,
  access: AccessContract | undefined,
  visibleUsers: boolean,
  main: ObjectTable,
  usersKey: string | undefined
): string[] {
  if (access === undefined) return []
  const read = readBoundaries(access, visibleUsers)
  const tenant =
    action === "read" ? read.includes("tenant") : access.scope !== undefined
  return [
    ...(tenant ? [tenantBoundary(must(access.scope), ROW)] : []),
    ...(read.includes("users")
      ? [usersBoundary(main, must(usersKey), ROW)]
      : []),
  ]
}

function rowBranch(
  contract: RightsContract,
  action: string,
  input: RequireInput,
  visibleUsers: boolean
): string {
  const main = must(mainTableOf(input.physical, contract.objectId))
  const access = input.contracts.access.find(
    (a) => a.table.schema === main.schema && a.table.name === main.name
  )
  const key = main.primaryKey?.columns
  if (key?.length !== 1) {
    throw new Error(
      `internal: the row target of ${contract.kindLabel} needs a single-column key`
    )
  }
  const where = [
    `${ROW}.${quoteIdent(key[0]!)} = p_row`,
    ...boundaries(
      action,
      access,
      visibleUsers,
      main,
      input.contracts.users?.keyColumn
    ),
    `(${rightsCheck(contract, action, main, ROW, dmlOf(action))})`,
  ]
  return `EXISTS (SELECT 1 FROM ${qualified(contract.table)} ${ROW} WHERE ${where.join(" AND ")})`
}

/**
 * `p_scope` — мій скоуп виду скоупу (межа тенанта, той самий будівник) і
 * скоуп з правом дії в обсязі `any`: `own` і вимір рядка без рядка не судять.
 */
function scopeBranch(
  contract: RightsContract,
  action: string,
  access: AccessContract
): string {
  const scope = must(access.scope)
  return [
    tenantBoundary({ ...scope, carrier: "p_scope" }),
    renderCondition({
      kind: "column",
      column: "p_scope",
      set: anyScopeSet(contract, action),
      grantDependent: true,
    }),
  ].join(" AND ")
}

function branchesOf(input: RequireInput): Map<Form, Branch[]> {
  const visibleUsers = hasVisibleUsers(input.contracts, input.provider)
  const found = new Map<string, { form: Form } & Branch>()
  for (const { declaration } of input.declared) {
    const check = declaration.check
    if (check === undefined) continue
    const object = input.objects.find(
      (o) => o.kind === check.object.kind && o.name === check.object.name
    )
    const contract = must(
      input.contracts.rights.find((r) => r.objectId === object?.id)
    )
    const action = must(contract.actions.find((a) => a.name === check.action))
    const form: Form =
      check.scope !== undefined
        ? "scope"
        : check.row !== undefined
          ? "row"
          : "none"
    // Ключ пари і форми: друга декларація тієї самої пари гілку не множить.
    const key = `${form}\0${contract.kindLabel}\0${action.action}`
    const main = must(mainTableOf(input.physical, contract.objectId))
    const access = input.contracts.access.find(
      (a) => a.table.schema === main.schema && a.table.name === main.name
    )
    const condition =
      form === "row"
        ? rowBranch(contract, action.action, input, visibleUsers)
        : form === "scope"
          ? scopeBranch(contract, action.action, must(access))
          : // Об'єкт без носіїв: предикати — булева форма права.
            rightsCheck(
              contract,
              action.action,
              main,
              ROW,
              dmlOf(action.action)
            )
    found.set(key, {
      form,
      label: contract.kindLabel,
      action: action.action,
      condition,
    })
  }
  const byForm = new Map<Form, Branch[]>()
  for (const { form, ...branch } of [...found.values()].sort(
    (a, b) =>
      compareStrings(a.label, b.label) || compareStrings(a.action, b.action)
  )) {
    byForm.set(form, [...(byForm.get(form) ?? []), branch])
  }
  return byForm
}

/**
 * Відмова одна: невідома пара, немає права, немає рядка й `NULL` не
 * розрізняються (оракул наявності рядків не відкривається).
 */
const REFUSAL = `RAISE EXCEPTION USING ERRCODE = '${RIGHTS_REQUIRE_ERROR.errcode}', MESSAGE = '${RIGHTS_REQUIRE_ERROR.message}', DETAIL = '${RIGHTS_REQUIRE_ERROR.noRight}';`

function requireFunction(
  name: { schema: string; name: string },
  target: "p_row" | "p_scope",
  branches: readonly Branch[]
): string {
  const body = [
    "BEGIN",
    ...branches.flatMap(({ label, action, condition }) => [
      `  IF p_object = ${sqlLiteral(label)} AND p_action = ${sqlLiteral(action)} AND (${condition}) THEN`,
      "    RETURN;",
      "  END IF;",
    ]),
    `  ${REFUSAL}`,
    "END",
  ].join("\n")
  const tag = dollarTag(body)
  return (
    `CREATE OR REPLACE FUNCTION ${qualified(name)}(p_action text, p_object text, ${target} uuid)\n` +
    `RETURNS void\n` +
    `LANGUAGE plpgsql SECURITY INVOKER\n` +
    `SET search_path = ''\n` +
    `AS ${tag}\n${body}\n${tag};`
  )
}

/**
 * Генератор `rightsRequire` (спека декларацій функцій §5.2, ADR-0093):
 * `simetra.rights_require(text, text, uuid)` для цілі `row` і без цілі,
 * `simetra.rights_require_scope(text, text, uuid)` для цілі `scope`. Гілка — на
 * кожну пару (мітка, дія) декларацій з `check`; без жодної `check` функцій
 * немає, без гілки певної форми немає й її функції. Тіло платформне, але
 * залежить від декларацій. `EXECUTE` — нікому: функцію кличуть definer-функції
 * від імені власника, а роль застосунку отримала б оракул наявності рядків.
 */
export function buildRequireUnits(input: RequireInput): SqlUnit[] {
  const byForm = branchesOf(input)
  const unit = (sql: string, requires?: SqlUnit["requires"]): SqlUnit => ({
    ...generatedUnit(sql, PLATFORM_SCHEMA, input.parse),
    module: input.module,
    generator: "rightsRequire",
    ...(requires === undefined ? {} : { requires }),
  })
  const functions = [
    {
      name: RIGHTS_FUNCTIONS.require,
      target: "p_row",
      branches: [...(byForm.get("row") ?? []), ...(byForm.get("none") ?? [])],
    },
    {
      name: RIGHTS_FUNCTIONS.requireScope,
      target: "p_scope",
      branches: byForm.get("scope") ?? [],
    },
  ] as const
  return functions
    .filter(({ branches }) => branches.length > 0)
    .flatMap(({ name, target, branches }) => {
      const sql = requireFunction(name, target, branches)
      return [
        unit(sql, bodyRequires(sql, input)),
        ...executeGrants(
          `${qualified(name)}(text, text, uuid)`,
          [],
          input.provider
        ).map((grant) => unit(grant)),
      ]
    })
    .sort((a, b) => compareStrings(a.identity, b.identity))
}
