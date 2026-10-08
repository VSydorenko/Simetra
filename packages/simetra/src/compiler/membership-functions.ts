import {
  MEMBERSHIP_SET_FUNCTION,
  PLATFORM_SCHEMA,
  makeObjectName,
  quoteIdent,
  type ApiRolePurpose,
  type PhysicalSnapshot,
  type PhysicalTable,
  type Project,
  type ScopeKind,
} from "simetra/model"
import type { QualifiedName } from "./contracts"
import { compareStrings } from "./diagnostics"
import { dollarTag } from "./movement-functions"
import { executeGrants } from "./sql/execute-grants"
import type { SqlParser } from "./sql/parse"
import { generatedUnit, type SqlUnit } from "./sql/units"
import type { ParsedObject } from "./stages/files"
import { keyColumnOf, membershipUserOf } from "./stages/model"

/**
 * Поточний користувач у згенерованому SQL — лише некорельований підзапит
 * (спека користувачів С9): планувальник обчислює його раз на запит, а не на
 * рядок.
 */
const CURRENT_USER = `(SELECT ${quoteIdent(PLATFORM_SCHEMA)}.current_user_id())`

/** Мітки імен функцій членства — алгоритм імен Postgres від таблиці довідника. */
const MY_MEMBER_LABEL = "my_member"
const MEMBER_SCOPES_LABEL = "member_scopes"

/**
 * Ролі API, яким відкрито виконання функцій членства (спека користувачів §8):
 * сервісна сесії не має й отримує порожній результат замість помилки доступу;
 * анонімна — помилку.
 */
const MEMBER_ROLES: readonly ApiRolePurpose[] = ["user", "service"]

/**
 * Імена функцій членства — спільні для генератора, контракту й перевірки
 * колізій стадії 4.
 */
export function membershipFunctionNames(table: PhysicalTable): {
  myMember: QualifiedName
  memberScopes: QualifiedName
} {
  const name = (label: string) => ({
    schema: table.schema,
    name: makeObjectName(table.name, undefined, label),
  })
  return {
    myMember: name(MY_MEMBER_LABEL),
    memberScopes: name(MEMBER_SCOPES_LABEL),
  }
}

/** Вид скоупу обирає функцію множини, згенеровану з членства. */
export function choosesMembership(kind: ScopeKind): boolean {
  return kind.setFunction === MEMBERSHIP_SET_FUNCTION
}

/** Резолвлене членство довідника: таблиця, колонки й імена функцій. */
export interface Membership {
  object: ParsedObject
  scopeKind: ScopeKind
  table: PhysicalTable
  keyColumn: string
  scopeColumn: string
  userColumn: string
  myMember: QualifiedName
  /** Лише коли вид скоупу обирає `setFunction: "membership"`. */
  setFunction?: QualifiedName
}

/**
 * Довідники членства моделі (спека користувачів §8). Викликається лише на
 * моделі без помилок: стадія 4 гарантує скоуплений довідник із власною
 * скоуп-колонкою й скалярним посиланням на «Користувачі», тож відсутність
 * таблиці чи колонки — дефект компілятора.
 */
export function membershipsOf(
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot,
  project: Pick<Project, "scopeKinds">
): Membership[] {
  return objects
    .flatMap((object): Membership[] => {
      const user = membershipUserOf(object)
      if (user === undefined) return []
      const { scope } = object.data as { scope?: string }
      const scopeKind = must(
        project.scopeKinds.find((kind) => kind.name === scope),
        `scope kind of ${object.name}`
      )
      const table = must(
        physical.tables.find(
          (t) =>
            t.origin.objectId === object.id &&
            t.origin.tabularSectionId === undefined &&
            t.origin.part === undefined
        ),
        `table of ${object.name}`
      )
      const column = (
        match: (c: PhysicalTable["columns"][number]) => boolean
      ) => must(table.columns.find(match), `column of ${object.name}`).name
      const names = membershipFunctionNames(table)
      return [
        {
          object,
          scopeKind,
          table,
          keyColumn: must(keyColumnOf(object), `key of ${object.name}`),
          scopeColumn: column((c) => c.origin.scopeKindId === scopeKind.id),
          userColumn: column((c) => c.origin.elementId === user.id),
          myMember: names.myMember,
          ...(choosesMembership(scopeKind)
            ? { setFunction: names.memberScopes }
            : {}),
        },
      ]
    })
    .sort((a, b) => compareStrings(a.object.id ?? "", b.object.id ?? ""))
}

/**
 * Функції членства й їхні гранти (спека користувачів §8) — згенеровані
 * одиниці без файлу, як обгортки рухів. Обидві функції — `LANGUAGE sql
 * STABLE SECURITY DEFINER SET search_path = ''`: функцію множини викликає
 * політика RLS над таблицею з RLS, тож виклик від імені запиту зациклив би
 * політику, а порожній `search_path` не лишає простору для підміни імен.
 * Виконання — лише `authenticated` і сервісній ролі: дефолт Postgres дає його `PUBLIC`, а
 * провайдер — своїм ролям типовими привілеями схеми (`executeGrants`).
 */
export function buildMembershipFunctions(
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot,
  project: Project,
  parse: SqlParser
): SqlUnit[] {
  const units: SqlUnit[] = []
  for (const membership of membershipsOf(objects, physical, project)) {
    const owned = (sql: string, schema: string): SqlUnit => ({
      ...generatedUnit(sql, schema, parse),
      ownerObjectId: membership.object.id ?? "",
      module: project.name,
      generator: "membership",
    })
    const functions = [
      {
        fn: membership.myMember,
        signature: `${qualified(membership.myMember)}(uuid)`,
        sql: myMemberFunction(membership),
      },
      ...(membership.setFunction === undefined
        ? []
        : [
            {
              fn: membership.setFunction,
              signature: `${qualified(membership.setFunction)}()`,
              sql: memberScopesFunction(membership, membership.setFunction),
            },
          ]),
    ]
    for (const { fn, signature, sql } of functions) {
      units.push(
        owned(sql, fn.schema),
        ...executeGrants(
          signature,
          MEMBER_ROLES,
          project.database.provider
        ).map((grant) => owned(grant, fn.schema))
      )
    }
  }
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}

/**
 * «Мій учасник у скоупі»: ключ рядка членства поточного користувача. Шукає
 * лише за непорожнім користувачем — запрошення без облікового запису нічиїм
 * учасником не є. Параметр кваліфіковано іменем функції: колонка з тим самим
 * іменем у тілі SQL-функції перемогла б параметр.
 */
function myMemberFunction(membership: Membership): string {
  const { myMember } = membership
  const user = `m.${quoteIdent(membership.userColumn)}`
  return closedFunction(
    `${qualified(myMember)}(p_scope uuid)`,
    "uuid",
    [
      `SELECT m.${quoteIdent(membership.keyColumn)}`,
      `FROM ${qualified(membership.table)} m`,
      `WHERE m.${quoteIdent(membership.scopeColumn)} = ${quoteIdent(myMember.name)}.p_scope`,
      `  AND ${user} IS NOT NULL`,
      `  AND ${user} = ${CURRENT_USER}`,
    ].join("\n")
  )
}

/** Функція множини виду скоупу: значення скоупу, де поточний користувач — учасник. */
function memberScopesFunction(
  membership: Membership,
  fn: QualifiedName
): string {
  const user = `m.${quoteIdent(membership.userColumn)}`
  return closedFunction(
    `${qualified(fn)}()`,
    "SETOF uuid",
    [
      `SELECT m.${quoteIdent(membership.scopeColumn)}`,
      `FROM ${qualified(membership.table)} m`,
      `WHERE ${user} IS NOT NULL`,
      `  AND ${user} = ${CURRENT_USER}`,
    ].join("\n")
  )
}

function closedFunction(
  signature: string,
  returns: string,
  body: string
): string {
  const tag = dollarTag(body)
  return (
    `CREATE OR REPLACE FUNCTION ${signature}\n` +
    `RETURNS ${returns}\n` +
    `LANGUAGE sql STABLE SECURITY DEFINER\n` +
    `SET search_path = ''\n` +
    `AS ${tag}\n${body}\n${tag};`
  )
}

function qualified(name: QualifiedName): string {
  return `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
}

/** Модель без помилок гарантує наявність; відсутність — дефект компілятора. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`internal: missing ${what}`)
  return value
}
