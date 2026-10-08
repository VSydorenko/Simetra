import {
  PLATFORM_SCHEMA,
  PROVIDER_API_ROLES,
  quoteIdent,
  type ApiRolePurpose,
  type IdentityNameSource,
  type IdentitySource,
  type PhysicalSnapshot,
  type Project,
} from "simetra/model"
import type { QualifiedName, UsersContract } from "../contracts"
import { compareStrings } from "../diagnostics"
import { dollarTag } from "../movement-functions"
import type { CreationNode } from "../sql/dependencies"
import type { SqlParser } from "../sql/parse"
import { executeGrants } from "../sql/execute-grants"
import { generatedUnit, type SqlUnit } from "../sql/units"
import type { ParsedObject } from "../stages/files"
import { kindLabelOf, sqlLiteral } from "../stages/model"
import { IDENTITIES_TABLE } from "./identities"

/**
 * Призначення ролей запитів API: функцію сесії в політиці виконує роль
 * запиту, тож їм потрібні `USAGE` схеми й `EXECUTE` функції поточного
 * користувача (спека користувачів §3). Сервісна роль сесії не має й отримує
 * `NULL`, а не помилку доступу. Схему від PostgREST ховає конфіг провайдера, а
 * не відсутність `USAGE`; таблиці схеми закриті відсутністю грантів.
 */
const SESSION_ROLES: readonly ApiRolePurpose[] = [
  "authenticated",
  "anon",
  "service",
]

const IDENTITIES: QualifiedName = {
  schema: PLATFORM_SCHEMA,
  name: IDENTITIES_TABLE,
}

const fn = (name: string): QualifiedName => ({ schema: PLATFORM_SCHEMA, name })
const CURRENT_USER = fn("current_user_id")
const PROVISION = fn("provision_user")
const ON_CREATED = fn("on_auth_user_created")
const ON_REMOVED = fn("on_auth_user_removed")

/** Тригери шару на таблиці облікових записів провайдера. */
const TRIGGERS = {
  provision: "simetra_provision_user",
  provisionConverted: "simetra_provision_converted_user",
  invalidate: "simetra_invalidate_user",
  invalidateSoftDelete: "simetra_invalidate_user_soft_delete",
} as const

const KIND_LABELS = fn("kind_labels")
const KIND_LABEL_COLUMNS = [
  "label",
  "kind",
  "object_id",
  "name",
  "schema",
  "table_name",
] as const

/** Вхід генератора: модель без помилок (стадії 1–5). */
export interface PlatformLayerInput {
  objects: readonly ParsedObject[]
  physical: PhysicalSnapshot
  contracts: { users?: UsersContract }
  project: Pick<Project, "name" | "database">
}

/**
 * Платформний шар схеми `simetra` (спека користувачів §3–§5, спека П2 §8.3):
 * гранти схеми, функції сесії й провізії, тригери на таблиці облікових
 * записів провайдера й в'юха міток виду — згенеровані одиниці без файлу з
 * власником «Користувачі». Без довідника з роллю «користувачі» шар порожній.
 *
 * Кожна функція — `SECURITY DEFINER` з порожнім `search_path` і повністю
 * кваліфікованими іменами: тригер провайдера спрацьовує від ролі сервісу
 * автентифікації без прав на `simetra` і схеми застосунку, а функцію сесії
 * кличе роль запиту. `EXECUTE` від `PUBLIC` і ролей провайдера відкликано на
 * кожній; явно його має лише функція поточного користувача — кожна роль API. Функції —
 * plpgsql: тіла Postgres при створенні не перевіряє, а порядок дають явні
 * ребра `requires`.
 *
 * SQL провізії й недійсності один загальний над фактами `source`: новий
 * провайдер — новий запис `PROVIDER_IDENTITY_SOURCES`, а не новий SQL.
 */
export function buildPlatformUnits(
  input: PlatformLayerInput,
  parse: SqlParser,
  source: IdentitySource
): SqlUnit[] {
  const { users } = input.contracts
  if (users === undefined) return []
  const tables: CreationNode[] = [
    { type: "table", ...users.table },
    { type: "table", ...IDENTITIES },
  ]
  const unit = (sql: string, requires?: readonly CreationNode[]): SqlUnit => ({
    ...generatedUnit(sql, PLATFORM_SCHEMA, parse),
    ownerObjectId: users.objectId,
    module: input.project.name,
    generator: "platformLayer",
    ...(requires === undefined ? {} : { requires }),
  })
  // Тригерна функція реєстрації кличе провізію з тіла plpgsql: ребро до неї
  // бере ідентичність самої одиниці, а не другий запис сигнатури.
  const provision = unit(provisionFunction(users), tables)
  const schema = quoteIdent(PLATFORM_SCHEMA)
  const { provider } = input.project.database
  const apiRoles = PROVIDER_API_ROLES[provider]
  const functions = [
    {
      signature: `${qualified(CURRENT_USER)}()`,
      fn: unit(currentUserFunction(users, source), tables),
      roles: SESSION_ROLES,
    },
    {
      signature: `${qualified(PROVISION)}(text, text, uuid, text)`,
      fn: provision,
      roles: [],
    },
    {
      signature: `${qualified(ON_CREATED)}()`,
      fn: unit(onCreatedFunction(source), [
        { type: "unit", identity: provision.identity },
      ]),
      roles: [],
    },
    {
      signature: `${qualified(ON_REMOVED)}()`,
      fn: unit(onRemovedFunction(users, source), tables),
      roles: [],
    },
  ]
  const units: SqlUnit[] = [
    unit(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;`),
    // Гранти поштучно на отримувача — та сама форма, в якій їх читає
    // extract, тож зворотна генерація впізнає їх як описані.
    ...SESSION_ROLES.map((purpose) =>
      unit(
        `GRANT USAGE ON SCHEMA ${schema} TO ${quoteIdent(apiRoles[purpose])};`
      )
    ),
    ...functions.flatMap(({ signature, fn, roles }) => [
      fn,
      ...executeGrants(signature, roles, provider).map((grant) => unit(grant)),
    ]),
    ...triggers(source).map((sql) => unit(sql)),
    unit(kindLabelsView(input.objects, input.physical)),
  ]
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}

/**
 * Поточний користувач (спека користувачів §7): `sub` з claims запиту,
 * ідентичність провайдера й лише дійсний користувач; інакше `NULL`. `sub`
 * порівнюється як текст, тож `sub`, що не є uuid, дає `NULL` без помилки.
 */
function currentUserFunction(
  users: UsersContract,
  source: IdentitySource
): string {
  return plpgsqlFunction(`${qualified(CURRENT_USER)}()`, "uuid", "STABLE", [
    "DECLARE",
    "  v_subject text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub';",
    "BEGIN",
    "  RETURN (",
    "    SELECT i.user_id",
    `    FROM ${qualified(IDENTITIES)} i`,
    `    JOIN ${qualified(users.table)} u ON u.${quoteIdent(users.keyColumn)} = i.user_id`,
    `    WHERE i.provider = ${sqlLiteral(source.providerKey)}`,
    "      AND i.subject = v_subject",
    `      AND NOT u.${quoteIdent(users.invalidColumn)}`,
    "  );",
    "END",
  ])
}

/**
 * Провізія (спека користувачів §5): ідентичність вставляється першою (FK
 * відкладений), наявна ідентичність повертає наявного користувача, а друга
 * паралельна вставка чекає першу й отримує `DO NOTHING`. Найменування
 * обрізається до довжини колонки — довге ім'я не валить реєстрацію. Логіки
 * застосунку функція не кличе.
 */
function provisionFunction(users: UsersContract): string {
  const key = quoteIdent(users.keyColumn)
  return plpgsqlFunction(
    `${qualified(PROVISION)}(p_provider text, p_subject text, p_user_id uuid, p_display_name text)`,
    "uuid",
    undefined,
    [
      "DECLARE",
      "  v_user_id uuid;",
      "BEGIN",
      `  INSERT INTO ${qualified(IDENTITIES)} (provider, subject, user_id)`,
      "  VALUES (p_provider, p_subject, p_user_id)",
      "  ON CONFLICT DO NOTHING",
      "  RETURNING user_id INTO v_user_id;",
      "  IF v_user_id IS NULL THEN",
      "    SELECT i.user_id INTO v_user_id",
      `    FROM ${qualified(IDENTITIES)} i`,
      "    WHERE i.provider = p_provider AND i.subject = p_subject;",
      "    RETURN v_user_id;",
      "  END IF;",
      `  INSERT INTO ${qualified(users.table)} (${key}, ${quoteIdent(users.descriptionColumn)})`,
      `  VALUES (p_user_id, left(p_display_name, ${users.descriptionLength}))`,
      `  ON CONFLICT (${key}) DO NOTHING;`,
      "  RETURN p_user_id;",
      "END",
    ]
  )
}

/**
 * Тригерна функція реєстрації й конвертації: анонімний вхід не провізується, а
 * найменування — перше непорожнє джерело провайдера або нейтральне
 * `user <початок ключа>`, тож ніколи не `NULL` і не порожнє.
 */
function onCreatedFunction(source: IdentitySource): string {
  const key = `NEW.${quoteIdent(source.keyColumn)}`
  return plpgsqlFunction(`${qualified(ON_CREATED)}()`, "trigger", undefined, [
    "BEGIN",
    ...(source.anonymousColumn === undefined
      ? []
      : [
          `  IF NEW.${quoteIdent(source.anonymousColumn)} IS TRUE THEN`,
          "    RETURN NULL;",
          "  END IF;",
        ]),
    `  PERFORM ${qualified(PROVISION)}(`,
    `    ${sqlLiteral(source.providerKey)},`,
    `    ${key}::text,`,
    `    ${key},`,
    "    coalesce(",
    ...source.nameSources.map(
      (name) => `      nullif(btrim(${nameExpression(name)}), ''),`
    ),
    `      'user ' || left(${key}::text, 8)`,
    "    )",
    "  );",
    "  RETURN NULL;",
    "END",
  ])
}

/**
 * Недійсність (спека користувачів §6): обліковий запис видалено фізично чи
 * м'яко — ідентичність зникає, користувач стає недійсним, але рядок лишається:
 * на нього посилаються авторство й дані застосунку.
 */
function onRemovedFunction(
  users: UsersContract,
  source: IdentitySource
): string {
  return plpgsqlFunction(`${qualified(ON_REMOVED)}()`, "trigger", undefined, [
    "DECLARE",
    "  v_user_id uuid;",
    "BEGIN",
    `  DELETE FROM ${qualified(IDENTITIES)} i`,
    `  WHERE i.provider = ${sqlLiteral(source.providerKey)}`,
    `    AND i.subject = OLD.${quoteIdent(source.keyColumn)}::text`,
    "  RETURNING i.user_id INTO v_user_id;",
    "  IF v_user_id IS NOT NULL THEN",
    `    UPDATE ${qualified(users.table)} SET ${quoteIdent(users.invalidColumn)} = true`,
    `    WHERE ${quoteIdent(users.keyColumn)} = v_user_id;`,
    "  END IF;",
    "  RETURN NULL;",
    "END",
  ])
}

/**
 * Реєстрація, конвертація анонімного входу, видалення й м'яке видалення
 * облікового запису. Конвертація — UPDATE того самого рядка, тож провізує її
 * окремий тригер тією самою ідемпотентною функцією: джерела найменування
 * читаються на момент конвертації.
 */
function triggers(source: IdentitySource): string[] {
  const table = qualified(source.table)
  const execute = (name: QualifiedName) =>
    `FOR EACH ROW EXECUTE FUNCTION ${qualified(name)}();`
  const anonymous =
    source.anonymousColumn === undefined
      ? undefined
      : quoteIdent(source.anonymousColumn)
  const deletedAt =
    source.deletedAtColumn === undefined
      ? undefined
      : quoteIdent(source.deletedAtColumn)
  return [
    `CREATE TRIGGER ${TRIGGERS.provision} AFTER INSERT ON ${table} ${execute(ON_CREATED)}`,
    ...(anonymous === undefined
      ? []
      : [
          `CREATE TRIGGER ${TRIGGERS.provisionConverted} AFTER UPDATE OF ${anonymous} ON ${table} ` +
            `FOR EACH ROW WHEN (OLD.${anonymous} IS TRUE AND NEW.${anonymous} IS NOT TRUE) ` +
            `EXECUTE FUNCTION ${qualified(ON_CREATED)}();`,
        ]),
    `CREATE TRIGGER ${TRIGGERS.invalidate} AFTER DELETE ON ${table} ${execute(ON_REMOVED)}`,
    ...(deletedAt === undefined
      ? []
      : [
          `CREATE TRIGGER ${TRIGGERS.invalidateSoftDelete} AFTER UPDATE OF ${deletedAt} ON ${table} ` +
            `FOR EACH ROW WHEN (OLD.${deletedAt} IS NULL AND NEW.${deletedAt} IS NOT NULL) ` +
            `EXECUTE FUNCTION ${qualified(ON_REMOVED)}();`,
        ]),
  ]
}

/**
 * Довідник міток виду (спека промоції §9.11): ручний SQL робить `JOIN`, а не
 * `CASE`. Мітка — у `COLLATE "C"`, як колонки `_type`: порядок не залежить
 * від колляції ОС. Без об'єктів із міткою в'юха порожня, але з тими самими
 * типізованими колонками.
 */
function kindLabelsView(
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot
): string {
  const rows = objects
    .flatMap((object) => {
      const label = kindLabelOf(object)
      const table = physical.tables.find(
        (t) =>
          t.origin.objectId === object.id &&
          t.origin.tabularSectionId === undefined &&
          t.origin.part === undefined
      )
      if (label === undefined || table === undefined) return []
      return [
        {
          label,
          values: [
            sqlLiteral(label),
            sqlLiteral(object.kind),
            `${sqlLiteral(object.id ?? "")}::uuid`,
            sqlLiteral(object.name),
            sqlLiteral(table.schema),
            sqlLiteral(table.name),
          ],
        },
      ]
    })
    .sort((a, b) => compareStrings(a.label, b.label))
  const columns = KIND_LABEL_COLUMNS.map(quoteIdent)
  const head = `CREATE OR REPLACE VIEW ${qualified(KIND_LABELS)} (${columns.join(", ")}) AS`
  if (rows.length === 0) {
    return [
      head,
      'SELECT NULL::text COLLATE "C", NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::text',
      "WHERE false;",
    ].join("\n")
  }
  const v = (column: string) => `v.${column}`
  return [
    head,
    `SELECT ${v(columns[0]!)} COLLATE "C", ${columns.slice(1).map(v).join(", ")}`,
    "FROM (VALUES",
    rows.map((row) => `  (${row.values.join(", ")})`).join(",\n"),
    `) AS v (${columns.join(", ")});`,
  ].join("\n")
}

function nameExpression(source: IdentityNameSource): string {
  return "column" in source
    ? `NEW.${quoteIdent(source.column)}::text`
    : `NEW.${quoteIdent(source.json)} ->> ${sqlLiteral(source.key)}`
}

function plpgsqlFunction(
  signature: string,
  returns: string,
  volatility: "STABLE" | undefined,
  body: readonly string[]
): string {
  const text = body.join("\n")
  const tag = dollarTag(text)
  return (
    `CREATE OR REPLACE FUNCTION ${signature}\n` +
    `RETURNS ${returns}\n` +
    `LANGUAGE plpgsql${volatility === undefined ? "" : ` ${volatility}`} SECURITY DEFINER\n` +
    `SET search_path = ''\n` +
    `AS ${tag}\n${text}\n${tag};`
  )
}

function qualified(name: QualifiedName): string {
  return `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
}
