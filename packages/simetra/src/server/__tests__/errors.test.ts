import {
  COMMAND_CORE_ERRORS,
  runtimeObjectSchema,
  type CommandError,
  type RuntimeCatalog,
  type RuntimeObject,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import { CommandFailure, mapDatabaseError } from "../errors"
import type { DatabaseError } from "../port"
import { sample } from "./fixtures"

// Обмеження каталогу — лише те, що читає мапінг; решта об'єкта — `sample`.
const object: RuntimeObject = runtimeObjectSchema.parse({
  ...sample,
  constraints: [
    { name: "sample_pkey", kind: "primaryKey", columns: ["id"] },
    { name: "sample_code_key", kind: "unique", columns: ["code_col"] },
    { name: "sample_count_check", kind: "check", columns: ["count_col"] },
    { name: "sample_link_fkey", kind: "foreignKey", columns: ["link_col"] },
    {
      name: "sample_subject_key",
      kind: "unique",
      columns: ["subject_type", "subject_col", "note_col"],
    },
  ],
  tabularSections: sample.tabularSections.map((s) => ({
    ...s,
    constraints: [
      { name: "sample_lines_qty_key", kind: "unique", columns: ["qty_col"] },
      {
        name: "sample_lines_qty_fkey",
        kind: "foreignKey",
        columns: ["qty_col"],
      },
    ],
  })),
})

// Друга ТЧ дзеркала має ім'я основної таблиці `sample` в іншій схемі:
// `TABLE` помилки — без схеми, тож `sample` у каталозі неоднозначна.
const mirror: RuntimeObject = runtimeObjectSchema.parse({
  ...sample,
  id: "00000000-0000-4000-8000-000000000002",
  name: "Mirror",
  kindLabel: "mirror",
  table: { schema: "audit", name: "mirror" },
  tabularSections: [
    {
      ...sample.tabularSections[0],
      table: { schema: "audit", name: "mirror_lines" },
    },
    {
      ...sample.tabularSections[0],
      name: "copies",
      table: { schema: "audit", name: "sample" },
    },
  ],
})

const catalog: RuntimeCatalog = {
  format: 1,
  snapshotHash: "hash",
  provider: "supabase",
  objects: [object, mirror],
}

const phase = { kind: "write" as const, object, operation: "update" as const }
const ref = { kind: "Catalog" as const, name: "Sample" }

const db = (fields: Partial<DatabaseError>): DatabaseError => ({
  message: "boom",
  connectionLost: false,
  ...fields,
})

const map = (fields: Partial<DatabaseError>): CommandError =>
  mapDatabaseError(db(fields), catalog, phase)
const onCommit = (fields: Partial<DatabaseError>): CommandError =>
  mapDatabaseError(db(fields), catalog, undefined)

const internal = { code: "command.internal" }

describe("mapDatabaseError", () => {
  it("a lost connection is command.unavailable whatever the code", () => {
    expect(
      map({
        code: "42501",
        message: "command.forbidden",
        detail: "no-right",
        connectionLost: true,
      })
    ).toEqual({ code: "command.unavailable" })
  })

  it.each(["phase", "missing", "malformed", "unknown-action"])(
    "command.context keeps the allowed detail %s",
    (detail) => {
      expect(
        map({ code: "42501", message: "command.context", detail })
      ).toEqual({ code: "command.context", detail })
    }
  )

  it.each([
    "no-right",
    "new-carrier",
    "effect",
    "rights-context",
    "escalation",
    "delta-domain",
    "role-in-use",
    "last-full-access",
  ])("command.forbidden keeps the allowed reason %s", (reason) => {
    expect(
      map({ code: "42501", message: "command.forbidden", detail: reason })
    ).toEqual({ code: "command.forbidden", reason })
  })

  it("a write refused by RLS is command.forbidden rls with the phase", () => {
    expect(
      map({ code: "42501", message: "new row violates row-level security" })
    ).toEqual({
      code: "command.forbidden",
      reason: "rls",
      object: ref,
      operation: "update",
    })
  })

  it.each(["phase", "no-right"])(
    "42501 with a foreign message and DETAIL %s is an RLS refusal",
    (detail) => {
      expect(map({ code: "42501", message: "app.error", detail })).toEqual({
        code: "command.forbidden",
        reason: "rls",
        object: ref,
        operation: "update",
      })
    }
  )

  it("an RLS refusal in a read names the object without an operation", () => {
    expect(
      mapDatabaseError(db({ code: "42501" }), catalog, { kind: "read", object })
    ).toEqual({ code: "command.forbidden", reason: "rls", object: ref })
  })

  it.each([
    ["a main table", "mirror", { kind: "Catalog", name: "Mirror" }],
    ["a section table", "sample_lines", { kind: "Catalog", name: "Sample" }],
    [
      "another section table",
      "mirror_lines",
      { kind: "Catalog", name: "Mirror" },
    ],
  ])(
    "an RLS refusal on COMMIT names the object of %s",
    (_, table, expected) => {
      expect(onCommit({ code: "42501", message: "rls", table })).toEqual({
        code: "command.forbidden",
        reason: "rls",
        object: expected,
      })
    }
  )

  it("an RLS refusal on COMMIT with an ambiguous table names no object", () => {
    expect(
      onCommit({ code: "42501", message: "rls", table: "sample" })
    ).toEqual({ code: "command.forbidden", reason: "rls" })
  })

  it.each([
    ["version", "7", { currentVersion: 7 }],
    ["exists", undefined, {}],
  ])("command.conflict %s", (reason, hint, extra) => {
    expect(
      map({ code: "P0001", message: "command.conflict", detail: reason, hint })
    ).toEqual({ code: "command.conflict", reason, ...extra })
  })

  it.each([
    ["context", { code: "42501", message: "command.context", detail: "x" }],
    ["context", { code: "42501", message: "command.context" }],
    [
      "forbidden",
      { code: "42501", message: "command.forbidden", detail: "rls" },
    ],
    [
      "forbidden",
      { code: "42501", message: "command.forbidden", detail: "Key (id)=(1)" },
    ],
    ["conflict", { code: "P0001", message: "command.conflict", detail: "x" }],
    [
      "conflict",
      {
        code: "P0001",
        message: "command.conflict",
        detail: "version",
        hint: "1.5",
      },
    ],
    [
      "conflict",
      {
        code: "P0001",
        message: "command.conflict",
        detail: "version",
        hint: "9007199254740992",
      },
    ],
    ["invalid", { code: "22023", message: "command.invalid" }],
    // Той самий код і `DETAIL` з переліку, але повідомлення не ядра: так може
    // кинути SQL-обробник застосунку.
    ["conflict", { code: "P0001", message: "app.error", detail: "version" }],
    ["invalid", { code: "22023", message: "app.error", detail: "code_col" }],
    [
      "conflict",
      {
        code: "P0001",
        message: "command.conflict",
        detail: "version",
        hint: "-5",
      },
    ],
    [
      "conflict",
      {
        code: "P0001",
        message: "command.conflict",
        detail: "version",
        hint: "+7",
      },
    ],
    [
      "conflict",
      {
        code: "P0001",
        message: "command.conflict",
        detail: "version",
        hint: "0",
      },
    ],
  ])(
    "command.%s outside the allowed T0 values is command.internal",
    (_, fields) => {
      expect(map(fields)).toEqual(internal)
    }
  )

  it.each<[string, { path: string } | { reason: string }]>([
    ["code_col", { path: "code" }],
    ["subject_type", { path: "subject" }],
    ["subject_col", { path: "subject" }],
    ["id", { path: "ref" }],
    ["tabular.sample_lines", { path: "lines" }],
    ["tabular.sample_lines.qty_col", { path: "lines.qty" }],
    ["tabular.sample_lines.id", { path: "lines.ref" }],
    // Причини — з T0: прибрана з переліку причина ламає свій рядок таблиці.
    ...[
      COMMAND_CORE_ERRORS.invalid.create,
      COMMAND_CORE_ERRORS.invalid.item,
      COMMAND_CORE_ERRORS.invalid.tabular,
      COMMAND_CORE_ERRORS.invalid.expectedVersion,
      COMMAND_CORE_ERRORS.invalid.mark,
      COMMAND_CORE_ERRORS.invalid.predefined,
    ].map((reason): [string, { reason: string }] => [reason, { reason }]),
    ["missing_col", { reason: "unknown" }],
    ["tabular.sample_lines.missing_col", { reason: "unknown" }],
    ["tabular.mirror_lines", { reason: "unknown" }],
  ])("22023 DETAIL %s maps to %o", (detail, fields) => {
    expect(map({ code: "22023", message: "command.invalid", detail })).toEqual({
      code: "command.invalid",
      ...fields,
    })
  })

  it("22023 command.invalid outside a phase is command.internal", () => {
    expect(
      onCommit({
        code: "22023",
        message: "command.invalid",
        detail: "code_col",
      })
    ).toEqual(internal)
  })

  it.each([
    ["sample", "sample_link_fkey", { path: "link" }],
    ["sample_lines", "sample_lines_qty_fkey", { path: "lines.qty" }],
  ])(
    "23503 on %s is command.invalid by the catalog FK",
    (table, constraint, f) => {
      expect(map({ code: "23503", table, constraint })).toEqual({
        code: "command.invalid",
        ...f,
      })
    }
  )

  it.each([
    ["sample", "sample_code_key"],
    ["sample", "missing_fkey"],
  ])("23503 on %s with a non-FK constraint %s is command.internal", (t, c) => {
    expect(map({ code: "23503", table: t, constraint: c })).toEqual(internal)
  })

  it.each([
    ["sample", "code_col", ["code"]],
    ["sample", "subject_type", ["subject"]],
    ["sample_lines", "qty_col", ["lines.qty"]],
  ])("23502 on %s.%s is command.constraint notNull", (table, column, attrs) => {
    expect(map({ code: "23502", table, column })).toEqual({
      code: "command.constraint",
      kind: "notNull",
      attributes: attrs,
    })
  })

  it("23502 on an unknown column is command.internal", () => {
    expect(map({ code: "23502", table: "sample", column: "x" })).toEqual(
      internal
    )
  })

  it.each([
    ["23505", "sample", "sample_code_key", "unique", ["code"]],
    ["23505", "sample", "sample_subject_key", "unique", ["subject", "note"]],
    ["23505", "sample_lines", "sample_lines_qty_key", "unique", ["lines.qty"]],
    ["23514", "sample", "sample_count_check", "check", ["count"]],
  ])(
    "%s on %s by %s is command.constraint",
    (code, table, constraint, kind, attributes) => {
      expect(map({ code, table, constraint })).toEqual({
        code: "command.constraint",
        kind,
        attributes,
      })
    }
  )

  it.each([
    ["23505", "sample_pkey"],
    ["23505", "sample_count_check"],
    ["23514", "sample_code_key"],
    ["23505", "missing_key"],
  ])("%s by a catalog constraint of another kind (%s) is internal", (c, n) => {
    expect(map({ code: c, table: "sample", constraint: n })).toEqual(internal)
  })

  it.each([
    ["hierarchy isolation", { code: "0A000", message: "hierarchy.isolation" }],
    ["an unexpected code", { code: "XX000" }],
    ["22P02 in a write", { code: "22P02" }],
    ["no code", {}],
  ])("%s is command.internal", (_, fields) => {
    expect(map(fields)).toEqual(internal)
  })

  it("22P02 in a read is command.invalid", () => {
    expect(
      mapDatabaseError(db({ code: "22P02" }), catalog, { kind: "read", object })
    ).toEqual({
      code: "command.invalid",
    })
  })

  // Текст бази може нести дані рядка (Р-A3-8): жодне поле його не повторює.
  const leak = "Failing row contains (secret-value). Key (code)=(secret-value)"
  it.each([
    ["23502", { table: "sample", column: "code_col" }],
    ["23503", { table: "sample", constraint: "sample_link_fkey" }],
    ["23505", { table: "sample", constraint: "sample_code_key" }],
    ["23514", { table: "sample", constraint: "sample_count_check" }],
    ["23505", { table: "sample", constraint: "unknown" }],
    ["42501", {}],
    ["42501", { message: "command.forbidden" }],
    ["42501", { message: "command.context" }],
  ])("Postgres text of %s %o reaches no field", (code, fields) => {
    const error = map({
      code,
      message: leak,
      detail: leak,
      hint: leak,
      ...fields,
    })
    const failure = new CommandFailure(error)
    for (const text of [
      JSON.stringify(error),
      JSON.stringify(failure),
      failure.message,
      String(failure.cause),
    ]) {
      expect(text).not.toContain("secret-value")
      expect(text).not.toContain("Failing row")
    }
  })
})
