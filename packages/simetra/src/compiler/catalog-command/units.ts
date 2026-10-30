import {
  authorColumns,
  deletionMarkColumn,
  quoteIdent,
  type AttributeCase,
  type DatabaseProvider,
  type PhysicalSnapshot,
  type PhysicalTable,
} from "simetra/model"
import type {
  AccessContract,
  Contracts,
  QualifiedName,
  RightsContract,
} from "../contracts"
import { compareStrings } from "../diagnostics"
import { hierarchyLockSql } from "../hierarchy-units"
import { CURRENT_USER } from "../membership-functions"
import { tenantBoundary } from "../access-units"
import { dollarTag } from "../movement-functions"
import {
  AUTHOR_CARRIER_SOURCES_FUNCTION,
  authorCarrierLinks,
  carrierCopyRead,
  type CarrierLink,
} from "../rights/carrier-units"
import { COMMAND_FUNCTIONS } from "../rights/command-units"
import { hasRightsFunctions } from "../rights/functions"
import { textNames, type CreationNode } from "../sql/dependencies"
import { executeGrants } from "../sql/execute-grants"
import type { SqlParser } from "../sql/parse"
import type { PlpgsqlParser } from "../sql/plpgsql"
import { generatedUnit, type SqlUnit } from "../sql/units"
import { sqlLiteral } from "../stages/model"
import { findStandardColumn, standardColumn } from "../standard-column"
import { rightsCheck } from "./rights-check"
import type {
  CatalogCommandContract,
  CatalogCommandSection,
  CommandReference,
} from "./contracts"

const q = quoteIdent
const relation = (t: { schema: string; name: string }) =>
  `${q(t.schema)}.${q(t.name)}`

/**
 * Відмови ядра (спека П4 §6.10): `MESSAGE` — код, `DETAIL` — причина чи
 * ключ; даних рядка відмова не несе (Рт4). Одне місце для генератора й
 * тестів.
 */
export const CATALOG_COMMAND_ERRORS = {
  invalid: { errcode: "22023", message: "command.invalid" },
  context: { errcode: "42501", message: "command.context", detail: "phase" },
  forbidden: {
    errcode: "42501",
    message: "command.forbidden",
    noRight: "no-right",
    newCarrier: "new-carrier",
  },
  conflict: {
    errcode: "P0001",
    message: "command.conflict",
    version: "version",
    exists: "exists",
  },
} as const

const E = CATALOG_COMMAND_ERRORS
/** `DETAIL` — SQL-вираз: літерал ключа чи конкатенація з `v_key`. */
const invalid = (detail: string) =>
  `RAISE EXCEPTION USING ERRCODE = '${E.invalid.errcode}', MESSAGE = '${E.invalid.message}', DETAIL = ${detail};`
const forbidden = (reason: string) =>
  `RAISE EXCEPTION USING ERRCODE = '${E.forbidden.errcode}', MESSAGE = '${E.forbidden.message}', DETAIL = '${reason}';`
const noRight = forbidden(E.forbidden.noRight)
const contextRefused = `RAISE EXCEPTION USING ERRCODE = '${E.context.errcode}', MESSAGE = '${E.context.message}', DETAIL = '${E.context.detail}';`
const conflict = (detail: string, hint?: string) =>
  `RAISE EXCEPTION USING ERRCODE = '${E.conflict.errcode}', MESSAGE = '${E.conflict.message}', DETAIL = '${detail}'` +
  (hint === undefined ? "" : `, HINT = ${hint}`) +
  ";"

const indent = (lines: readonly string[], depth = 1) =>
  lines.map((line) => `${"  ".repeat(depth)}${line}`)

const ifThen = (condition: string, then: readonly string[]) => [
  `IF ${condition} THEN`,
  ...indent(then),
  "END IF;",
]

const textArray = (values: readonly string[]) =>
  `ARRAY[${values.map(sqlLiteral).join(", ")}]::text[]`

/** Вхід генератора ядра довідника. */
export interface CatalogCommandInput {
  catalogCommands: readonly CatalogCommandContract[]
  contracts: Pick<
    Contracts,
    "rights" | "access" | "roles" | "users" | "membershipSources"
  >
  physical: PhysicalSnapshot
  attributeCase: AttributeCase
  provider: DatabaseProvider
  module: string
  /** Одиниці інших генераторів: функції, які кличе тіло, — ребра `requires`. */
  units: readonly Pick<SqlUnit, "class" | "identity">[]
  parse: SqlParser
  plpgsql: PlpgsqlParser
}

/**
 * Генератор `catalogCommand` (спека П4 §6.6, план A2): `<t>_save` основної
 * таблиці довідника — замок, контекст, версія, перевірка права тими самими
 * предикатами, що й політики запису, посилання, ТЧ і рядок після запису.
 * Лише там, де є функції прав (як політики запису). `SECURITY INVOKER`:
 * кожен запис і кожне читання проходять RLS і гранти ролі команд, ядро лише
 * дає кодовану відмову раніше за сиру. `EXECUTE` — лише роль команд.
 *
 * Зміна завжди виконує `UPDATE` шапки самоприсвоєнням колонок, яких немає в
 * `p_item` (Р-A2-6): так зміна лише ТЧ підвищує версію тим самим шляхом.
 * Тригери платформи на таблиці довідника, які бачать цей `UPDATE`, і їхні
 * умови (жоден не має `UPDATE OF <колонки>`, інакше самоприсвоєння запускало
 * б його хибно; тест тримає це на деревах):
 * - механіка (`mechanics-units.ts`) — `BEFORE UPDATE` версії й дати зміни,
 *   без умови;
 * - авторство (`author-units.ts`) — `BEFORE INSERT OR UPDATE`, без умови;
 * - копії носіїв (`rights/carrier-units.ts`) — `BEFORE INSERT OR UPDATE`
 *   виведення; поширення — `AFTER UPDATE … WHEN (<копійовані колонки
 *   змінилися>)` і `AFTER INSERT`;
 * - ефекти дії (`rights/effects-units.ts`) — `AFTER INSERT OR DELETE` і
 *   `AFTER UPDATE … WHEN (contentChangeCondition)`;
 * - ієрархія (`hierarchy-units.ts`) — `AFTER UPDATE … WHEN (NEW.parent IS
 *   DISTINCT FROM OLD.parent)`;
 * - запобіжники довідників прав (`rights/guard-units.ts`) і підписки
 *   (`subscription-units.ts`) — без списку колонок.
 */
export function buildCatalogCommandUnits(
  input: CatalogCommandInput
): SqlUnit[] {
  const { contracts, provider, parse } = input
  if (!hasRightsFunctions(contracts, provider)) return []
  const rightsById = new Map(contracts.rights.map((r) => [r.objectId, r]))
  const accessByTable = new Map(
    contracts.access.map((a) => [relation(a.table), a])
  )
  const authorLinks = new Set(
    authorCarrierLinks(input.physical, input.attributeCase).map(
      (l) => `${relation(l.table)}\0${l.through}`
    )
  )
  const units: SqlUnit[] = []
  for (const contract of input.catalogCommands) {
    const rights = rightsById.get(contract.objectId)
    if (rights === undefined) continue
    const parts = coreParts(contract, {
      rights,
      access: accessByTable.get(relation(contract.table)),
      attributeCase: input.attributeCase,
      authorLink: (link) =>
        authorLinks.has(`${relation(link.table)}\0${link.through}`),
    })
    const unit = (sql: string, requires?: readonly CreationNode[]) => ({
      ...generatedUnit(sql, contract.table.schema, parse),
      ownerObjectId: contract.objectId,
      module: input.module,
      generator: "catalogCommand" as const,
      ...(requires === undefined ? {} : { requires }),
    })
    // Функція є рівно для тих дій, що їх дав контракт (Р-A2-11): позначки
    // немає в «Користувачів», видалення — лише в «Призначень».
    const { markDeletion, delete: remove } = contract.functions
    const functions: { fn: QualifiedName; args: string; sql: string }[] = [
      {
        fn: contract.functions.save,
        args: "jsonb, bigint",
        sql: saveFunction(contract, parts),
      },
      ...(markDeletion === undefined ||
      contract.actions.markDeletion === undefined
        ? []
        : [
            {
              fn: markDeletion,
              args: "uuid, bigint, boolean",
              sql: markDeletionFunction(
                contract,
                markDeletion,
                contract.actions.markDeletion,
                parts
              ),
            },
          ]),
      ...(remove === undefined || contract.actions.delete === undefined
        ? []
        : [
            {
              fn: remove,
              args: "uuid, bigint",
              sql: deleteFunction(
                contract,
                remove,
                contract.actions.delete,
                parts
              ),
            },
          ]),
    ]
    for (const { fn, args, sql } of functions) {
      units.push(
        unit(sql, bodyRequires(sql, input)),
        ...executeGrants(`${relation(fn)}(${args})`, ["command"], provider).map(
          (grant) => unit(grant)
        )
      )
    }
  }
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}

/**
 * Ребра `requires` тіла: граф тіл plpgsql не читає, тож таблиці й функції,
 * які називають вирази тіла, — явні ребра. Функції — лише ті, що їх дають
 * інші генератори (вбудовані порядку не потребують); таблиці — зі знімка.
 */
function bodyRequires(
  sql: string,
  input: Pick<CatalogCommandInput, "physical" | "units" | "parse" | "plpgsql">
): CreationNode[] {
  const parsed = input.plpgsql(sql)
  if (!parsed.ok || parsed.fn === undefined) {
    throw new Error(
      `internal: command core body does not parse: ${parsed.ok ? "" : parsed.message}\n${sql}`
    )
  }
  const texts = parsed.fn.statements.flatMap((s) =>
    s.expressions.map((e) =>
      e.parseMode === 0
        ? e.query
        : `SELECT ${e.parseMode >= 3 ? e.query.slice(e.query.indexOf(":=") + 2) : e.query}`
    )
  )
  const nodes = new Map<string, CreationNode>()
  for (const text of texts) {
    for (const space of ["rel", "type"] as const) {
      for (const name of textNames(text, input.parse, space)) {
        const table = input.physical.tables.find(
          (t) => t.schema === name.schema && t.name === name.name
        )
        if (table !== undefined) {
          nodes.set(`table:${relation(table)}`, {
            type: "table",
            schema: table.schema,
            name: table.name,
          })
        }
      }
    }
    for (const name of textNames(text, input.parse, "proc")) {
      if (name.schema === undefined) continue
      const prefix = `function:${name.schema}.${name.name}(`
      for (const unit of input.units) {
        if (unit.class === "function" && unit.identity.startsWith(prefix)) {
          nodes.set(unit.identity, { type: "unit", identity: unit.identity })
        }
      }
    }
  }
  return [...nodes.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([, node]) => node)
}

interface CoreFacts {
  rights: RightsContract
  access: AccessContract | undefined
  attributeCase: AttributeCase
  authorLink: (link: CarrierLink) => boolean
}

/** Значення колонки за замовчуванням зі знімка чи `NULL`. */
function defaultOf(table: PhysicalTable, column: string): string {
  return table.columns.find((c) => c.name === column)?.default ?? "NULL"
}

/** Колонки, які результат віддає текстом: `numeric` і `bigint` T3 читає рядками (Рт1). */
function textColumns(table: PhysicalTable, row: string): string | undefined {
  const columns = table.columns.filter((c) =>
    /^(bigint|numeric)(\(.*\))?(\[\])?$/.test(c.type)
  )
  if (columns.length === 0) return undefined
  return `jsonb_build_object(${columns
    .map(
      (c) =>
        `${sqlLiteral(c.name)}, ${row}.${q(c.name)}::${c.type.endsWith("[]") ? "text[]" : "text"}`
    )
    .join(", ")})`
}

const rowJson = (table: PhysicalTable, row: string) => {
  const text = textColumns(table, row)
  return text === undefined ? `to_jsonb(${row})` : `to_jsonb(${row}) || ${text}`
}

/** Обмеження, чий `23505` означає «той самий ключ»: первинний ключ і `UNIQUE (scope, key)`. */
function keyConstraints(table: PhysicalTable, key: string): string[] {
  const scope = table.columns.find(
    (c) => c.origin.scopeKindId !== undefined && c.name !== key
  )?.name
  const names = [
    ...(table.primaryKey === undefined ? [] : [table.primaryKey.name]),
    ...table.uniques
      .filter(
        (u) =>
          scope !== undefined &&
          u.columns.length === 2 &&
          u.columns.includes(scope) &&
          u.columns.includes(key)
      )
      .map((u) => u.name),
  ]
  return names
}

/** Значення й попереднє значення колонки посилання в одному рядку. */
interface ReferenceRow {
  value: (column: string) => string
  old?: (column: string) => string
  /** Значення скоупу рядка; немає — таблиця нескоуплена. */
  scope?: string
  /** Вид скоупу рядка: умова скоупу цілі — лише того самого виду. */
  scopeKindId?: string
}

/**
 * Умова «значення посилання порушене» для одного рядка (спека П4 §6.6):
 * нове чи змінене значення має бути видимим рядком цілі під командою.
 * Одиничний не-масив `single` скоупу не звіряє — його тримає складений FK;
 * масив (FK немає) і пара — звіряють скоуп цілі того самого виду, крім
 * `crossScope`. Ціль — корінь того самого виду: колонка скоупу цілі — сам її
 * ключ, тож умова та сама.
 */
function referenceViolations(
  reference: CommandReference,
  row: ReferenceRow
): { column: string; condition: string }[] {
  const scoped = (target: PhysicalTable, alias: string) => {
    if (
      reference.crossScope === true ||
      row.scope === undefined ||
      row.scopeKindId === undefined
    )
      return ""
    const column = target.columns.find(
      (c) => c.origin.scopeKindId === row.scopeKindId
    )
    return column === undefined
      ? ""
      : ` AND ${alias}.${q(column.name)} = ${row.scope}`
  }
  const visible = (
    target: PhysicalTable,
    key: string,
    value: string,
    withScope: boolean
  ) =>
    `EXISTS (SELECT 1 FROM ${relation(target)} g WHERE g.${q(key)} = ${value}${withScope ? scoped(target, "g") : ""})`

  if (reference.form === "single") {
    const value = row.value(reference.column)
    const old = row.old?.(reference.column)
    if (!reference.array) {
      return [
        {
          column: reference.column,
          condition: `${value} IS NOT NULL${old === undefined ? "" : ` AND ${value} IS DISTINCT FROM ${old}`} AND NOT ${visible(reference.target, reference.targetKey, value, false)}`,
        },
      ]
    }
    return [
      {
        column: reference.column,
        // Новизна елемента — `IS NOT TRUE`: `<> ALL` над старим масивом з `NULL`
        // дає `NULL`, і новий елемент мовчки пропустив би перевірку видимості й
        // скоупу, а FK на елементи масиву немає — це єдиний захист.
        condition: `EXISTS (SELECT 1 FROM unnest(${value}) AS a(v) WHERE a.v IS NOT NULL${old === undefined ? "" : ` AND (a.v = ANY (coalesce(${old}, '{}'))) IS NOT TRUE`} AND NOT ${visible(reference.target, reference.targetKey, "a.v", true)})`,
      },
    ]
  }
  const labels = textArray(reference.targets.map((t) => t.label))
  // В дужках: умову `IF` plpgsql читає до першого `THEN` поза дужками, а
  // `CASE` має власні `THEN`.
  const target = (label: string, id: string) =>
    `(CASE ${label} ${reference.targets
      .map(
        (t) =>
          `WHEN ${sqlLiteral(t.label)} THEN ${visible(t.table, t.key, id, true)}`
      )
      .join(" ")} ELSE true END)`
  const type = row.value(reference.typeColumn)
  const id = row.value(reference.idColumn)
  if (!reference.array) {
    const changed =
      row.old === undefined
        ? ""
        : ` AND (${type} IS DISTINCT FROM ${row.old(reference.typeColumn)} OR ${id} IS DISTINCT FROM ${row.old(reference.idColumn)})`
    return [
      {
        column: reference.typeColumn,
        condition: `${type} IS NOT NULL${changed} AND ${type} <> ALL (${labels})`,
      },
      {
        column: reference.idColumn,
        condition: `${type} IS NOT NULL${changed} AND NOT ${target(type, id)}`,
      },
    ]
  }
  const fresh =
    row.old === undefined
      ? ""
      : ` AND NOT EXISTS (SELECT 1 FROM unnest(${row.old(reference.typeColumn)}, ${row.old(reference.idColumn)}) AS b(t, i) WHERE b.t = a.t AND b.i = a.i)`
  const elements = `FROM unnest(${type}, ${id}) AS a(t, i) WHERE a.t IS NOT NULL${fresh}`
  return [
    {
      column: reference.typeColumn,
      condition: `EXISTS (SELECT 1 ${elements} AND a.t <> ALL (${labels}))`,
    },
    {
      column: reference.idColumn,
      condition: `EXISTS (SELECT 1 ${elements} AND NOT ${target("a.t", "a.i")})`,
    },
  ]
}

/**
 * Спільні частини функцій ядра одного довідника: контекст, замок ієрархії,
 * перевірка права, перевиведення копій, автори. Одне місце, щоб `save`,
 * `mark_deletion` і `delete` не розходилися в умовах відмов.
 */
interface CoreParts {
  facts: CoreFacts
  label: string
  /** Колонка скоупу як вираз `v_new` і вид скоупу рядка. */
  scope: string | undefined
  ownScopeKind: string | undefined
  authors: string[]
  updatedBy: string | undefined
  /** Контекст фази (Р-A2-9): `root` — вираз id рядка функції. */
  context: (action: string, root: string) => string[]
  lock: string
  copyRead: (link: CarrierLink) => string
  /** Перевиведення копій лише змінених зв'язків — як тригер носіїв. */
  relink: (links: readonly CarrierLink[]) => string[]
  rightsIf: (action: string, row: "v_old" | "v_new", reason: string) => string[]
  /** Рядок «до» під замком (Р-A2-18: після контексту) і версія. */
  lockedOld: (root: string) => string[]
}

function coreParts(
  contract: CatalogCommandContract,
  facts: CoreFacts
): CoreParts {
  const { table, key } = contract
  const label = sqlLiteral(contract.kindLabel)
  const ownScopeKind =
    contract.scopeColumn === undefined
      ? undefined
      : table.columns.find((c) => c.name === contract.scopeColumn)?.origin
          .scopeKindId
  const authors = authorColumns()
    .map((def) => ({
      def,
      column: findStandardColumn(table, def, facts.attributeCase)?.name,
    }))
    .filter(
      (a): a is { def: (typeof a)["def"]; column: string } =>
        a.column !== undefined
    )
  // Копії стану «після» — тими самими зв'язками, що й тригер носіїв
  // (Р-A2-4), під командою; зв'язок через колонку авторства — з функції
  // джерел поточного користувача (Р-A2-14), бо рядок «Користувачів» під
  // командою може бути невидимим.
  const copyRead = (link: CarrierLink) =>
    facts.authorLink(link)
      ? `SELECT ${link.copies.map((c) => `s.${q(c.column)}`).join(", ")} INTO ${link.copies.map((c) => `v_new.${q(c.name)}`).join(", ")} FROM ${relation(AUTHOR_CARRIER_SOURCES_FUNCTION)}() s;`
      : carrierCopyRead(link, "v_new", false)
  return {
    facts,
    label,
    scope:
      contract.scopeColumn === undefined
        ? undefined
        : `v_new.${q(contract.scopeColumn)}`,
    ownScopeKind,
    authors: authors.map((a) => a.column),
    updatedBy: authors.find((a) => a.def.logicalName === "updatedBy")?.column,
    context: (action, root) =>
      ifThen(
        `(SELECT ${relation(COMMAND_FUNCTIONS.action)}()) IS DISTINCT FROM ${sqlLiteral(action)} OR (SELECT ${relation(COMMAND_FUNCTIONS.root)}(${label})) IS DISTINCT FROM ${root}`,
        [contextRefused]
      ),
    lock: `PERFORM ${hierarchyLockSql(table)};`,
    copyRead,
    relink: (links) =>
      links.flatMap((link) =>
        ifThen(
          link.pairs
            .map(
              (p) => `v_new.${q(p.local)} IS DISTINCT FROM v_old.${q(p.local)}`
            )
            .join(" OR "),
          [copyRead(link)]
        )
      ),
    rightsIf: (action, row, reason) =>
      ifThen(`(${rightsCheck(facts.rights, action, table, row)}) IS NOT TRUE`, [
        forbidden(reason),
      ]),
    lockedOld: (root) => [
      `SELECT * INTO v_old FROM ${relation(table)} r WHERE r.${q(key)} = ${root} FOR UPDATE;`,
      // Замок застосовує `UPDATE USING` (право дії над станом «до»), тож
      // відсутній і чужий рядок — та сама відмова (Рт4).
      ...ifThen("NOT FOUND", [noRight]),
      ...ifThen(
        `v_old.${q(contract.versionColumn)} IS DISTINCT FROM p_expected_version`,
        [
          conflict(
            E.conflict.version,
            `v_old.${q(contract.versionColumn)}::text`
          ),
        ]
      ),
    ],
  }
}

/** Тіло й оболонка `<t>_save`. */
function saveFunction(
  contract: CatalogCommandContract,
  parts: CoreParts
): string {
  const { key } = contract
  const { facts, label, scope, ownScopeKind, updatedBy, lock, rightsIf } = parts
  const root = `v_in.${q(key)}`
  const context = (action: string) => parts.context(action, root)
  const references = (old: boolean) =>
    contract.references.flatMap((reference) =>
      referenceViolations(reference, {
        value: (c) => `v_new.${q(c)}`,
        ...(old ? { old: (c: string) => `v_old.${q(c)}` } : {}),
        ...(scope === undefined ? {} : { scope }),
        ...(ownScopeKind === undefined ? {} : { scopeKindId: ownScopeKind }),
      }).flatMap(({ column, condition }) =>
        ifThen(condition, [invalid(sqlLiteral(column))])
      )
    )

  const createBranch: string[] =
    contract.actions.create === undefined
      ? [invalid(sqlLiteral("create"))]
      : createLines(contract, {
          context: context(contract.actions.create),
          references: references(false),
          copies: contract.carrierLinks.map(parts.copyRead),
          rights: [
            ...rightsIf(contract.actions.create, "v_new", E.forbidden.noRight),
            // Межа тенанта `scope_insert` (Р-A2-15): предикат контейнера
            // скоупу не має, а скоуп нового рядка задає клієнт.
            ...(facts.access?.scope === undefined || facts.access.root === true
              ? []
              : ifThen(
                  `(${tenantBoundary(facts.access.scope, "v_new")}) IS NOT TRUE`,
                  [noRight]
                )),
          ],
          authors: parts.authors,
          lock,
          label,
        })

  const updateBranch: string[] = [
    ...context(contract.actions.update),
    // Замок ієрархії до замка рядка (Р-A2-17): тригер ієрархії бере його
    // після `UPDATE`, і без цього порядок «рядок → advisory» проти іншої
    // команди «advisory → рядок» дав би `40P01`.
    ...(contract.hierarchy === undefined
      ? []
      : contract.hierarchy.lockAlways
        ? [lock]
        : ifThen(`p_item ? ${sqlLiteral(contract.hierarchy.parent)}`, [lock])),
    ...parts.lockedOld(root),
    ...rightsIf(contract.actions.update, "v_old", E.forbidden.noRight),
    "v_new := v_old;",
    ...contract.updateKeys.flatMap((c) =>
      ifThen(`p_item ? ${sqlLiteral(c)}`, [`v_new.${q(c)} := v_in.${q(c)};`])
    ),
    ...(updatedBy === undefined
      ? []
      : [`v_new.${q(updatedBy)} := ${CURRENT_USER};`]),
    ...references(true),
    // Перевиведення лише змінених зв'язків — як тригер носіїв: незмінений
    // зв'язок лишає копію рядка.
    ...parts.relink(contract.carrierLinks),
    ...rightsIf(contract.actions.update, "v_new", E.forbidden.newCarrier),
    headerUpdate(contract),
    // Відкликання права між замком і `UPDATE` (`READ COMMITTED`): політики
    // застосовуються знову й дають нуль рядків — це відмова, не успіх.
    "GET DIAGNOSTICS v_count = ROW_COUNT;",
    ...ifThen("v_count = 0", [noRight]),
  ]

  return coreFunction(
    contract.functions.save,
    "p_item jsonb, p_expected_version bigint",
    [
      "v_in record;",
      "v_old record;",
      "v_new record;",
      "v_row record;",
      "v_count bigint;",
      "v_key text;",
      "v_constraint text;",
      "v_ids uuid[];",
      "v_result jsonb;",
      "v_tabular jsonb;",
    ],
    [
      ...inputLines(contract),
      "IF p_expected_version IS NULL THEN",
      ...indent(createBranch),
      "ELSE",
      ...indent(updateBranch),
      "END IF;",
      ...tabularLines(contract, scope, ownScopeKind),
      ...resultLines(contract, root, true),
    ]
  )
}

/**
 * Перевірка входу (Р-A2-5, Р-A2-7): об'єкт, лише ключі гранту гілки, кожне
 * значення приводиться до типу своєї колонки. Приведення — поколонково у
 * вузькому блоці: помилка класу `22` інакше не назвала б ключа.
 */
function inputLines(contract: CatalogCommandContract): string[] {
  const t = relation(contract.table)
  const allowed = (keys: readonly string[]) =>
    textArray([...new Set([...keys, "tabular"])])
  const unknown = (keys: readonly string[]) =>
    `SELECT k.k INTO v_key FROM jsonb_object_keys(p_item) AS k(k) WHERE k.k <> ALL (${allowed(keys)}) ORDER BY k.k LIMIT 1;`
  return [
    ...ifThen("jsonb_typeof(p_item) IS DISTINCT FROM 'object'", [
      invalid("'p_item'"),
    ]),
    // Без дії створення (Р-A2-10: «Користувачі», корінь скоупу) виклик без
    // версії — відмова `create` до перевірки ключів: інакше порожній перелік
    // ключів створення назвав би першим невідомим ключем `id`, а не причину.
    ...(contract.actions.create === undefined
      ? ifThen("p_expected_version IS NULL", [invalid("'create'")])
      : []),
    "IF p_expected_version IS NULL THEN",
    ...indent([unknown(contract.createKeys)]),
    "ELSE",
    ...indent([unknown([contract.key, ...contract.updateKeys])]),
    "END IF;",
    ...ifThen("v_key IS NOT NULL", [invalid("v_key")]),
    "BEGIN",
    ...indent([
      "FOR v_key IN SELECT k.k FROM jsonb_object_keys(p_item) AS k(k) WHERE k.k <> 'tabular' ORDER BY k.k LOOP",
      `  PERFORM jsonb_populate_record(NULL::${t}, jsonb_build_object(v_key, p_item -> v_key));`,
      "END LOOP;",
    ]),
    "EXCEPTION WHEN data_exception THEN",
    ...indent([invalid("v_key")]),
    "END;",
    `v_in := jsonb_populate_record(NULL::${t}, p_item);`,
    ...ifThen(`v_in.${q(contract.key)} IS NULL`, [
      invalid(sqlLiteral(contract.key)),
    ]),
  ]
}

/** Гілка створення (`p_expected_version IS NULL`). */
function createLines(
  contract: CatalogCommandContract,
  parts: {
    context: string[]
    references: string[]
    copies: string[]
    rights: string[]
    authors: string[]
    lock: string
    label: string
  }
): string[] {
  const { table, key } = contract
  const t = relation(table)
  const exists = `PERFORM 1 FROM ${t} r WHERE r.${q(key)} = v_in.${q(key)};`
  const constraints = keyConstraints(table, key)
  return [
    ...parts.context,
    exists,
    ...ifThen("FOUND", [conflict(E.conflict.exists)]),
    // Поле `record` без структури дає `55000`: форму рядка — першою.
    `v_new := jsonb_populate_record(NULL::${t}, '{}');`,
    ...contract.createKeys.map(
      (c) =>
        `v_new.${q(c)} := CASE WHEN p_item ? ${sqlLiteral(c)} THEN v_in.${q(c)} ELSE ${defaultOf(table, c)} END;`
    ),
    ...parts.authors.map((c) => `v_new.${q(c)} := ${CURRENT_USER};`),
    ...parts.references,
    ...parts.copies,
    ...parts.rights,
    // Замок ієрархії до `INSERT` (Р-A2-17): RI-тригер бере `FOR KEY SHARE`
    // на батька раніше за тригер ієрархії.
    ...(contract.hierarchy === undefined
      ? []
      : contract.hierarchy.lockAlways
        ? [parts.lock]
        : ifThen(`v_new.${q(contract.hierarchy.parent)} IS NOT NULL`, [
            parts.lock,
          ])),
    // Блок лише навколо `INSERT`: підтранзакція відкочує лише його, тож
    // повторне читання після `23505` можливе — новий оператор у
    // `READ COMMITTED` бачить коміт паралельного створення (Р-A2-8).
    "BEGIN",
    ...indent([
      `INSERT INTO ${t} (${contract.createKeys.map(q).join(", ")}) VALUES (${contract.createKeys.map((c) => `v_new.${q(c)}`).join(", ")}) RETURNING * INTO v_row;`,
    ]),
    "EXCEPTION WHEN unique_violation THEN",
    ...indent([
      "GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;",
      ...ifThen(`v_constraint <> ALL (${textArray(constraints)})`, ["RAISE;"]),
      exists,
      ...ifThen("FOUND", [conflict(E.conflict.exists)]),
      noRight,
    ]),
    "END;",
  ]
}

/** `UPDATE` шапки: самоприсвоєння колонок, яких немає в `p_item` (Р-A2-6). */
function headerUpdate(contract: CatalogCommandContract): string {
  if (contract.updateKeys.length === 0) {
    throw new Error(
      `internal: command core of ${relation(contract.table)} has no update keys`
    )
  }
  const set = contract.updateKeys
    .map(
      (c) =>
        `${q(c)} = CASE WHEN p_item ? ${sqlLiteral(c)} THEN v_in.${q(c)} ELSE ${q(c)} END`
    )
    .join(", ")
  return `UPDATE ${relation(contract.table)} SET ${set} WHERE ${q(contract.key)} = v_in.${q(contract.key)} RETURNING * INTO v_row;`
}

/** ТЧ (спека П4 §6.6): після DML шапки, кожна — лише коли її названо в `p_item`. */
function tabularLines(
  contract: CatalogCommandContract,
  scope: string | undefined,
  scopeKindId: string | undefined
): string[] {
  if (contract.tabularSections.length === 0) {
    return ifThen("p_item ? 'tabular'", [invalid("'tabular'")])
  }
  const names = contract.tabularSections.map((s) => s.table.name)
  return ifThen("p_item ? 'tabular'", [
    ...ifThen("jsonb_typeof(p_item -> 'tabular') IS DISTINCT FROM 'object'", [
      invalid("'tabular'"),
    ]),
    `SELECT k.k INTO v_key FROM jsonb_object_keys(p_item -> 'tabular') AS k(k) WHERE k.k <> ALL (${textArray(names)}) ORDER BY k.k LIMIT 1;`,
    ...ifThen("v_key IS NOT NULL", [invalid("'tabular.' || v_key")]),
    ...contract.tabularSections.flatMap((section) =>
      sectionLines(contract, section, scope, scopeKindId)
    ),
  ])
}

function sectionLines(
  contract: CatalogCommandContract,
  section: CatalogCommandSection,
  scope: string | undefined,
  scopeKindId: string | undefined
): string[] {
  const ts = relation(section.table)
  const name = section.table.name
  const items = `p_item -> 'tabular' -> ${sqlLiteral(name)}`
  const detail = (suffix?: string) =>
    sqlLiteral(`tabular.${name}${suffix === undefined ? "" : `.${suffix}`}`)
  const root = `v_in.${q(contract.key)}`
  const key = q(section.key)
  const parent = q(section.parent)
  const elements = `jsonb_array_elements(${items}) WITH ORDINALITY AS x(e, ord) CROSS JOIN LATERAL jsonb_populate_record(NULL::${ts}, x.e) AS v`
  const constraints = keyConstraints(section.table, section.key)
  // Перевіряється те, що буде записано (як `v_new` шапки): рядок «після» —
  // наявний рядок цього власника з накладеними ключами елемента, новий —
  // значення за замовчуванням з накладеним входом, рівно як `UPDATE` і
  // `INSERT` нижче. Над самим входом відсутній ключ читався б як `NULL`, і
  // елемент лише з `id` пари пропустив би перевірку цілі за старим типом.
  const updatable = new Set(section.updateColumns)
  const afterColumns = [
    ...new Set(
      section.references.flatMap((r) =>
        r.form === "single" ? [r.column] : [r.typeColumn, r.idColumn]
      )
    ),
  ]
  const afterValue = (c: string) => {
    const given = `WHEN x.e ? ${sqlLiteral(c)} THEN v.${q(c)}`
    const stored = `WHEN o.${key} IS NOT NULL THEN o.${q(c)}`
    // Колонку поза `updateColumns` `UPDATE` не змінює й за наявного ключа.
    return `CASE ${updatable.has(c) ? `${given} ${stored}` : `${stored} ${given}`} ELSE ${defaultOf(section.table, c)} END AS ${q(c)}`
  }
  const afterRows = `${elements} LEFT JOIN ${ts} o ON o.${key} = v.${key} AND o.${parent} = ${root} CROSS JOIN LATERAL (SELECT ${afterColumns.map(afterValue).join(", ")}) AS n`
  const references = section.references.flatMap((reference) =>
    referenceViolations(reference, {
      value: (c) => `n.${q(c)}`,
      // Новий рядок (`o` — `NULL`) перевіряє кожне значення, наявний рядок
      // цього власника — лише змінене проти збереженого.
      old: (c) => `o.${q(c)}`,
      ...(scope === undefined ? {} : { scope }),
      ...(scopeKindId === undefined ? {} : { scopeKindId }),
    }).flatMap(({ column, condition }) =>
      ifThen(`EXISTS (SELECT 1 FROM ${afterRows} WHERE ${condition})`, [
        invalid(detail(column)),
      ])
    )
  )
  const insertColumns = [
    section.key,
    section.parent,
    section.lineNumber,
    ...(section.scopeColumn === undefined ? [] : [section.scopeColumn]),
    ...section.rowKeys,
  ]
  const insertValues = [
    `v.${key}`,
    root,
    "x.ord",
    ...(section.scopeColumn === undefined
      ? []
      : [`v_new.${q(must(contract.scopeColumn))}`]),
    ...section.rowKeys.map(
      (c) =>
        `CASE WHEN x.e ? ${sqlLiteral(c)} THEN v.${q(c)} ELSE ${defaultOf(section.table, c)} END`
    ),
  ]
  const set = [
    ...section.updateColumns.map(
      (c) =>
        `${q(c)} = CASE WHEN x.e ? ${sqlLiteral(c)} THEN v.${q(c)} ELSE r.${q(c)} END`
    ),
    `${q(section.lineNumber)} = x.ord`,
  ].join(", ")
  return ifThen(`p_item -> 'tabular' ? ${sqlLiteral(name)}`, [
    ...ifThen(`jsonb_typeof(${items}) IS DISTINCT FROM 'array'`, [
      invalid(detail()),
    ]),
    ...ifThen(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(${items}) AS x(e) WHERE jsonb_typeof(x.e) IS DISTINCT FROM 'object')`,
      [invalid(detail())]
    ),
    `SELECT k.k INTO v_key FROM jsonb_array_elements(${items}) AS x(e) CROSS JOIN LATERAL jsonb_object_keys(x.e) AS k(k) WHERE k.k <> ALL (${textArray([...section.rowKeys, section.key])}) ORDER BY k.k LIMIT 1;`,
    ...ifThen("v_key IS NOT NULL", [invalid(`${detail()} || '.' || v_key`)]),
    ...ifThen(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(${items}) AS x(e) WHERE NOT coalesce(pg_input_is_valid(x.e ->> ${sqlLiteral(section.key)}, 'uuid'), false))`,
      [invalid(detail(section.key))]
    ),
    ...ifThen(
      `(SELECT count(*) <> count(DISTINCT (x.e ->> ${sqlLiteral(section.key)})::uuid) FROM jsonb_array_elements(${items}) AS x(e))`,
      [invalid(detail())]
    ),
    "BEGIN",
    ...indent([
      `FOR v_key IN SELECT DISTINCT k.k FROM jsonb_array_elements(${items}) AS x(e) CROSS JOIN LATERAL jsonb_object_keys(x.e) AS k(k) ORDER BY k.k LOOP`,
      `  PERFORM jsonb_populate_record(NULL::${ts}, jsonb_build_object(v_key, x.e -> v_key)) FROM jsonb_array_elements(${items}) AS x(e) WHERE x.e ? v_key;`,
      "END LOOP;",
    ]),
    "EXCEPTION WHEN data_exception THEN",
    ...indent([invalid(`${detail()} || '.' || v_key`)]),
    "END;",
    `v_ids := ARRAY(SELECT (x.e ->> ${sqlLiteral(section.key)})::uuid FROM jsonb_array_elements(${items}) AS x(e));`,
    // Видимий рядок іншого власника — та сама відмова, що невидимий
    // (`23505` нижче, Р-A2-12).
    ...ifThen(
      `EXISTS (SELECT 1 FROM ${ts} r WHERE r.${key} = ANY (v_ids) AND r.${parent} <> ${root})`,
      [noRight]
    ),
    ...references,
    `DELETE FROM ${ts} r WHERE r.${parent} = ${root} AND r.${key} <> ALL (v_ids);`,
    `UPDATE ${ts} r SET ${set} FROM ${elements} WHERE r.${key} = v.${key} AND r.${parent} = ${root};`,
    "BEGIN",
    ...indent([
      `INSERT INTO ${ts} (${insertColumns.map(q).join(", ")}) SELECT ${insertValues.join(", ")} FROM ${elements} WHERE NOT EXISTS (SELECT 1 FROM ${ts} r WHERE r.${key} = v.${key} AND r.${parent} = ${root});`,
    ]),
    "EXCEPTION WHEN unique_violation THEN",
    ...indent([
      "GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;",
      ...ifThen(`v_constraint = ANY (${textArray(constraints)})`, [noRight]),
      "RAISE;",
    ]),
    "END;",
  ])
}

/**
 * Результат: рядок повертає `RETURNING`; що він видимий автору, гарантує
 * замикання прав (запис ⊆ читання за обсягом, `rights.requires-missing`) —
 * інакше `RETURNING` дав би сирий `42501`. Інваріант тримає тест
 * `reports a missing requirement once per mistake and role` у
 * `compiler/__tests__/rights-expand.test.ts`.
 */
function resultLines(
  contract: CatalogCommandContract,
  root: string,
  tabular: boolean
): string[] {
  const { table } = contract
  return [
    `v_result := ${rowJson(table, "v_row")};`,
    ...(!tabular || contract.tabularSections.length === 0
      ? []
      : ifThen("p_item ? 'tabular'", [
          "v_tabular := '{}';",
          ...contract.tabularSections.flatMap((section) =>
            ifThen(`p_item -> 'tabular' ? ${sqlLiteral(section.table.name)}`, [
              `v_tabular := v_tabular || jsonb_build_object(${sqlLiteral(section.table.name)}, (SELECT coalesce(jsonb_agg(${rowJson(section.table, "r")} ORDER BY r.${q(section.lineNumber)}), '[]') FROM ${relation(section.table)} r WHERE r.${q(section.parent)} = ${root}));`,
            ])
          ),
          "v_result := v_result || jsonb_build_object('tabular', v_tabular);",
        ])),
    "RETURN v_result::text;",
  ]
}

/** Оболонка функції ядра: `SECURITY INVOKER`, порожній `search_path`. */
function coreFunction(
  fn: QualifiedName,
  args: string,
  declarations: readonly string[],
  statements: readonly string[]
): string {
  const body = [
    "DECLARE",
    ...indent(declarations),
    "BEGIN",
    ...indent(statements),
    "END",
  ].join("\n")
  const tag = dollarTag(body)
  return (
    `CREATE OR REPLACE FUNCTION ${relation(fn)}(${args})\n` +
    `RETURNS text\n` +
    `LANGUAGE plpgsql VOLATILE SECURITY INVOKER\n` +
    `SET search_path = ''\n` +
    `AS ${tag}\n${body}\n${tag};`
  )
}

/**
 * `<t>_mark_deletion` (спека П4 §6.6): позначка — та сама зміна рядка, що й
 * `save`, лише одна колонка. Посилань на рядок не шукає (Рт12): позначка не
 * видаляє. Предвизначений рядок перевіряється після права — інакше відмова
 * без права розкривала б, що рядок предвизначений (Рт4).
 */
function markDeletionFunction(
  contract: CatalogCommandContract,
  fn: QualifiedName,
  action: string,
  parts: CoreParts
): string {
  const { table, key } = contract
  const root = "p_id"
  // Позначку пише лише ця функція (Р-A2-5); колонка — за `origin`.
  const mark = q(
    standardColumn(table, deletionMarkColumn(), parts.facts.attributeCase).name
  )
  // Позначка змінює лише себе й автора зміни: перевиводяться лише зв'язки
  // через ці колонки (зв'язок через автора — з функції джерел, Р-A2-14).
  const changed = new Set([
    mark,
    ...(parts.updatedBy === undefined ? [] : [q(parts.updatedBy)]),
  ])
  const statements = [
    ...ifThen("p_mark IS NULL", [invalid("'p_mark'")]),
    ...ifThen("p_expected_version IS NULL", [invalid("'p_expected_version'")]),
    ...parts.context(action, root),
    // Обробник `beforeWrite`, що присвоює батька, спрацьовує й на `UPDATE`
    // позначки: замок ієрархії — до замка рядка (Р-A2-17).
    ...(contract.hierarchy?.lockAlways === true ? [parts.lock] : []),
    ...parts.lockedOld(root),
    ...parts.rightsIf(action, "v_old", E.forbidden.noRight),
    "v_new := v_old;",
    `v_new.${mark} := p_mark;`,
    ...(parts.updatedBy === undefined
      ? []
      : [`v_new.${q(parts.updatedBy)} := ${CURRENT_USER};`]),
    ...parts.relink(
      contract.carrierLinks.filter((link) =>
        link.pairs.some((p) => changed.has(q(p.local)))
      )
    ),
    ...parts.rightsIf(action, "v_new", E.forbidden.newCarrier),
    ...(contract.predefinedColumn === undefined
      ? []
      : ifThen(`v_old.${q(contract.predefinedColumn)} IS NOT NULL`, [
          invalid("'predefined'"),
        ])),
    `UPDATE ${relation(table)} SET ${mark} = p_mark WHERE ${q(key)} = ${root} RETURNING * INTO v_row;`,
    // Відкликання права між замком і `UPDATE` — нуль рядків, відмова.
    "GET DIAGNOSTICS v_count = ROW_COUNT;",
    ...ifThen("v_count = 0", [noRight]),
    ...resultLines(contract, root, false),
  ]
  return coreFunction(
    fn,
    "p_id uuid, p_expected_version bigint, p_mark boolean",
    [
      "v_old record;",
      "v_new record;",
      "v_row record;",
      "v_count bigint;",
      "v_result jsonb;",
    ],
    statements
  )
}

/**
 * `<t>_delete` — лише «Призначення» (спека П4 §6.6): призначення не має
 * посилань на себе, тож видаляється фізично. Результат — ключ і версія
 * видаленого рядка; читати рядок після `DELETE` нічого.
 */
function deleteFunction(
  contract: CatalogCommandContract,
  fn: QualifiedName,
  action: string,
  parts: CoreParts
): string {
  const { table, key } = contract
  const root = "p_id"
  const statements = [
    // Без версії `lockedOld` дав би `conflict`: вхід без версії — помилка
    // виклику, як у позначці видалення, а не конфлікт.
    ...ifThen("p_expected_version IS NULL", [invalid("'p_expected_version'")]),
    ...parts.context(action, root),
    ...parts.lockedOld(root),
    ...parts.rightsIf(action, "v_old", E.forbidden.noRight),
    `DELETE FROM ${relation(table)} WHERE ${q(key)} = ${root};`,
    // Відкликання права між замком і `DELETE` — нуль рядків, відмова.
    "GET DIAGNOSTICS v_count = ROW_COUNT;",
    ...ifThen("v_count = 0", [noRight]),
    `RETURN jsonb_build_object(${sqlLiteral(key)}, ${root}, ${sqlLiteral(contract.versionColumn)}, v_old.${q(contract.versionColumn)}::text)::text;`,
  ]
  return coreFunction(
    fn,
    "p_id uuid, p_expected_version bigint",
    ["v_old record;", "v_count bigint;"],
    statements
  )
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("internal: missing command input")
  return value
}
