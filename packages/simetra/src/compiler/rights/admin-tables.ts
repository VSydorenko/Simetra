import {
  KIND_REGISTRY,
  PLATFORM_SCHEMA,
  makeObjectName,
  type PhysicalColumn,
  type PhysicalIndexKey,
  type PhysicalOrigin,
  type PhysicalTable,
} from "simetra/model"
import { compareStrings } from "../diagnostics"
import type { QualifiedName } from "../contracts"
import type { ParsedObject } from "../stages/files"
import type { MineInputs } from "./functions"

/**
 * Колонки входів `rights_mine` — виходи вхідних CTE `mineBody` (Р3-15): одне
 * місце для таблиць знімка, їхнього заповнення й читання гілкою знімка.
 */
export const INPUT_COLUMNS = {
  typed: [
    ["storage", "text"],
    ["storage_id", "uuid"],
    ["scope_kind_id", "uuid"],
    ["scope", "uuid"],
    ["container", "uuid"],
    ["custom_role", "uuid"],
    ["archetype", "uuid"],
    ["level", "text"],
    ["level_id", "uuid"],
  ],
  containers: [
    ["level_id", "uuid"],
    ["container", "uuid"],
    ["scope_kind_id", "uuid"],
    ["scope", "uuid"],
  ],
  deltas: [
    ["storage", "text"],
    ["storage_id", "uuid"],
    ["custom_role", "uuid"],
    ["scope_key", "uuid"],
    ["effect", "text"],
    ["object", "text"],
    ["action", "text"],
    ["extent", "text"],
    ["dimension_id", "uuid"],
  ],
} as const satisfies Record<keyof MineInputs, readonly [string, string][]>

/** Таблиця маркера кореня (спека П4 §6.13, Р-A6-7). */
export const ROOT_MARKER_TABLE = {
  schema: PLATFORM_SCHEMA,
  name: "rights_tx_root_marker",
} as const satisfies QualifiedName

/** Походження рядка входу й причина журналу функції гранту (Р-A6-5). */
export const ROOT_CREATOR_REASON = "root-creator"

/**
 * Стан механізму прав належить платформі, а не довіднику застосунку:
 * без FK журнал переживає видалення скоупу, без грантів API його не читає.
 * Походження детерміноване за файлом, як у решти похідних таблиць.
 */
export function rightsAdminTables(
  objects: readonly ParsedObject[]
): PhysicalTable[] {
  if (!objects.some((o) => KIND_REGISTRY[o.kind].rightsDeclaration === "role"))
    return []
  const owner = objects
    .filter(
      (o) => KIND_REGISTRY[o.kind].rightsSystem?.(o.data) === "roleAssignments"
    )
    .sort((a, b) => compareStrings(a.file, b.file))[0]
  if (owner === undefined) return []
  const column = (
    name: string,
    type: string,
    notNull = true,
    extra: Partial<PhysicalColumn> = {}
  ): PhysicalColumn => ({ name, type, notNull, origin: {}, ...extra })
  const table = (
    name: string,
    part: PhysicalOrigin["part"],
    columns: PhysicalColumn[],
    key?: string[],
    indexes: (
      PhysicalIndexKey[] | { keys: PhysicalIndexKey[]; where: string }
    )[] = []
  ): PhysicalTable => ({
    schema: PLATFORM_SCHEMA,
    name,
    origin: { objectId: owner.id!, part },
    rowLevelSecurity: "off",
    columns,
    ...(key === undefined
      ? {}
      : {
          primaryKey: {
            name: makeObjectName(name, undefined, "pkey"),
            columns: key,
          },
        }),
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: indexes.map((index) => {
      const { keys, where } = Array.isArray(index)
        ? { keys: index, where: undefined }
        : index
      return {
        name: makeObjectName(
          name,
          keys.map((k) => ("column" in k ? k.column : "")).join("_"),
          "idx"
        ),
        unique: false,
        method: "btree",
        keys,
        include: [],
        ...(where === undefined ? {} : { where }),
        nullsNotDistinct: false,
      }
    }),
  })
  const inputColumns = (
    input: keyof typeof INPUT_COLUMNS
  ): PhysicalColumn[] => [
    column("xid", "bigint"),
    ...INPUT_COLUMNS[input].map(([name, type]) => column(name, type, false)),
  ]
  const asc = (...columns: string[]): PhysicalIndexKey[] =>
    columns.map((column) => ({ column }))
  const desc = (column: string): PhysicalIndexKey => ({
    column,
    order: "desc",
  })
  return [
    table(
      "rights_versions",
      "rightsVersions",
      [
        column("scope_kind_id", "uuid"),
        column("scope", "uuid"),
        column("version", "bigint", true, { default: "0" }),
      ],
      ["scope_kind_id", "scope"]
    ),
    table(
      "rights_journal",
      "rightsJournal",
      [
        column("id", "uuid", true, { default: "gen_random_uuid()" }),
        column("seq", "bigint", true, {
          identity: {
            generation: "always",
            sequence: "rights_journal_seq_seq",
          },
        }),
        column("xid", "bigint"),
        column("at", "timestamp with time zone", true, { default: "now()" }),
        column("scope_kind_id", "uuid"),
        column("scope", "uuid"),
        column("actor", "uuid", false),
        column("reason", "text"),
        column("action", "text", false),
        column("object", "text"),
        column("relation", "text"),
        column("operation", "text"),
        column("row_id", "uuid"),
        column("parent_id", "uuid", false),
        column("before", "jsonb", false),
        column("after", "jsonb", false),
      ],
      ["id"],
      [
        // Перший образ рядка в транзакції.
        asc("xid", "relation", "row_id", "seq"),
        // Журнал скоупу новіші першими (`rights_journal_of`) — без
        // повного перебору з сортуванням.
        [...asc("scope_kind_id", "scope"), desc("at"), desc("seq")],
      ]
    ),
    // Знімок фактів актора (спека прав §7): заголовок факту окремо від рядків,
    // бо серед рядків прав його шукали б перебором.
    table(
      "rights_tx_header",
      "rightsTxHeader",
      [
        column("xid", "bigint"),
        column("fact", "text"),
        column("actor", "uuid", false),
      ],
      ["xid", "fact"]
    ),
    // Входи факту `rights` (Р3-15) — рядки вхідних CTE `rights_mine`, а не її
    // вихід: вихід множить скоупи на проєкцію ролі, а входи ∝ призначенням і
    // дельтам актора. Індекси — ключі з'єднань `held` і гілки `allow`.
    // `provenance` і `assignment` — лише в DDL, не в `INPUT_COLUMNS` (Р-A6-5):
    // їх пише функція гранту творцю кореня, а знімок і читання входів їх не
    // бачать. Частковий індекс — для `EXISTS` причини журналу призначень: без
    // нього кожен рядок журналу перебирав би всі рядки `typed` актора.
    table(
      "rights_tx_typed",
      "rightsTxTyped",
      [
        ...inputColumns("typed"),
        column("provenance", "text", false),
        column("assignment", "uuid", false),
      ],
      undefined,
      [
        asc("xid"),
        { keys: asc("xid", "assignment"), where: "provenance IS NOT NULL" },
      ]
    ),
    table(
      "rights_tx_containers",
      "rightsTxContainers",
      inputColumns("containers"),
      undefined,
      [asc("xid", "level_id", "container")]
    ),
    table(
      "rights_tx_deltas",
      "rightsTxDeltas",
      inputColumns("deltas"),
      undefined,
      [asc("xid", "storage", "custom_role", "scope_key")]
    ),
    table(
      "rights_tx_holders",
      "rightsTxHolders",
      [
        column("xid", "bigint"),
        column("level", "text", false),
        column("level_id", "uuid", false),
        column("scope", "uuid", false),
      ],
      undefined,
      [asc("xid")]
    ),
    // Кеш прав початку на COMMIT (Р3-15): одна повна оцінка над входами на
    // транзакцію, а не на кожну перевірку черги. Рядок-маркер без рівня
    // відрізняє «закешовано порожні права» від «ще не рахували». Індекс —
    // ключі покриття ескалації за рівнем (`escalationSql`); окремий індекс
    // `(xid)` зайвий: читання лише за транзакцією бере префікс цього.
    table(
      "rights_tx_start",
      "rightsTxStart",
      [
        column("xid", "bigint"),
        column("level", "text", false),
        column("level_id", "uuid", false),
        column("scope", "uuid", false),
        column("container", "uuid", false),
        column("object", "text", false),
        column("action", "text", false),
        column("extent", "text", false),
        column("dimension_id", "uuid", false),
        column("full_access", "boolean"),
      ],
      undefined,
      [asc("xid", "level", "level_id", "scope")]
    ),
    // `catalog` — рядок довідника членства: функції членства виду читають
    // лише такі. Індекс зі `scope` — для точкового `_my_member(p_scope)`.
    table(
      "rights_tx_scopes",
      "rightsTxScopes",
      [
        column("xid", "bigint"),
        column("scope_kind_id", "uuid"),
        column("scope", "uuid"),
        column("member", "uuid"),
        column("catalog", "boolean"),
      ],
      undefined,
      [asc("xid", "scope_kind_id", "scope")]
    ),
    // `value` — `NULL`, коли його дала дослівна функція виміру: факт —
    // рівно вихід живого варіанта.
    table(
      "rights_tx_values",
      "rightsTxValues",
      [
        column("xid", "bigint"),
        column("dimension_id", "uuid"),
        column("value", "uuid", false),
      ],
      undefined,
      [asc("xid", "dimension_id")]
    ),
    table(
      "rights_tx_scope_sets",
      "rightsTxScopeSets",
      [
        column("xid", "bigint"),
        column("scope_kind_id", "uuid"),
        column("scope", "uuid", false),
      ],
      undefined,
      [asc("xid", "scope_kind_id")]
    ),
    table(
      "rights_tx_pending",
      "rightsTxPending",
      [
        column("xid", "bigint"),
        column("kind", "text"),
        column("key", "uuid"),
        column("scope_kind_id", "uuid"),
        column("scope", "uuid", false),
        column("maintenance", "boolean"),
      ],
      ["xid", "kind", "scope_kind_id", "key"]
    ),
    // Маркер кореня (спека П4 §6.13): вставку кореня виду з `rootCreator`
    // мусить спожити функція гранту в тій самій транзакції, інакше відкладена
    // перевірка відмовляє — корінь без творця не з'являється (fail-closed).
    // Актор — той, чиє право `create` судила вставка (Р-A6-23).
    table(
      ROOT_MARKER_TABLE.name,
      "rightsTxRootMarker",
      [
        column("xid", "bigint"),
        column("scope_kind_id", "uuid"),
        column("root", "uuid"),
        column("actor", "uuid"),
      ],
      ["xid", "scope_kind_id", "root"]
    ),
  ]
}
