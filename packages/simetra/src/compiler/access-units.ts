import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  PUBLIC_READ_PURPOSES,
  makeObjectName,
  quoteIdent,
  toSnakeCase,
  type ApiRolePurpose,
  type DatabaseProvider,
  type PhysicalSnapshot,
  type PhysicalTable,
  type PublicReadRole,
  type RequestRolePurpose,
} from "simetra/model"
import type { CompiledScopeKind } from "./compile"
import {
  mainTableOf,
  qualified,
  type AccessContract,
  type Contracts,
  type QualifiedName,
  type RightsContract,
} from "./contracts"
import { compareStrings } from "./diagnostics"
import {
  RIGHTS_FUNCTIONS,
  call,
  hasRightsFunctions,
  hasVisibleUsers,
} from "./rights/functions"
import {
  renderCondition,
  rightsPredicates,
  type RightsPredicate,
} from "./rights/predicates"
import { sha256HexSync } from "./sha256"
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
  scopeKindIdByFile: ReadonlyMap<string, string>,
  rights: readonly RightsContract[],
  usersObjectId: string | undefined
): AccessContract[] {
  const byId = new Map(objects.map((o) => [o.id ?? "", o]))
  const roots = new Set(
    scopeKinds.flatMap((k) => ("objectId" in k.root ? [k.root.objectId] : []))
  )
  const withRights = new Set(rights.map((r) => r.objectId))
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
      const { objectId } = table.origin
      const main =
        table.origin.tabularSectionId === undefined &&
        table.origin.part === undefined
      return [
        {
          objectId,
          table: { schema: table.schema, name: table.name },
          ...(scope === undefined ? {} : { scope }),
          publicRead: publicReadPurposes(
            (object.data as { publicRead?: PublicReadRole }).publicRead
          ),
          root: main && roots.has(objectId),
          // Похідних таблиць «Користувачі» з RLS не мають: `identities` —
          // службова таблиця без RLS (спека системної схеми).
          users: objectId === usersObjectId,
          ...(withRights.has(objectId) ? { rights: { objectId } } : {}),
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

/** Найдовша мітка політики прав у байтах (Р2a2-2): решта імені — таблиці. */
const RIGHTS_LABEL_BYTES = 40
/** Довгу мітку замінює її початок цієї довжини, `_` і 8 hex-знаків хешу. */
const RIGHTS_LABEL_PREFIX_BYTES = 31

/**
 * Імена політик таблиці (платформна спека §6.8, спека прав §5.2): мітка після
 * імені таблиці, як у Postgres, тож довга назва скорочується, а не перевищує
 * 63 байти. `rights` бере мітку обсягу без `read_` (`any`, `own_<колонка>`,
 * `in_<контейнер>_<обсяг>`, вимір): мітку понад 40 байтів цілком замінюють її
 * перші 31 байт, `_` і 8 hex-знаків `sha256` повної мітки (Р2a2-2) — інакше
 * довгі мітки однієї таблиці після обрізання таблиці до нуля збіглися б.
 */
export function accessPolicyNames(table: { name: string }): {
  scopeRead: string
  scopeInsert: string
  scopeUpdate: string
  scopeDelete: string
  publicRead: string
  rights(label: string): string
} {
  const name = (label: string) => makeObjectName(table.name, undefined, label)
  return {
    scopeRead: name("scope_read"),
    scopeInsert: name("scope_insert"),
    scopeUpdate: name("scope_update"),
    scopeDelete: name("scope_delete"),
    publicRead: name("public_read"),
    rights: (label) => name(boundedLabel(`read_${label}`)),
  }
}

function boundedLabel(label: string): string {
  const bytes = new TextEncoder().encode(label)
  if (bytes.length <= RIGHTS_LABEL_BYTES) return label
  return `${clipUtf8(label, RIGHTS_LABEL_PREFIX_BYTES)}_${sha256HexSync(label).slice(0, 8)}`
}

/** Префікс не довший за `limit` байтів UTF-8, без розрізаного символу. */
function clipUtf8(text: string, limit: number): string {
  const encoder = new TextEncoder()
  let result = ""
  let used = 0
  for (const char of text) {
    const size = encoder.encode(char).length
    if (used + size > limit) break
    result += char
    used += size
  }
  return result
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

/** Контракти, з яких генератор будує політики прав і межі «Користувачів». */
export type AccessPolicyContracts = Pick<
  Contracts,
  "rights" | "accessDimensions" | "roles" | "users" | "membership"
>

/**
 * Гранти й політики кожної таблиці виду — згенеровані одиниці без файлу, як
 * функції членства. Користувач читає таблицю завжди (рядки обмежують
 * політики), гість — лише з `publicRead: anon`; сервісна роль гранту не
 * отримує (спека промоції §8 «Сервісна роль»).
 *
 * Політики (спека прав §5.2): межа тенанта — `RESTRICTIVE` на читання й
 * кожну команду запису; межа «Користувачів» — `RESTRICTIVE` на читання;
 * права читання — `PERMISSIVE` по одній на предикат будівника умов 2a1, лише
 * там, де є функції прав (Р2a2-24): без них таблицю не відкриває жодна
 * політика прав (fail-closed). Межі й права — для ролі запиту користувача й
 * ролі команд, ніколи для `anon`. Нескоуплена таблиця без `publicRead` і без
 * прав політик не має: доступ до рядків дає право, а не платформа за
 * замовчуванням.
 */
export function buildAccessUnits(
  access: readonly AccessContract[],
  contracts: AccessPolicyContracts,
  physical: PhysicalSnapshot,
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  const apiRoles = PROVIDER_API_ROLES[provider]
  const bounded = [apiRoles.user, PLATFORM_ROLES.command]
  const rightsOn = hasRightsFunctions(contracts)
  const visibleUsers = hasVisibleUsers(contracts)
  const rightsById = new Map(contracts.rights.map((c) => [c.objectId, c]))
  const labels = {
    container: new Map(contracts.rights.map((c) => [c.objectId, c.kindLabel])),
    dimension: new Map(
      contracts.accessDimensions.map((d) => [
        d.dimensionId,
        toSnakeCase(d.name),
      ])
    ),
  }
  return access
    .flatMap((contract) => {
      const { table } = contract
      const readers = [
        ...new Set<ApiRolePurpose>(["user", ...contract.publicRead]),
      ]
      const names = accessPolicyNames(table)
      const policies: string[] = []
      const publicRead = contract.publicRead.length > 0
      if (contract.scope !== undefined) {
        // Некорельована форма: множину скоупів планувальник обчислює раз на
        // запит, а не викликає функцію на кожен рядок (§6.8). Межа —
        // `RESTRICTIVE`: жодна `PERMISSIVE`-політика прав її не розширює.
        const boundary = `${quoteIdent(contract.scope.carrier)} = ANY (ARRAY(SELECT ${qualified(contract.scope.setFunction)}()))`
        const restrict = (name: string, command: Command, clauses: Clauses) =>
          policies.push(
            policy(name, table, "RESTRICTIVE", command, bounded, clauses)
          )
        // Об'єкт із `publicRead` свідомо відкриває всі рядки на читання
        // (§6.8, Р2a2-3), але межа запису від форми прав не залежить.
        if (!publicRead) {
          restrict(names.scopeRead, "SELECT", { using: boundary })
        }
        // Скоуп нового кореня — його власний `id`: межу нового тенанта дасть
        // право створення кореня (П4), а не множина моїх скоупів (Р2a2-1).
        if (!contract.root) {
          restrict(names.scopeInsert, "INSERT", { check: boundary })
        }
        restrict(names.scopeUpdate, "UPDATE", {
          using: boundary,
          check: boundary,
        })
        restrict(names.scopeDelete, "DELETE", { using: boundary })
      }
      if (visibleUsers && contract.users) {
        // «Користувачі» нескоуплені, тож межа тенанта їх не обмежує: роль
        // рівня скоупу з `read@any` бачила б користувачів усіх тенантів
        // (спека системної схеми §12, Р2a2-18).
        const key = usersKey(
          tableOf(physical, table),
          must(contracts.users).keyColumn
        )
        policies.push(
          policy(names.scopeRead, table, "RESTRICTIVE", "SELECT", bounded, {
            using: `${quoteIdent(key)} = ANY (ARRAY(SELECT ${call(RIGHTS_FUNCTIONS.visibleUsers)}))`,
          })
        )
      }
      if (publicRead) {
        policies.push(
          policy(
            names.publicRead,
            table,
            "PERMISSIVE",
            "SELECT",
            contract.publicRead.map((purpose) => apiRoles[purpose]),
            { using: "true" }
          )
        )
      }
      // Без функцій прав політика, що їх кличе, не застосувалась би
      // (Р2a2-24); `publicRead` відкриває всі рядки й без прав (Р2a2-3).
      const rights =
        contract.rights === undefined
          ? undefined
          : rightsById.get(contract.rights.objectId)
      if (
        rightsOn &&
        !publicRead &&
        rights?.actions.some((a) => a.action === "read") === true
      ) {
        const physicalTable = tableOf(physical, table)
        const main = must(mainTableOf(physical, rights.objectId))
        for (const predicate of rightsPredicates(
          rights,
          "read",
          physicalTable,
          main
        )) {
          policies.push(
            policy(
              names.rights(rightsLabel(predicate, rights, labels)),
              table,
              "PERMISSIVE",
              "SELECT",
              bounded,
              {
                using: predicate.conditions.map(renderCondition).join(" AND "),
              }
            )
          )
        }
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

/**
 * Мітка політики прав без `read_` (Р2a2-2): обсяг, у контейнері —
 * `in_<мітка контейнера>_<обсяг>`; кілька носіїв власності розрізняє колонка
 * носія в цій таблиці.
 */
function rightsLabel(
  predicate: RightsPredicate,
  contract: RightsContract,
  labels: {
    container: ReadonlyMap<string, string>
    dimension: ReadonlyMap<string, string>
  }
): string {
  const inner = (extent: RightsPredicate["extent"]): string => {
    if (extent === "any") return "any"
    if (extent === "own") {
      return contract.ownership.length > 1
        ? `own_${must(predicate.carrier)}`
        : "own"
    }
    if ("dimensionId" in extent) {
      return must(labels.dimension.get(extent.dimensionId))
    }
    return `in_${must(labels.container.get(extent.container))}_${inner(extent.inner)}`
  }
  return inner(predicate.extent)
}

/** Колонка id користувача: ключ основної таблиці, у рядку ТЧ — `parent_id`. */
function usersKey(table: PhysicalTable, keyColumn: string): string {
  if (table.origin.tabularSectionId === undefined) return keyColumn
  return must(table.columns.find((c) => c.origin.standard === "parent")).name
}

function tableOf(physical: PhysicalSnapshot, name: QualifiedName) {
  return must(
    physical.tables.find(
      (t) => t.schema === name.schema && t.name === name.name
    )
  )
}

type Command = "SELECT" | "INSERT" | "UPDATE" | "DELETE"
interface Clauses {
  using?: string
  check?: string
}

function policy(
  name: string,
  table: QualifiedName,
  mode: "PERMISSIVE" | "RESTRICTIVE",
  command: Command,
  roles: readonly string[],
  { using, check }: Clauses
): string {
  const to = [...roles]
    .sort(compareStrings)
    .map((role) => quoteIdent(role))
    .join(", ")
  return (
    [
      `CREATE POLICY ${quoteIdent(name)} ON ${qualified(table)} AS ${mode} FOR ${command} TO ${to}`,
      ...(using === undefined ? [] : [`USING (${using})`]),
      ...(check === undefined ? [] : [`WITH CHECK (${check})`]),
    ].join(" ") + ";"
  )
}
