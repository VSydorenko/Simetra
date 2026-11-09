import {
  runtimeObjectSchema,
  type Filter,
  type RuntimeAttribute,
  type RuntimeObject,
} from "simetra/model"

/**
 * Фікстура обчислювача фільтра T4: об'єкт з усіма логічними типами й
 * справжніми `pgType`/`castType` (як їх дає компілятор), і рядки кейсів
 * інваріанта 16. Одна на юніт-тест обчислювача й DB-тест еквівалентності
 * будівнику T3: рядки тут — логічна форма, яку декодер дає з бази.
 */

const attr = (
  name: string,
  type: RuntimeAttribute["type"],
  pgType: string,
  castType: string,
  extra: Partial<RuntimeAttribute> = {}
): RuntimeAttribute => ({
  name,
  column: `${name}_col`,
  pgType,
  castType,
  type,
  required: false,
  insert: true,
  update: true,
  ...extra,
})

export const PROJECT = "Catalog.Project"
export const REGION = "Catalog.Region"

/** Таблиця фікстури: тимчасова, тож живе лише в транзакції DB-тесту. */
export const FILTER_TABLE = { schema: "pg_temp", name: "filter_rows" }

export const filterObject: RuntimeObject = runtimeObjectSchema.parse({
  id: "00000000-0000-4000-8000-000000000201",
  name: "Sample",
  kind: "Catalog",
  kindLabel: "sample",
  table: FILTER_TABLE,
  key: "id",
  keyName: "ref",
  versionColumn: "version",
  versionName: "version",
  kernelHash: "0".repeat(64),
  signal: false,
  attributes: [
    attr("name", "String", "character varying(20)", "character varying", {
      maxLength: 20,
    }),
    attr("note", "Text", "text", "text"),
    attr("owner", "UUID", "uuid", "uuid"),
    attr("count", "Integer", "integer", "integer"),
    attr("small", "SmallInt", "smallint", "smallint"),
    attr("big", "BigInt", "bigint", "bigint"),
    attr("amount", "Numeric", "numeric(12,2)", "numeric", {
      precision: 12,
      scale: 2,
    }),
    attr("flag", "Boolean", "boolean", "boolean"),
    attr("day", "Date", "date", "date"),
    attr(
      "at",
      "DateTime",
      "timestamp with time zone",
      "timestamp with time zone"
    ),
    attr("blob", "Bytes", "bytea", "bytea"),
    // Порядок імен і міток протилежний: `lt` за міткою відрізняється від `lt`
    // за ім'ям.
    attr("status", "Ref", "text", "text", {
      enumValues: [
        { name: "Alpha", label: "zeta" },
        { name: "Mid", label: "mid" },
        { name: "Zulu", label: "alpha" },
      ],
    }),
    attr("subject", "Ref", "uuid", "uuid", {
      pair: {
        typeColumn: "subject_type",
        targets: [
          { object: { kind: "Catalog", name: "Project" }, label: "project" },
          { object: { kind: "Catalog", name: "Region" }, label: "region" },
        ],
      },
    }),
    attr("link", "Ref", "uuid", "uuid"),
    attr("tags", "Integer", "integer[]", "integer[]", { array: true }),
    attr("payload", "Json", "jsonb", "jsonb"),
    attr("memo", "Text", "text", "text", { load: "lazy" }),
  ],
  tabularSections: [],
  constraints: [],
})

/** DDL таблиці фікстури: колонки — ті самі типи, що в каталозі. */
export const FILTER_TABLE_DDL = `CREATE TEMP TABLE filter_rows (
  id uuid PRIMARY KEY,
  version bigint NOT NULL,
  name_col character varying(20),
  note_col text,
  owner_col uuid,
  count_col integer,
  small_col smallint,
  big_col bigint,
  amount_col numeric(12,2),
  flag_col boolean,
  day_col date,
  at_col timestamp with time zone,
  blob_col bytea,
  status_col text CHECK (status_col IN ('zeta', 'mid', 'alpha')),
  subject_type text,
  subject_col uuid,
  link_col uuid,
  tags_col integer[],
  payload_col jsonb,
  memo_col text
) ON COMMIT DROP`

/** Ключ рядка фікстури за номером. */
export const key = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

export const U1 = "aaaaaaaa-0000-4000-8000-000000000001"
export const U2 = "bbbbbbbb-0000-4000-8000-000000000002"

/** Рядок фікстури: ключ, версія й лише названі поля, решта — `NULL`. */
const fixtureRow = (n: number, values: Record<string, unknown>) => ({
  ref: key(n),
  version: n,
  name: null,
  note: null,
  owner: null,
  count: null,
  small: null,
  big: null,
  amount: null,
  flag: null,
  day: null,
  at: null,
  blob: null,
  status: null,
  subject: null,
  link: null,
  tags: null,
  payload: null,
  memo: null,
  ...values,
})

/**
 * Рядки кейсів інваріанта 16: регістр і діакритика (`é` складене й
 * розкладене — нічия колатора), символи шаблону `%`, `_`, `\`, `NULL` у
 * кожному полі, пара з тим самим id під різними цілями.
 */
export const FILTER_ROWS: Record<string, unknown>[] = [
  fixtureRow(1, {
    name: "abc",
    note: "x%y",
    owner: U1,
    count: 1,
    small: 1,
    big: 9007199254740993n,
    amount: "10.00",
    flag: true,
    day: "2026-01-02",
    at: "2026-01-01T10:00:00.000001Z",
    blob: "\\x00ff",
    status: "Alpha",
    subject: { type: PROJECT, id: U1 },
    link: U1,
    tags: [1, 2],
    payload: { a: 1 },
    memo: "m",
  }),
  fixtureRow(2, {
    name: "ABC",
    note: "x_y",
    owner: U2,
    count: -5,
    small: -1,
    big: -3n,
    amount: "9.00",
    flag: false,
    day: "2025-12-31",
    at: "2026-01-01T10:00:00.000000Z",
    blob: "\\x0a",
    status: "Zulu",
    subject: { type: REGION, id: U1 },
    link: U2,
    tags: [],
  }),
  fixtureRow(3, {
    name: "Abc",
    note: "X\\Y",
    count: 10,
    big: 10n,
    amount: "100.25",
    status: "Mid",
    subject: { type: PROJECT, id: U2 },
  }),
  fixtureRow(4, { name: "abd", note: "résumé", count: 9, amount: "-1.50" }),
  fixtureRow(5, { name: "e", note: "RESUME", amount: "0.00" }),
  fixtureRow(6, { name: "é", note: "Résumé", day: "2026-01-02" }),
  fixtureRow(7, { name: "É" }),
  fixtureRow(8, { name: "é" }),
  fixtureRow(9, { name: "f", count: 1 }),
  fixtureRow(10, { name: "100%" }),
  fixtureRow(11, { name: "a_b" }),
  fixtureRow(12, { name: "a\\b" }),
  fixtureRow(13, { name: "ab", count: 1 }),
  fixtureRow(14, { name: "" }),
  fixtureRow(15, { name: "Été", amount: "10.00" }),
  fixtureRow(16, {}),
]

/** Значення фільтра за реквізитом: з фікстури плюс `%`, `_`, діакритика. */
export const FILTER_VALUES: Record<string, readonly unknown[]> = {
  ref: [key(1), key(8), key(16).toUpperCase()],
  version: [1, 8, 16],
  name: [
    "abc",
    "ABC",
    "a",
    "e",
    "é",
    "é",
    "É",
    "%",
    "_",
    "\\",
    "a_",
    "",
    "Ét",
    "abd",
  ],
  note: ["x", "%", "_", "\\", "résumé", "RÉSUMÉ", "y"],
  owner: [U1, U2.toUpperCase()],
  count: [1, -5, 9, 10],
  small: [1, -1, 0],
  big: ["9007199254740993", "9007199254740992", "-3", "10"],
  amount: ["10", "9", "10.00", "-1.5", "100.25", "0"],
  flag: [true, false],
  day: ["2026-01-02", "2025-12-31"],
  at: [
    "2026-01-01T10:00:00.000001Z",
    "2026-01-01T12:00:00+02:00",
    "2026-01-01T10:00:00Z",
  ],
  blob: ["\\x00FF", "\\x0a"],
  status: ["Alpha", "Mid", "Zulu"],
  subject: [
    { type: PROJECT, id: U1 },
    { type: REGION, id: U1 },
    { type: PROJECT, id: U2.toUpperCase() },
  ],
  link: [U1, U2],
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

/**
 * Кейси інваріанта 16: фільтр і номери рядків фікстури, які він обирає. Юніт-
 * тест звіряє з ними обчислювач, DB-тест — ще й будівник.
 */
export const FILTER_CASES: [name: string, filter: Filter, rows: number[]][] = [
  // Символи шаблону — буквально, регістр зводиться.
  ["contains %", { attribute: "name", op: "contains", value: "%" }, [10]],
  ["contains _", { attribute: "name", op: "contains", value: "_" }, [11]],
  ["contains \\", { attribute: "name", op: "contains", value: "\\" }, [12]],
  ["startsWith a_", { attribute: "name", op: "startsWith", value: "a_" }, [11]],
  [
    "startsWith A, case-insensitive",
    { attribute: "name", op: "startsWith", value: "A" },
    [1, 2, 3, 4, 11, 12, 13],
  ],
  ["Text contains %", { attribute: "note", op: "contains", value: "%" }, [1]],
  [
    "contains with diacritics folds case only",
    { attribute: "note", op: "contains", value: "RÉSUMÉ" },
    [4, 6],
  ],
  // Колатор en-US: малі перед великими, діакритика після основи.
  [
    "gt on mixed case and diacritics",
    { attribute: "name", op: "gt", value: "abc" },
    [2, 3, 4, 5, 6, 7, 8, 9, 15],
  ],
  // `é` складене й розкладене — нічия колатора; її розв'язують байти UTF-8.
  [
    "lt over a collator tie goes by bytes",
    { attribute: "name", op: "lt", value: "é" },
    [1, 2, 3, 4, 5, 8, 10, 11, 12, 13, 14],
  ],
  [
    "gt over a collator tie goes by bytes",
    { attribute: "name", op: "gt", value: "é" },
    [6, 7, 9, 15],
  ],
  ["eq is exact", { attribute: "name", op: "eq", value: "é" }, [6]],
  // Пара: та сама id під іншою ціллю — інший рядок.
  [
    "pair eq",
    { attribute: "subject", op: "eq", value: { type: PROJECT, id: U1 } },
    [1],
  ],
  [
    "pair ne skips NULL",
    { attribute: "subject", op: "ne", value: { type: PROJECT, id: U1 } },
    [2, 3],
  ],
  [
    "pair in",
    {
      attribute: "subject",
      op: "in",
      value: [
        { type: REGION, id: U1 },
        { type: PROJECT, id: U2.toUpperCase() },
      ],
    },
    [2, 3],
  ],
  ["pair isNull", { attribute: "subject", op: "isNull" }, range(4, 16)],
  ["isNull", { attribute: "name", op: "isNull" }, [16]],
  ["array isNull", { attribute: "tags", op: "isNull" }, range(3, 16)],
  // Тризначна логіка: `NULL` не проходить ні умови, ні її заперечення.
  ["ne skips NULL", { attribute: "count", op: "ne", value: 1 }, [2, 3, 4]],
  [
    "not over NULL",
    { not: { attribute: "count", op: "eq", value: 1 } },
    [2, 3, 4],
  ],
  [
    "or of a condition and its negation skips NULL",
    {
      or: [
        { attribute: "count", op: "eq", value: 1 },
        { not: { attribute: "count", op: "eq", value: 1 } },
      ],
    },
    [1, 2, 3, 4, 9, 13],
  ],
  ["not isNull", { not: { attribute: "name", op: "isNull" } }, range(1, 15)],
  // Перерахування: `lt` — за міткою (Zulu → "alpha"), рівність — за ім'ям.
  ["enum lt by label", { attribute: "status", op: "lt", value: "Mid" }, [2]],
  ["enum eq by name", { attribute: "status", op: "eq", value: "Alpha" }, [1]],
  [
    "enum in",
    { attribute: "status", op: "in", value: ["Alpha", "Zulu"] },
    [1, 2],
  ],
  [
    "Numeric gt is numeric",
    { attribute: "amount", op: "gt", value: "9" },
    [1, 3, 15],
  ],
  [
    "Numeric eq ignores scale",
    { attribute: "amount", op: "eq", value: "10" },
    [1, 15],
  ],
  [
    "BigInt past 2^53",
    { attribute: "big", op: "gt", value: "9007199254740992" },
    [1],
  ],
  [
    "DateTime eq across offsets",
    { attribute: "at", op: "eq", value: "2026-01-01T12:00:00+02:00" },
    [2],
  ],
  [
    "DateTime gt by microseconds",
    { attribute: "at", op: "gt", value: "2026-01-01T10:00:00Z" },
    [1],
  ],
  [
    "UUID eq ignores case",
    { attribute: "owner", op: "eq", value: U2.toUpperCase() },
    [2],
  ],
  [
    "Bytes eq ignores hex case",
    { attribute: "blob", op: "eq", value: "\\x00FF" },
    [1],
  ],
  ["Boolean lt", { attribute: "flag", op: "lt", value: true }, [2]],
  [
    "key eq ignores case",
    { attribute: "ref", op: "eq", value: key(16).toUpperCase() },
    [16],
  ],
  ["version gte", { attribute: "version", op: "gte", value: 15 }, [15, 16]],
]

/**
 * Відмови обчислювача: невідоме — `DataError`, решта — та сама
 * `command.invalid`, що в будівника (DB-тест звіряє і її).
 */
export const FILTER_REFUSALS: [name: string, filter: Filter, error: object][] =
  [
    [
      "unknown attribute",
      { attribute: "nope", op: "eq", value: 1 },
      { code: "data.unsupported-predicate" },
    ],
    [
      "unknown operator",
      { attribute: "name", op: "like", value: "a" } as unknown as Filter,
      { code: "data.unsupported-predicate" },
    ],
    [
      "unknown node",
      { xor: [] } as unknown as Filter,
      { code: "data.unsupported-predicate" },
    ],
    [
      "in with null",
      { attribute: "name", op: "in", value: ["a", null] },
      { code: "command.invalid", path: "where.value.1", reason: "use-isNull" },
    ],
    [
      "eq with null",
      { and: [{ attribute: "name", op: "eq", value: null }] },
      {
        code: "command.invalid",
        path: "where.and.0.value",
        reason: "use-isNull",
      },
    ],
    [
      "lt on a pair",
      { attribute: "subject", op: "lt", value: { type: PROJECT, id: U1 } },
      { code: "command.invalid", path: "where.op" },
    ],
    [
      "contains on a number",
      { attribute: "count", op: "contains", value: "1" },
      { code: "command.invalid", path: "where.op" },
    ],
    [
      "lazy attribute",
      { not: { attribute: "memo", op: "isNull" } },
      { code: "command.invalid", path: "where.not.attribute", reason: "lazy" },
    ],
    [
      "value of the wrong type",
      { attribute: "count", op: "eq", value: "1" },
      { code: "command.invalid", path: "where.value" },
    ],
    [
      "value over maxLength",
      { attribute: "name", op: "contains", value: "x".repeat(21) },
      { code: "command.invalid", path: "where.value" },
    ],
  ]
