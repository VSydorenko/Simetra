import {
  quoteIdent,
  type AttributeCase,
  type DatabaseProvider,
  type Dml,
  type PhysicalSnapshot,
  type PhysicalTable,
} from "simetra/model"
import {
  effectsTables,
  writesByCommandContract,
  type Contracts,
  type MembershipContract,
  type QualifiedName,
  type RightsAction,
  type RightsContract,
} from "../contracts"
import { CURRENT_USER } from "../membership-functions"
import { CURRENT_USER_FUNCTION } from "../platform/names"
import { compareStrings } from "../diagnostics"
import { contentChangeCondition, contentColumns } from "../mechanics-units"
import { dollarTag } from "../movement-functions"
import type { CreationNode } from "../sql/dependencies"
import { executeGrants } from "../sql/execute-grants"
import type { SqlParser } from "../sql/parse"
import { functionIdentity, generatedUnit, type SqlUnit } from "../sql/units"
import { fieldForeignKey, sqlLiteral } from "../stages/model"
import { COMMAND_FUNCTIONS } from "./command-units"
import { effectsFunctionName, effectsTriggerNames } from "./effects-names"
import { hasRightsFunctions } from "./functions"

const q = quoteIdent
const relation = (t: { schema: string; name: string }) =>
  `${q(t.schema)}.${q(t.name)}`

const TG_OP = {
  insert: "INSERT",
  update: "UPDATE",
  delete: "DELETE",
} as const satisfies Record<Dml, string>
const DMLS: readonly Dml[] = ["insert", "update", "delete"]
const ops = (dmls: readonly Dml[]) =>
  dmls.map((dml) => sqlLiteral(TG_OP[dml])).join(", ")

/**
 * Генератор `effects` (спека прав §5.3, Р2b1-8): тригер платформи відхиляє
 * зміну поза дозволеними ефектами дії команди. Лише там, де є функції прав
 * (Р2a2-24) і об'єкт має дію з записом, — як політики запису. `AFTER`:
 * тригер бачить остаточний рядок після всіх `BEFORE`-тригерів (механіка,
 * виведення копій, обробники), тож результат не залежить від порядку імен
 * тригерів і не потребує заборон на них. На таблиці з копіями оновлення —
 * окремим тригером з умовою `contentChangeCondition`: зміна лише копій
 * (поширення функціями носіїв) — не дія, а умова тригера не має `OLD` на
 * вставці. `EXECUTE` не видається нікому: при спрацюванні тригера право
 * виконання функції не перевіряється (платформна спека §6.7), а викликати
 * її напряму нема кому. Тіла plpgsql граф не читає, тож відношення тіла й функція
 * контексту — явні ребра `requires`.
 */
export function buildEffectsUnits(
  contracts: Pick<
    Contracts,
    "rights" | "roles" | "users" | "membershipSources" | "membership"
  >,
  physical: PhysicalSnapshot,
  attributeCase: AttributeCase,
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  if (!hasRightsFunctions(contracts, provider)) return []
  const rightsById = new Map(contracts.rights.map((c) => [c.objectId, c]))
  const current: CreationNode = {
    type: "unit",
    identity: functionIdentity(
      COMMAND_FUNCTIONS.current.schema,
      COMMAND_FUNCTIONS.current.name,
      []
    ),
  }
  const units: SqlUnit[] = []
  for (const { table, main, key } of effectsTables(physical)) {
    const rights = rightsById.get(table.origin.objectId)
    if (rights === undefined || !writesByCommandContract(rights)) continue
    const unit = (
      sql: string,
      requires?: readonly CreationNode[]
    ): SqlUnit => ({
      ...generatedUnit(sql, table.schema, parse),
      ownerObjectId: table.origin.objectId,
      module,
      generator: "effects",
      ...(requires === undefined ? {} : { requires }),
    })
    const fn = effectsFunctionName(table)
    const names = effectsTriggerNames(table)
    const section = table.origin.tabularSectionId !== undefined
    const membership = contracts.membership.find(
      (entry) => entry.objectId === table.origin.objectId
    )
    const users = contracts.users?.objectId === table.origin.objectId
    const body = section
      ? sectionBody(rights, table, main, key)
      : mainBody(rights, table, key, attributeCase, membership, users)
    const requires: CreationNode[] = section
      ? [{ type: "table", schema: main.schema, name: main.name }, current]
      : [current]
    if (!section && membership !== undefined) {
      requires.push(
        { type: "table", schema: table.schema, name: table.name },
        {
          type: "unit",
          identity: functionIdentity(
            CURRENT_USER_FUNCTION.schema,
            CURRENT_USER_FUNCTION.name,
            []
          ),
        }
      )
    }
    const execute = `FOR EACH ROW EXECUTE FUNCTION ${relation(fn)}();`
    const content = contentChangeCondition(table, attributeCase)
    units.push(
      unit(definerTrigger(fn, body), requires),
      ...executeGrants(`${relation(fn)}()`, [], provider).map((sql) =>
        unit(sql)
      ),
      ...(content === undefined
        ? [
            unit(
              `CREATE TRIGGER ${q(names.all)} AFTER INSERT OR UPDATE OR DELETE ON ${relation(table)} ${execute}`
            ),
          ]
        : [
            unit(
              `CREATE TRIGGER ${q(names.all)} AFTER INSERT OR DELETE ON ${relation(table)} ${execute}`
            ),
            unit(
              `CREATE TRIGGER ${q(names.update)} AFTER UPDATE ON ${relation(table)} FOR EACH ROW WHEN (${content}) EXECUTE FUNCTION ${relation(fn)}();`
            ),
          ])
    )
  }
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}

/** Відмова тригера (спека прав §6.2): без даних рядка. */
function refuse(table: PhysicalTable, column?: string): string {
  return (
    `RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'command.forbidden', DETAIL = 'effect', TABLE = ${sqlLiteral(table.name)}` +
    (column === undefined ? "" : `, COLUMN = ${sqlLiteral(column)}`) +
    ";"
  )
}

const indent = (lines: readonly string[], depth = 1) =>
  lines.map((line) => `${"  ".repeat(depth)}${line}`)

/** Початок тіла: контекст і ранній вихід без нього. */
function contextLines(): string[] {
  return [
    `SELECT c.action, c.object, c.root INTO v_action, v_object, v_root FROM ${relation(COMMAND_FUNCTIONS.current)}() AS c;`,
    // Без контексту пише не команда: запис ролі команд без нього вже
    // відхилив запобіжник контексту (Р2b1-3), а ролі поза RLS
    // (міграції, механіка) ефекти не стосуються.
    "IF v_action IS NULL THEN",
    "  RETURN NULL;",
    "END IF;",
  ]
}

/**
 * Рядок належить кореню команди: його ключ (у ТЧ — власник) у старій чи
 * новій версії рядка дорівнює кореню контексту. `OLD` на вставці й `NEW` на
 * видаленні — `NULL`, тож одна умова діє на всі події.
 */
function notRoot(label: string, key: string): string {
  return `v_object <> ${sqlLiteral(label)} OR NOT coalesce(OLD.${q(key)} = v_root OR NEW.${q(key)} = v_root, false)`
}

/**
 * Перевірки оновлення під дією: жодна змістова колонка поза шапкою дії не
 * змінилася (ключ перевірено окремо), а колонка переходу змінюється лише у
 * своєму напрямку (Р2b1-18(3)).
 */
function updateChecks(
  action: RightsAction,
  table: PhysicalTable,
  compared: readonly string[]
): string[] {
  const header = new Set(action.effects.header)
  const lines = compared
    .filter((column) => !header.has(column))
    .flatMap((column) => [
      `IF OLD.${q(column)} IS DISTINCT FROM NEW.${q(column)} THEN`,
      `  ${refuse(table, column)}`,
      "END IF;",
    ])
  const transition = action.transition
  if (transition !== undefined) {
    const c = q(transition.column)
    const wrong = [
      ...(transition.from === undefined
        ? []
        : [`OLD.${c} IS DISTINCT FROM ${sqlLiteral(transition.from)}`]),
      ...(transition.to === undefined
        ? []
        : [`NEW.${c} IS DISTINCT FROM ${sqlLiteral(transition.to)}`]),
    ]
    if (wrong.length > 0) {
      lines.push(
        `IF OLD.${c} IS DISTINCT FROM NEW.${c} AND (${wrong.join(" OR ")}) THEN`,
        `  ${refuse(table, transition.column)}`,
        "END IF;"
      )
    }
  }
  return ["IF TG_OP = 'UPDATE' THEN", ...indent(lines), "END IF;"]
}

/** `ELSIF`-ланцюг за дією контексту; невідома дія — відмова. */
function actionChain(
  rights: RightsContract,
  table: PhysicalTable,
  branch: (action: RightsAction) => string[]
): string[] {
  const lines: string[] = []
  rights.actions
    .filter((action) => action.effects.dml.length > 0)
    .forEach((action, i) => {
      lines.push(
        `${i === 0 ? "IF" : "ELSIF"} v_action = ${sqlLiteral(action.action)} THEN`,
        ...indent(branch(action))
      )
    })
  lines.push("ELSE", `  ${refuse(table)}`, "END IF;")
  return lines
}

/**
 * Незмінні колонки таблиці (Р2b1-9, Р2b1-20, Р2b1-24) — за будь-якої дії й
 * для будь-якого рядка: ключ таблиці — `ref` основної (змінений ключ — інша
 * ідентичність кореня) чи колонка власника ТЧ (рядок ТЧ належить своєму
 * документу так само, як корінь — своєму `ref`: перенесення рядка до іншого
 * власника не є ефектом дії над коренем, а законного шляху, що її змінює,
 * немає — ключ кореня незмінний, тож каскаду FK на неї не буває), і колонка
 * скоупу (перенесення між тенантами — не правка змісту; складені FK скоупу ТЧ
 * і копій однаково не дали б зробити його цілісно). Порядок — колонок таблиці.
 */
function immutableColumns(
  table: PhysicalTable,
  key: string,
  users = false
): string[] {
  return table.columns
    .filter(
      (c) =>
        c.name === key ||
        c.origin.scopeKindId !== undefined ||
        (users &&
          (c.origin.standard === "invalid" || c.origin.standard === "userKind"))
    )
    .map((c) => c.name)
}

/**
 * Зміна незмінної колонки — відмова. Лише на `UPDATE`: на вставці `OLD`
 * немає, і новий рядок під `create` чи рядок ТЧ свій скоуп лише отримує.
 */
function immutableChecks(table: PhysicalTable, columns: readonly string[]) {
  return columns.flatMap((column) => [
    `IF TG_OP = 'UPDATE' AND OLD.${q(column)} IS DISTINCT FROM NEW.${q(column)} THEN`,
    `  ${refuse(table, column)}`,
    "END IF;",
  ])
}

/**
 * Основна таблиця (Р2b1-9, Р2b1-18). Незмінні колонки перевіряються раз до
 * гілок дій, тож у порівняння шапки не входять. Вставка
 * будь-якого рядка ставить колонки переходів у значення за замовчуванням.
 * Некореневий рядок (інший об'єкт контексту чи інший рядок) — за ефектами
 * природної дії свого DML, а не вихід: інакше команда над A змінювала б
 * колонки переходів B. Кореневий — DML і шапка дії контексту.
 */
function mainBody(
  rights: RightsContract,
  table: PhysicalTable,
  key: string,
  attributeCase: AttributeCase,
  membership: MembershipContract | undefined,
  users: boolean
): string {
  const immutable = immutableColumns(table, key, users)
  const compared = contentColumns(table, attributeCase)
    .map((c) => c.name)
    .filter((name) => !immutable.includes(name))
  const natural = (dml: Dml) =>
    rights.actions.find((action) => action.natural.includes(dml))
  const naturalUpdate = natural("update")
  const missing = DMLS.filter((dml) => natural(dml) === undefined)
  const lines = [
    ...contextLines(),
    ...immutableChecks(table, immutable),
    ...membershipChecks(table, membership),
    ...rights.transitions.flatMap(({ column, default: value }) => [
      `IF TG_OP = 'INSERT' AND NEW.${q(column)} IS DISTINCT FROM ${value} THEN`,
      `  ${refuse(table, column)}`,
      "END IF;",
    ]),
    `IF ${notRoot(rights.kindLabel, key)} THEN`,
    // DML без природної дії «решти» не має (Р2b1-7): відмова й тут.
    ...indent(
      missing.length === 0
        ? []
        : [
            `IF TG_OP IN (${ops(missing)}) THEN`,
            `  ${refuse(table)}`,
            "END IF;",
          ]
    ),
    ...indent(
      naturalUpdate === undefined
        ? []
        : updateChecks(naturalUpdate, table, compared)
    ),
    "  RETURN NULL;",
    "END IF;",
    ...actionChain(rights, table, (action) => [
      ...(action.effects.dml.length === DMLS.length
        ? []
        : [
            `IF TG_OP NOT IN (${ops(action.effects.dml)}) THEN`,
            `  ${refuse(table)}`,
            "END IF;",
          ]),
      ...(action.effects.dml.includes("update")
        ? updateChecks(action, table, compared)
        : []),
    ]),
    "RETURN NULL;",
  ]
  return ["DECLARE", ...declarations(), "BEGIN", ...indent(lines), "END"].join(
    "\n"
  )
}

/** Самоприйняття не може перепризначити чинного учасника чи обійти унікальність членства. */
function membershipChecks(
  table: PhysicalTable,
  membership: MembershipContract | undefined
): string[] {
  if (membership === undefined) return []
  const user = q(membership.userColumn)
  const scope = q(membership.scopeColumn)
  const key = q(membership.keyColumn)
  return [
    `IF TG_OP = 'UPDATE' AND OLD.${user} IS DISTINCT FROM NEW.${user} AND (OLD.${user} IS NOT NULL OR NEW.${user} IS DISTINCT FROM ${CURRENT_USER} OR EXISTS (SELECT 1 FROM ${relation(table)} AS member WHERE member.${scope} = NEW.${scope} AND member.${user} = NEW.${user} AND member.${key} <> NEW.${key})) THEN`,
    `  ${refuse(table, membership.userColumn)}`,
    "END IF;",
  ]
}

/**
 * DML рядка ТЧ, який дозволяє дія над власником (Р2b1-9): без
 * `tabularSections` — жодного; вставка — коли дія вставляє чи оновлює
 * власника; оновлення й видалення — лише коли оновлює (`create` над
 * наявним коренем не змінює й не видаляє його рядків).
 */
function sectionDml(action: RightsAction): Dml[] {
  if (!action.effects.tabularSections) return []
  const { dml } = action.effects
  if (dml.includes("update")) return [...DMLS]
  return dml.includes("insert") ? ["insert"] : []
}

function sectionCheck(
  action: RightsAction | undefined,
  table: PhysicalTable
): string[] {
  const allowed = action === undefined ? [] : sectionDml(action)
  if (allowed.length === DMLS.length) return []
  if (allowed.length === 0) return [refuse(table)]
  return [
    `IF TG_OP NOT IN (${ops(allowed)}) THEN`,
    `  ${refuse(table)}`,
    "END IF;",
  ]
}

/**
 * ТЧ (Р2b1-9): рядок кореня — коли власник рядка є коренем контексту;
 * дозволений DML — за дією над власником (`sectionDml`), а некореневий
 * рядок — за природною дією ТЧ (`update` власника, Р2b1-7). Видалення рядка,
 * власника якого вже немає, — каскад FK: він іде після видалення власника, а
 * те перевірив тригер власника; без цього винятку видалення документа з
 * рядками впало б на тригері ТЧ. Окремий рядок живого документа під дією без
 * `tabularSections` не видаляється.
 */
function sectionBody(
  rights: RightsContract,
  table: PhysicalTable,
  main: PhysicalTable,
  key: string
): string {
  const fk = fieldForeignKey(table, key)
  if (fk === undefined) {
    throw new Error(
      `internal: tabular section ${table.schema}.${table.name} has no owner link`
    )
  }
  // Пари FK власника в його порядку: у ТЧ кореня скоупу — одна, за `parent_id`.
  const owner = fk.columns
    .map((local, i) => `${q(fk.references.columns[i]!)} = OLD.${q(local)}`)
    .join(" AND ")
  const natural = rights.actions.find((action) =>
    action.natural.includes("update")
  )
  const lines = [
    ...contextLines(),
    ...immutableChecks(table, immutableColumns(table, key)),
    `IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM ${relation(main)} WHERE ${owner}) THEN`,
    "  RETURN NULL;",
    "END IF;",
    `IF ${notRoot(rights.kindLabel, key)} THEN`,
    ...indent(sectionCheck(natural, table)),
    "  RETURN NULL;",
    "END IF;",
    ...actionChain(rights, table, (action) => sectionCheck(action, table)),
    "RETURN NULL;",
  ]
  return ["DECLARE", ...declarations(), "BEGIN", ...indent(lines), "END"].join(
    "\n"
  )
}

function declarations(): string[] {
  return ["  v_action text;", "  v_object text;", "  v_root uuid;"]
}

/**
 * `SECURITY DEFINER` (Р2b1-8): повз RLS функція читає лише існування
 * власника рядка ТЧ, а в запит віддає лише `NULL` чи відмову — як функції
 * носіїв (Р2a2-8). `row_security = off`: власник функції під RLS дав би
 * гучну помилку замість тихого «власника немає». Порожній `search_path` і
 * кваліфіковані відношення не лишають простору для підміни імен.
 */
function definerTrigger(fn: QualifiedName, text: string): string {
  const tag = dollarTag(text)
  return (
    `CREATE OR REPLACE FUNCTION ${relation(fn)}()\n` +
    `RETURNS trigger\n` +
    `LANGUAGE plpgsql SECURITY DEFINER\n` +
    `SET search_path = ''\n` +
    `SET row_security = off\n` +
    `AS ${tag}\n${text}\n${tag};`
  )
}
