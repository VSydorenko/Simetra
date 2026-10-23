import {
  PROVIDER_API_ROLES,
  PUBLIC_READ_PURPOSES,
  makeObjectName,
  quoteIdent,
  type ApiRolePurpose,
  type DatabaseProvider,
  type PhysicalSnapshot,
  type PublicReadRole,
  type RequestRolePurpose,
} from "simetra/model"
import type { CompiledScopeKind } from "./compile"
import { qualified, type AccessContract, type QualifiedName } from "./contracts"
import { compareStrings } from "./diagnostics"
import type { SqlParser } from "./sql/parse"
import { generatedUnit, type SqlUnit } from "./sql/units"
import { isDeclaredTable } from "./stages/model"
import type { ParsedObject } from "./stages/files"

/**
 * Контракт доступу кожної таблиці виду з RLS (платформна спека §6.7, §6.8):
 * основної, ТЧ і похідних таблиць регістра — бо кожна з них закрита RLS, і
 * без грантів і політик API її не прочитав би. Прийнята таблиця (`CustomTable`)
 * запису не має: її доступ описує файл, а не платформа. Викликається лише на
 * моделі без помилок.
 */
export function accessContracts(
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot,
  scopeKinds: readonly CompiledScopeKind[],
  scopeKindIdByFile: ReadonlyMap<string, string>
): AccessContract[] {
  const byId = new Map(objects.map((o) => [o.id ?? "", o]))
  return physical.tables
    .flatMap((table): AccessContract[] => {
      if (table.rowLevelSecurity === "off") return []
      const object = must(byId.get(table.origin.objectId))
      if (isDeclaredTable(object)) return []
      const kindId = scopeKindIdByFile.get(object.file)
      const scope =
        kindId === undefined
          ? undefined
          : {
              scopeKindId: kindId,
              // Носій — лише позначена моделлю колонка: ім'я не вгадується, бо
              // в кореня це `id`, у рядка ТЧ кореня — `parent_id`.
              carrier: must(
                table.columns.find((c) => c.origin.scopeKindId === kindId)
              ).name,
              setFunction: must(scopeKinds.find((k) => k.id === kindId))
                .setFunction,
            }
      return [
        {
          objectId: table.origin.objectId,
          table: { schema: table.schema, name: table.name },
          ...(scope === undefined ? {} : { scope }),
          publicRead: publicReadPurposes(
            (object.data as { publicRead?: PublicReadRole }).publicRead
          ),
        },
      ]
    })
    .sort(
      (a, b) =>
        compareStrings(a.table.schema, b.table.schema) ||
        compareStrings(a.table.name, b.table.name)
    )
}

/** Гість бачить не більше за користувача: `anon` відкриває обидві ролі запиту. */
function publicReadPurposes(
  role: PublicReadRole | undefined
): RequestRolePurpose[] {
  if (role === undefined) return []
  const purposes = new Set<RequestRolePurpose>([PUBLIC_READ_PURPOSES[role]])
  if (role === "anon") purposes.add("user")
  return [...purposes].sort(compareStrings)
}

/** Модель без помилок гарантує наявність; відсутність — дефект компілятора. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("internal: missing access input")
  return value
}

/**
 * Імена політик читання таблиці (платформна спека §6.8): мітка після імені
 * таблиці, як у Postgres, тож довга назва скорочується, а не перевищує 63
 * байти.
 */
export function accessPolicyNames(table: { name: string }): {
  read: string
  publicRead: string
} {
  return {
    read: makeObjectName(table.name, undefined, "read"),
    publicRead: makeObjectName(table.name, undefined, "public_read"),
  }
}

/**
 * Гранти таблиці виду (платформна спека §6.7): ACL таблиці належить
 * платформі. `PUBLIC` і кожна роль API спершу втрачають усе — типові привілеї
 * схеми провайдера дають їм і запис, і `TRUNCATE`, а табличний `REVOKE` знімає
 * й колонкові гранти. Ролі-читачі потім отримують лише `SELECT`. Порядок
 * «відкликання, потім грант» дає граф створення (ребро за ціллю), а не
 * порядок цього масиву. Кожен оператор — на одного отримувача: так гранти
 * читає extract.
 */
export function tableGrants(
  table: QualifiedName,
  readers: readonly ApiRolePurpose[],
  provider: DatabaseProvider
): string[] {
  const apiRoles = PROVIDER_API_ROLES[provider]
  const target = `TABLE ${qualified(table)}`
  return [
    `REVOKE ALL ON ${target} FROM PUBLIC;`,
    ...Object.values(apiRoles).map(
      (role) => `REVOKE ALL ON ${target} FROM ${quoteIdent(role)};`
    ),
    ...readers.map(
      (purpose) =>
        `GRANT SELECT ON ${target} TO ${quoteIdent(apiRoles[purpose])};`
    ),
  ]
}

/**
 * Гранти й політики читання кожної таблиці виду — згенеровані одиниці без
 * файлу, як функції членства. Користувач читає таблицю завжди (рядки
 * обмежує політика), гість — лише з `publicRead: anon`; сервісна роль
 * гранту не отримує (спека промоції §8 «Сервісна роль»). Нескоуплена
 * таблиця без `publicRead` політики не має: доступ до рядків дасть право
 * (дія, об'єкт), а не платформа за замовчуванням.
 */
export function buildAccessUnits(
  access: readonly AccessContract[],
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  const apiRoles = PROVIDER_API_ROLES[provider]
  return access
    .flatMap((contract) => {
      const { table } = contract
      const readers = [
        ...new Set<ApiRolePurpose>(["user", ...contract.publicRead]),
      ]
      const names = accessPolicyNames(table)
      const policies: string[] = []
      if (contract.scope !== undefined) {
        // Некорельована форма: множину скоупів планувальник обчислює раз на
        // запит, а не викликає функцію на кожен рядок (§6.8).
        policies.push(
          readPolicy(
            names.read,
            table,
            [apiRoles.user],
            `${quoteIdent(contract.scope.carrier)} = ANY (ARRAY(SELECT ${qualified(contract.scope.setFunction)}()))`
          )
        )
      }
      if (contract.publicRead.length > 0) {
        policies.push(
          readPolicy(
            names.publicRead,
            table,
            contract.publicRead.map((purpose) => apiRoles[purpose]),
            "true"
          )
        )
      }
      return [...tableGrants(table, readers, provider), ...policies].map(
        (sql): SqlUnit => ({
          ...generatedUnit(sql, table.schema, parse),
          ownerObjectId: contract.objectId,
          module,
          generator: "access",
        })
      )
    })
    .sort((a, b) => compareStrings(a.identity, b.identity))
}

function readPolicy(
  name: string,
  table: QualifiedName,
  roles: readonly string[],
  predicate: string
): string {
  const to = [...roles]
    .sort(compareStrings)
    .map((role) => quoteIdent(role))
    .join(", ")
  return `CREATE POLICY ${quoteIdent(name)} ON ${qualified(table)} AS PERMISSIVE FOR SELECT TO ${to} USING (${predicate});`
}
