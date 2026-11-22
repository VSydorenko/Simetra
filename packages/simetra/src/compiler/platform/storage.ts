import {
  COMMAND_CORE_ERRORS,
  PLATFORM_ROLES,
  PLATFORM_SCHEMA,
  PROVIDER_API_ROLES,
  STORAGE_ERRORS,
  STORAGE_FUNCTIONS,
  STORAGE_TABLES,
  ZERO_UUID,
  filePlatformColumns,
  quoteIdent,
  type DatabaseProvider,
  type ObjectTable,
  type PhysicalSnapshot,
} from "simetra/model"
import { tenantBoundary } from "../access-units"
import { bodyRequires } from "../catalog-command/units"
import {
  mainTableOf,
  qualified,
  type AccessContract,
  type Contracts,
  type QualifiedName,
  type RightsContract,
} from "../contracts"
import { compareStrings } from "../diagnostics"
import { dollarTag } from "../movement-functions"
import { hasRightsFunctions, uuidLiteral } from "../rights/functions"
import { definerTrigger } from "../rights/definer"
import {
  renderCondition,
  rowFreeGrants,
  type RightsCondition,
} from "../rights/predicates"
import { executeGrants } from "../sql/execute-grants"
import type { SqlParser } from "../sql/parse"
import type { PlpgsqlParser } from "../sql/plpgsql"
import { generatedUnit, type SqlUnit } from "../sql/units"
import type { ParsedObject } from "../stages/files"
import { sqlLiteral } from "../stages/model"
import { storageOf } from "./storage-tables"
import { storageTriggerFunctions, storageTriggerNames } from "./storage-names"

const fn = (name: string): QualifiedName => ({
  schema: PLATFORM_SCHEMA,
  name,
})
const ATTACH = fn(STORAGE_FUNCTIONS.attach)
const HEADROOM = fn(STORAGE_FUNCTIONS.headroom)
const ROWS_EXIST = fn(STORAGE_FUNCTIONS.rowsExist)
const ROW_PAGE = fn(STORAGE_FUNCTIONS.rowPage)
const PENDING_LEFT = fn(STORAGE_FUNCTIONS.pendingLeft)
const PENDING_SWEEP = fn(STORAGE_FUNCTIONS.pendingSweep)
const INSTANCE_ID = fn(STORAGE_FUNCTIONS.instanceId)

const USAGE = qualified(STORAGE_TABLES.usage)
const QUOTA = qualified(STORAGE_TABLES.quota)
const PENDING = qualified(STORAGE_TABLES.pending)
const INSTANCE = qualified(STORAGE_TABLES.instance)

/** Скільки рядків віддає одна сторінка `storage_row_page` і одна перевірка `storage_rows_exist`. */
const PAGE_SIZE = 1000

const FORBIDDEN = COMMAND_CORE_ERRORS.forbidden

/** Об'єкт зі `storage` і його факти для гілок функцій. */
interface StorageObject {
  objectId: string
  table: ObjectTable
  maxBytes: number
  mediaTypes: readonly string[]
  /** Колонка єдиного ключа UUID основної таблиці. */
  keyColumn: string
  /** Колонка скоупу й вид скоупу; нескоуплений — немає (облік під `ZERO_UUID`). */
  scope?: NonNullable<AccessContract["scope"]>
  rights?: RightsContract
}

export interface StorageInput {
  objects: readonly ParsedObject[]
  contracts: Pick<
    Contracts,
    "access" | "membership" | "rights" | "roles" | "users" | "membershipSources"
  >
  physical: PhysicalSnapshot
  provider: DatabaseProvider
  module: string
  /** Одиниці інших генераторів: функції, які кличе тіло, — ребра `requires`. */
  units: readonly Pick<SqlUnit, "class" | "identity">[]
  parse: SqlParser
  plpgsql: PlpgsqlParser
}

function storageObjects(input: StorageInput): StorageObject[] {
  const { contracts, physical } = input
  const rightsById = new Map(contracts.rights.map((r) => [r.objectId, r]))
  return input.objects
    .flatMap((object): StorageObject[] => {
      const storage = storageOf(object)
      const id = object.id
      if (storage === undefined || id === undefined) return []
      const main = mainTableOf(physical, id)
      const key = main?.primaryKey?.columns
      if (main === undefined || key?.length !== 1) {
        throw new Error(
          `internal: the storage object ${object.name} needs a main table with a single-column key`
        )
      }
      const access = contracts.access.find(
        (a) => a.table.schema === main.schema && a.table.name === main.name
      )
      const rights = rightsById.get(id)
      return [
        {
          objectId: id,
          table: main,
          maxBytes: storage.maxBytes,
          mediaTypes: storage.mediaTypes,
          keyColumn: key[0]!,
          ...(access?.scope === undefined ? {} : { scope: access.scope }),
          ...(rights === undefined ? {} : { rights }),
        },
      ]
    })
    .sort((a, b) => compareStrings(a.objectId, b.objectId))
}

/** Відмова сховища (Р11): закритий перелік `STORAGE_ERRORS`, причина — у `DETAIL`. */
const rejection = (detail: string) =>
  `RAISE EXCEPTION USING ERRCODE = '${STORAGE_ERRORS.errcode}', MESSAGE = '${STORAGE_ERRORS.message}', DETAIL = '${detail}';`

/** Помилка службових викликів звірки: аргумент, а не відмова сховища. */
const badArgument = (detail: string) =>
  `RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'storage.invalid-argument', DETAIL = '${detail}';`

/** Гілки `IF p_object = … THEN … ELSE <відмова> END IF` за об'єктами. */
function dispatch(
  objects: readonly StorageObject[],
  branch: (object: StorageObject) => string[],
  otherwise: string
): string[] {
  return [
    ...objects.flatMap((object, i) => [
      `${i === 0 ? "IF" : "ELSIF"} p_object = ${uuidLiteral(object.objectId)} THEN`,
      ...branch(object).map((line) => `  ${line}`),
    ]),
    "ELSE",
    `  ${otherwise}`,
    "END IF;",
  ]
}

/** Умова права без рядка над `p_scope` (Р3): колонка скоупу — параметр функції. */
function grantOverParameter(condition: RightsCondition): string {
  return condition.kind === "column"
    ? renderCondition({ ...condition, column: "p_scope" })
    : renderCondition(condition)
}

/**
 * Умова `storage_headroom` для об'єкта (Р3): право `create` без рядка — ті
 * самі будівники, що й політики вставки (`rowFreeGrants`, `tenantBoundary`), без
 * другої копії правила, — і запас обсягу під межею скоупу. Без функцій прав чи
 * дії `create` довести право нічим — `false`.
 */
function headroomCondition(object: StorageObject, rightsOn: boolean): string {
  const grants =
    rightsOn && object.rights !== undefined
      ? object.rights.actions.some((a) => a.action === "create")
        ? rowFreeGrants(object.rights, "create", object.table)
        : []
      : []
  if (grants.length === 0) return "false"
  const kind =
    object.scope === undefined
      ? uuidLiteral(ZERO_UUID)
      : uuidLiteral(object.scope.scopeKindId)
  const scope = object.scope === undefined ? uuidLiteral(ZERO_UUID) : "p_scope"
  return [
    ...(object.scope === undefined
      ? []
      : [tenantBoundary({ ...object.scope, carrier: "p_scope" })]),
    `(${grants.map(grantOverParameter).join(" OR ")})`,
    // Файл `maxBytes` має вміститися: понад межу рядок відмовив би на
    // `INSERT`, але тоді байти вже в бакеті
    `NOT EXISTS (SELECT 1 FROM ${QUOTA} q WHERE q.scope_kind = ${kind} AND q.scope = ${scope} AND COALESCE((SELECT u.bytes FROM ${USAGE} u WHERE u.scope_kind = q.scope_kind AND u.scope = q.scope), 0) + ${object.maxBytes} > q.max_bytes)`,
  ].join(" AND ")
}

/**
 * Генератор `storage` (спека профілю postgres §8): функції сховища, їхні
 * гранти, тригери на таблицях видів зі `storage` і відкликання грантів на
 * таблиці. Одиниці існують, лише коли є об'єкт зі `storage`. Безумовна
 * таблиця `storage_instance` (Р12) — стан застосування (`renderApplyState`),
 * тож тут її немає; функція `storage_instance_id` її лише читає.
 *
 * Усі функції — `SECURITY DEFINER` з порожнім `search_path`: таблиць сховища
 * ролі запиту й команд не бачать. `EXECUTE` лише ролі `simetra_files`
 * (`file_attach`, `storage_rows_exist`, `storage_row_page`,
 * `storage_pending_left`, `storage_pending_sweep`, `storage_instance_id`), крім `storage_headroom` —
 * його кличе роль запиту користувача. Роль `simetra_files` — не призначення
 * гранту, тож явний `GRANT` після `executeGrants(…, [])` дає цей генератор, а
 * декларація застосунку її не адресує. Об'єкт без скоупу веде облік під
 * нульовими UUID виду й скоупу (§8.3).
 */
export function buildStorageUnits(input: StorageInput): SqlUnit[] {
  const { provider, contracts } = input
  const objects = storageObjects(input)
  const files = quoteIdent(PLATFORM_ROLES.files)
  const apiRoles = Object.values(PROVIDER_API_ROLES[provider]).filter(
    (role): role is string => typeof role === "string"
  )
  const unit = (
    sql: string,
    schema: string = PLATFORM_SCHEMA,
    extra: Pick<SqlUnit, "requires" | "ownerObjectId"> = {}
  ): SqlUnit => ({
    ...generatedUnit(sql, schema, input.parse),
    module: input.module,
    generator: "storage",
    ...extra,
  })
  const revokes = (name: QualifiedName) => {
    const target = `TABLE ${qualified(name)}`
    return [
      `REVOKE ALL ON ${target} FROM PUBLIC;`,
      ...apiRoles.map(
        (role) => `REVOKE ALL ON ${target} FROM ${quoteIdent(role)};`
      ),
    ].map((sql) => unit(sql))
  }
  if (objects.length === 0) {
    return []
  }
  const rightsOn = hasRightsFunctions(contracts, provider)

  const functionSql = (
    name: QualifiedName,
    params: string,
    returns: string,
    body: readonly string[],
    options: { stable?: true; rowSecurityOff?: true } = {}
  ) => {
    const text = body.join("\n")
    const tag = dollarTag(text)
    return (
      `CREATE OR REPLACE FUNCTION ${qualified(name)}(${params})\n` +
      `RETURNS ${returns}\n` +
      `LANGUAGE plpgsql ${options.stable === true ? "STABLE" : "VOLATILE"} SECURITY DEFINER\n` +
      `SET search_path = ''\n` +
      (options.rowSecurityOff === true ? "SET row_security = off\n" : "") +
      `AS ${tag}\n${text}\n${tag};`
    )
  }
  /** Функція з грантами: `types` — як у `ON FUNCTION`; `user` — роль запиту, інакше лише `simetra_files`. */
  const shared = (
    name: QualifiedName,
    types: string,
    sql: string,
    grantee: "user" | "files"
  ): SqlUnit[] => {
    const signature = `${qualified(name)}(${types})`
    return [
      unit(sql, PLATFORM_SCHEMA, { requires: bodyRequires(sql, input) }),
      ...executeGrants(
        signature,
        grantee === "user" ? ["user"] : [],
        provider
      ).map((grant) => unit(grant)),
      ...(grantee === "files"
        ? [unit(`GRANT EXECUTE ON FUNCTION ${signature} TO ${files};`)]
        : []),
    ]
  }
  const mainTable = (o: StorageObject) => qualified(o.table)
  const key = (o: StorageObject) => `t.${quoteIdent(o.keyColumn)}`

  const attach = functionSql(
    ATTACH,
    "p_object uuid, p_id uuid, p_size bigint, p_type text",
    "void",
    [
      "DECLARE",
      "  v_max bigint;",
      "  v_types text[];",
      "BEGIN",
      ...dispatch(
        objects,
        (o) => [
          `v_max := ${o.maxBytes};`,
          `v_types := ARRAY[${o.mediaTypes.map(sqlLiteral).join(", ")}];`,
        ],
        // Об'єкт без `storage` (чи `NULL`) — та сама відмова, що й решта
        rejection(STORAGE_ERRORS.attachInvalid)
      ),
      "IF p_id IS NULL OR p_size IS NULL OR p_size < 0 THEN",
      `  ${rejection(STORAGE_ERRORS.attachInvalid)}`,
      "END IF;",
      "IF p_size > v_max THEN",
      `  ${rejection(STORAGE_ERRORS.attachInvalid)}`,
      "END IF;",
      "IF p_type IS NULL OR NOT (p_type = ANY (v_types)) THEN",
      `  ${rejection(STORAGE_ERRORS.attachInvalid)}`,
      "END IF;",
      // Повтор для того самого id в транзакції — відмова, а не друга вставка
      `  INSERT INTO ${PENDING} (xact, object, id, size, content_type)`,
      "  VALUES (pg_catalog.pg_current_xact_id(), p_object, p_id, p_size, p_type)",
      "  ON CONFLICT DO NOTHING;",
      "IF NOT FOUND THEN",
      `  ${rejection(STORAGE_ERRORS.attachInvalid)}`,
      "END IF;",
      "END",
    ].map((line) => line.trimEnd())
  )

  const headroom = functionSql(
    HEADROOM,
    "p_object uuid, p_scope uuid",
    "boolean",
    [
      "BEGIN",
      ...objects.flatMap((o) => [
        `  IF p_object = ${uuidLiteral(o.objectId)} THEN`,
        `    RETURN COALESCE(${headroomCondition(o, rightsOn)}, false);`,
        "  END IF;",
      ]),
      "  RETURN false;",
      "END",
    ],
    { stable: true }
  )

  const rowsExist = functionSql(
    ROWS_EXIST,
    "p_object uuid, p_ids uuid[]",
    "SETOF uuid",
    [
      "BEGIN",
      ...dispatch(
        objects,
        (o) => [
          `IF COALESCE(pg_catalog.cardinality(p_ids), 0) > ${PAGE_SIZE} THEN`,
          `  ${badArgument("p_ids")}`,
          "END IF;",
          `RETURN QUERY SELECT ${key(o)} FROM ${mainTable(o)} t WHERE ${key(o)} = ANY (p_ids);`,
        ],
        badArgument("p_object")
      ),
      "RETURN;",
      "END",
    ],
    // Запит — повз RLS власника: рядки інших тенантів не «сироти». Без
    // обходу RLS функція відмовила б голосно, а не віддала б підмножину
    { stable: true, rowSecurityOff: true }
  )

  const rowPage = functionSql(
    ROW_PAGE,
    "p_object uuid, p_after uuid",
    "SETOF uuid",
    [
      "BEGIN",
      ...dispatch(
        objects,
        (o) => [
          `RETURN QUERY SELECT ${key(o)} FROM ${mainTable(o)} t WHERE p_after IS NULL OR ${key(o)} > p_after ORDER BY ${key(o)} LIMIT ${PAGE_SIZE};`,
        ],
        badArgument("p_object")
      ),
      "RETURN;",
      "END",
    ],
    { stable: true, rowSecurityOff: true }
  )

  const pendingLeft = functionSql(
    PENDING_LEFT,
    "",
    "boolean",
    [
      "BEGIN",
      `  RETURN EXISTS (SELECT 1 FROM ${PENDING} p WHERE p.xact = pg_catalog.pg_current_xact_id());`,
      "END",
    ],
    { stable: true }
  )

  // Записи інших транзакцій: `xact` менший за `xmin` знімка — транзакція
  // завершена, її запис ніхто вже не забере (крок 4 §8.2)
  const pendingSweep = functionSql(PENDING_SWEEP, "", "bigint", [
    "DECLARE",
    "  v_swept bigint;",
    "BEGIN",
    `  DELETE FROM ${PENDING} p WHERE p.xact < pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot());`,
    "  GET DIAGNOSTICS v_swept = ROW_COUNT;",
    "  RETURN v_swept;",
    "END",
  ])

  // Лише читає: єдиний рядок прив'язки вставляє стан застосування, тож
  // функція працює в `READ ONLY` транзакції `checkUpload`. Відбиток = uuid +
  // `system_identifier` + oid бази + timeline: dump/restore і TEMPLATE дають
  // інший sysid чи oid, PITR і підвищена репліка — інший timeline, тож копія
  // бази не пройде за оригінал (спека §8.2). Timeline береться з поточного
  // WAL-файла (перші 8 hex-знаків), а не з контрольної точки: після
  // `pg_promote()` контрольної точки ще може не бути. На репліці
  // `pg_walfile_name` кидає помилку — це відмова, а не діра. `pg_control_system`
  // виконується для PUBLIC (його немає в `system_functions.sql`)
  const instanceId = functionSql(INSTANCE_ID, "", "text", [
    "BEGIN",
    `  RETURN (SELECT i.id::text FROM ${INSTANCE} i)`,
    "    || ':' || (SELECT s.system_identifier::text FROM pg_catalog.pg_control_system() s)",
    "    || ':' || (SELECT d.oid::text FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())",
    "    || ':' || pg_catalog.substr(pg_catalog.pg_walfile_name(pg_catalog.pg_current_wal_lsn()), 1, 8);",
    "END",
  ])

  const perObject = objects.flatMap((o) => {
    const names = storageTriggerNames(o.table)
    const fns = storageTriggerFunctions(o.table)
    const owned = (sql: string, requires?: SqlUnit["requires"]): SqlUnit =>
      unit(sql, o.table.schema, {
        ownerObjectId: o.objectId,
        ...(requires === undefined ? {} : { requires }),
      })
    const [sizeColumn, typeColumn] = filePlatformColumns().map(
      (def) => def.physicalName
    ) as [string, string]
    const scopeOf = (row: "NEW" | "OLD") =>
      o.scope === undefined
        ? uuidLiteral(ZERO_UUID)
        : `${row}.${quoteIdent(o.scope.carrier)}`
    const kind =
      o.scope === undefined
        ? uuidLiteral(ZERO_UUID)
        : uuidLiteral(o.scope.scopeKindId)
    const tableNode = (name: QualifiedName) =>
      ({ type: "table", ...name }) as const
    const execute = (fnName: QualifiedName) =>
      `FOR EACH ROW EXECUTE FUNCTION ${qualified(fnName)}();`
    const attachBody = [
      "DECLARE",
      "  v_size bigint;",
      "  v_type text;",
      "BEGIN",
      // Розмір і тип ставить лише запис `file_attach` цієї транзакції (Р4):
      // забраний `DELETE … RETURNING`, він не годиться для другого рядка
      `  DELETE FROM ${PENDING} p`,
      `  WHERE p.xact = pg_catalog.pg_current_xact_id() AND p.object = ${uuidLiteral(o.objectId)} AND p.id = NEW.${quoteIdent(o.keyColumn)}`,
      "  RETURNING p.size, p.content_type INTO v_size, v_type;",
      "  IF NOT FOUND THEN",
      `    ${rejection(STORAGE_ERRORS.attachMissing)}`,
      "  END IF;",
      `  NEW.${quoteIdent(sizeColumn)} := v_size;`,
      `  NEW.${quoteIdent(typeColumn)} := v_type;`,
      "  RETURN NEW;",
      "END",
    ].join("\n")
    const immutableBody = [
      "BEGIN",
      `  RAISE EXCEPTION USING ERRCODE = '${FORBIDDEN.errcode}', MESSAGE = '${FORBIDDEN.message}', DETAIL = '${FORBIDDEN.effect}', TABLE = TG_TABLE_NAME;`,
      "  RETURN NULL;",
      "END",
    ].join("\n")
    const usageBody = [
      "DECLARE",
      "  v_bytes bigint;",
      "  v_max bigint;",
      "BEGIN",
      "  IF TG_OP = 'INSERT' THEN",
      // Один upsert серіалізує завантаження скоупу: два паралельні біля
      // межі не прочитають однакову суму
      `    INSERT INTO ${USAGE} AS u (scope_kind, scope, bytes)`,
      `    VALUES (${kind}, ${scopeOf("NEW")}, COALESCE(NEW.${quoteIdent(sizeColumn)}, 0))`,
      "    ON CONFLICT (scope_kind, scope) DO UPDATE SET bytes = u.bytes + EXCLUDED.bytes",
      "    RETURNING u.bytes INTO v_bytes;",
      `    SELECT q.max_bytes INTO v_max FROM ${QUOTA} q WHERE q.scope_kind = ${kind} AND q.scope = ${scopeOf("NEW")};`,
      "    IF FOUND AND v_bytes > v_max THEN",
      `      ${rejection(STORAGE_ERRORS.quotaExceeded)}`,
      "    END IF;",
      "    RETURN NEW;",
      "  END IF;",
      `  UPDATE ${USAGE} u SET bytes = u.bytes - COALESCE(OLD.${quoteIdent(sizeColumn)}, 0)`,
      `  WHERE u.scope_kind = ${kind} AND u.scope = ${scopeOf("OLD")};`,
      "  RETURN OLD;",
      "END",
    ].join("\n")
    return [
      owned(definerTrigger(fns.attach, attachBody), [
        tableNode(STORAGE_TABLES.pending),
      ]),
      owned(definerTrigger(fns.immutable, immutableBody)),
      owned(definerTrigger(fns.usage, usageBody), [
        tableNode(STORAGE_TABLES.usage),
        tableNode(STORAGE_TABLES.quota),
      ]),
      // Тригер спрацьовує без права виконання (платформна спека §6.7), тож
      // `EXECUTE` функцій тригерів не має ніхто
      ...[fns.attach, fns.immutable, fns.usage].flatMap((name) =>
        executeGrants(`${qualified(name)}()`, [], provider).map((g) => owned(g))
      ),
      owned(
        `CREATE TRIGGER ${quoteIdent(names.attach)} BEFORE INSERT ON ${qualified(o.table)} ${execute(fns.attach)}`
      ),
      owned(
        `CREATE TRIGGER ${quoteIdent(names.immutable)} BEFORE UPDATE OF ${quoteIdent(sizeColumn)}, ${quoteIdent(typeColumn)} ON ${qualified(o.table)} ${execute(fns.immutable)}`
      ),
      owned(
        `CREATE TRIGGER ${quoteIdent(names.usage)} AFTER INSERT OR DELETE ON ${qualified(o.table)} ${execute(fns.usage)}`
      ),
    ]
  })

  const units: SqlUnit[] = [
    ...shared(ATTACH, "uuid, uuid, bigint, text", attach, "files"),
    ...shared(HEADROOM, "uuid, uuid", headroom, "user"),
    ...shared(ROWS_EXIST, "uuid, uuid[]", rowsExist, "files"),
    ...shared(ROW_PAGE, "uuid, uuid", rowPage, "files"),
    ...shared(PENDING_LEFT, "", pendingLeft, "files"),
    ...shared(PENDING_SWEEP, "", pendingSweep, "files"),
    ...shared(INSTANCE_ID, "", instanceId, "files"),
    unit(`GRANT USAGE ON SCHEMA ${quoteIdent(PLATFORM_SCHEMA)} TO ${files};`),
    ...[
      STORAGE_TABLES.usage,
      STORAGE_TABLES.quota,
      STORAGE_TABLES.pending,
    ].flatMap(revokes),
    ...perObject,
  ]
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}
