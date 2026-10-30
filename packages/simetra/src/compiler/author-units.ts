import {
  PLATFORM_SCHEMA,
  authorColumns,
  quoteIdent,
  type AttributeCase,
  type DatabaseProvider,
  type PhysicalSnapshot,
} from "simetra/model"
import { platformBeforeTriggerName } from "./before-trigger-names"
import type { Contracts, QualifiedName } from "./contracts"
import { compareStrings } from "./diagnostics"
import { CURRENT_USER } from "./membership-functions"
import {
  authorStandardNames,
  authorTableColumns,
  contentChangeCondition,
} from "./mechanics-units"
import { CURRENT_USER_FUNCTION } from "./platform/names"
import { COMMAND_FUNCTIONS } from "./rights/command-units"
import { definerTrigger } from "./rights/definer"
import { hasRightsFunctions } from "./rights/functions"
import { executeGrants } from "./sql/execute-grants"
import type { SqlParser } from "./sql/parse"
import { functionIdentity, generatedUnit, type SqlUnit } from "./sql/units"

/** Одна функція авторства на проєкт: тіло не залежить від таблиці. */
export const AUTHOR_FUNCTION: QualifiedName = {
  schema: PLATFORM_SCHEMA,
  name: "author",
}

/**
 * Ім'я тригера авторства на таблиці. Спільний префікс рядкових
 * `BEFORE`-тригерів ставить авторство першим (`author → carriers → touch`):
 * копія носія за `createdBy` виводиться вже з примушеного автора.
 */
export function authorTriggerName(table: string): string {
  return platformBeforeTriggerName(table, "simetra_author")
}

/** Ім'я тригера авторства на `UPDATE` таблиці з копіями носіїв. */
export function authorUpdateTriggerName(table: string): string {
  return platformBeforeTriggerName(table, "simetra_author_update")
}

const [CREATED_BY, UPDATED_BY] = authorColumns()

/**
 * Тригер авторства (Рт7, спека П4 §6.8, Р-A1-8): під контекстом команди
 * `created_by_id` на вставці й `updated_by_id` на кожному записі — поточний
 * користувач, що б не надіслав клієнт. Без контексту (імпорт, мігратор,
 * провізія) авторів пише той, хто пише рядок: так переносяться історичні
 * автори. Таблиці — за `origin.standard` фізичного знімка, як у механіки.
 * Лише коли є функції прав: без них немає ні контексту команди, ні команд,
 * тож примушувати нічого, а тіло кликало б неіснуючу функцію.
 */
export function buildAuthorUnits(
  physical: PhysicalSnapshot,
  contracts: Pick<Contracts, "roles" | "users" | "membershipSources">,
  attributeCase: AttributeCase,
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  if (!hasRightsFunctions(contracts, provider)) return []
  const author = authorStandardNames(attributeCase)
  const tables = physical.tables.filter((table) => {
    const found = table.columns.filter((c) =>
      author.has(c.origin.standard ?? "")
    )
    if (found.length === 0) return false
    // Реєстр дає обидві колонки разом (`trackAuthor`); одна без другої чи
    // інше фізичне ім'я зламали б спільне тіло функції — це дефект моделі.
    const names = found.map((c) => c.name).sort(compareStrings)
    const expected = [CREATED_BY!.physicalName, UPDATED_BY!.physicalName].sort(
      compareStrings
    )
    if (names.join(",") !== expected.join(",")) {
      throw new Error(
        `internal: table ${table.schema}.${table.name} has author columns ${names.join(", ")}, expected ${expected.join(", ")}`
      )
    }
    return true
  })
  if (tables.length === 0) return []
  const fn = `${quoteIdent(AUTHOR_FUNCTION.schema)}.${quoteIdent(AUTHOR_FUNCTION.name)}`
  // Тіло plpgsql граф порядку не читає: функції контексту й користувача —
  // явні ребра, як у тригера ефектів.
  const requires = [COMMAND_FUNCTIONS.current, CURRENT_USER_FUNCTION].map(
    (f) => ({
      type: "unit" as const,
      identity: functionIdentity(f.schema, f.name, []),
    })
  )
  const shared = (sql: string, withRequires = false): SqlUnit => ({
    ...generatedUnit(sql, PLATFORM_SCHEMA, parse),
    module,
    generator: "mechanics",
    ...(withRequires ? { requires } : {}),
  })
  const trigger = (
    table: PhysicalSnapshot["tables"][number],
    name: string,
    events: string,
    when?: string
  ): SqlUnit => ({
    ...generatedUnit(
      `CREATE TRIGGER ${quoteIdent(name)} BEFORE ${events} ON ${quoteIdent(table.schema)}.${quoteIdent(table.name)} FOR EACH ROW ` +
        (when === undefined ? "" : `WHEN (${when}) `) +
        `EXECUTE FUNCTION ${fn}();`,
      table.schema,
      parse
    ),
    ownerObjectId: table.origin.objectId,
    module,
    generator: "mechanics",
  })
  // `EXECUTE` — нікому: тригер спрацьовує без права виконання функції
  // (платформна спека §6.7), а напряму її кликати нема кому.
  const units: SqlUnit[] = [
    shared(authorFunction(), true),
    ...executeGrants(`${fn}()`, [], provider).map((sql) => shared(sql)),
    ...tables.flatMap((table): SqlUnit[] => {
      // Поширення копій носіїв не змінює автора: оновлення — окремим тригером
      // з умовою змісту, а зміна самого автора — теж зміна (`watched`).
      const content = contentChangeCondition(
        table,
        attributeCase,
        authorTableColumns(table, attributeCase)
      )
      return content === undefined
        ? [trigger(table, authorTriggerName(table.name), "INSERT OR UPDATE")]
        : [
            trigger(table, authorTriggerName(table.name), "INSERT"),
            trigger(
              table,
              authorUpdateTriggerName(table.name),
              "UPDATE",
              content
            ),
          ]
    }),
  ]
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}

/**
 * `SECURITY DEFINER` (Р-A1-8): `EXECUTE` функції контексту має лише роль
 * команд, тож під правами викликача запис ролі поза командою (сервісна роль,
 * мігратор) падав би `42501` на самій перевірці контексту, не дійшовши до
 * гілки «без контексту». Тіло лише кличе функції контексту й користувача, які
 * читають налаштування сесії, і присвоює поля `NEW` — права власника нічого
 * не розширюють. `row_security` не задано: таблиць тіло не читає.
 */
function authorFunction(): string {
  const created = `NEW.${quoteIdent(CREATED_BY!.physicalName)}`
  const updated = `NEW.${quoteIdent(UPDATED_BY!.physicalName)}`
  const current = `${quoteIdent(COMMAND_FUNCTIONS.current.schema)}.${quoteIdent(COMMAND_FUNCTIONS.current.name)}`
  const text = [
    "BEGIN",
    `  IF (SELECT c.action FROM ${current}() AS c) IS NOT NULL THEN`,
    "    IF TG_OP = 'INSERT' THEN",
    `      ${created} := ${CURRENT_USER};`,
    "    END IF;",
    `    ${updated} := ${CURRENT_USER};`,
    "  END IF;",
    "  RETURN NEW;",
    "END",
  ].join("\n")
  return definerTrigger(AUTHOR_FUNCTION, text)
}
