import { beforeAll, describe, expect, it } from "vitest"
import { loadSqlParser, type SqlParser } from "simetra/compiler"
import {
  parseConstraintDefinition,
  parseIndexDefinition,
} from "../pg-delta/map-definitions"

/**
 * Розбір дефініцій, які двигун бере з `pg_get_constraintdef` і
 * `pg_get_indexdef` (план E2a, задача 4). Тексти — дослівно з фактів двигуна
 * на стеку: форма значень — як у фізичному знімку (спека П2 §8.3).
 */

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const table = { schema: "app", name: "doc" }

describe("parseConstraintDefinition", () => {
  it("primary key", () => {
    expect(
      parseConstraintDefinition(parse, table, "doc_pkey", "PRIMARY KEY (id)")
    ).toEqual({
      type: "primaryKey",
      value: { name: "doc_pkey", columns: ["id"] },
    })
  })

  it("unique nulls not distinct deferrable initially deferred", () => {
    expect(
      parseConstraintDefinition(
        parse,
        table,
        "parent_code_key",
        "UNIQUE NULLS NOT DISTINCT (code, n) DEFERRABLE INITIALLY DEFERRED"
      )
    ).toEqual({
      type: "unique",
      value: {
        name: "parent_code_key",
        columns: ["code", "n"],
        nullsNotDistinct: true,
        deferrable: "initiallyDeferred",
      },
    })
    expect(
      parseConstraintDefinition(parse, table, "u", "UNIQUE (code)")
    ).toEqual({
      type: "unique",
      value: { name: "u", columns: ["code"], nullsNotDistinct: false },
    })
  })

  it("check strips wrapper", () => {
    expect(
      parseConstraintDefinition(
        parse,
        table,
        "parent_n_check",
        "CHECK ((n >= 0))"
      )
    ).toEqual({
      type: "check",
      value: { name: "parent_n_check", expression: "(n >= 0)" },
    })
  })

  it("foreign key with cascade and external target", () => {
    expect(
      parseConstraintDefinition(
        parse,
        table,
        "profile_id_fkey",
        "FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE"
      )
    ).toEqual({
      type: "foreignKey",
      value: {
        name: "profile_id_fkey",
        columns: ["id"],
        references: { schema: "auth", table: "users", columns: ["id"] },
        onDelete: "cascade",
        onUpdate: "noAction",
        deferrable: "no",
      },
    })
    expect(
      parseConstraintDefinition(
        parse,
        table,
        "child_user_id_fkey",
        "FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE RESTRICT ON DELETE SET NULL DEFERRABLE"
      )
    ).toMatchObject({
      type: "foreignKey",
      value: {
        onDelete: "setNull",
        onUpdate: "restrict",
        deferrable: "deferrable",
      },
    })
  })

  it("exclude is unrepresentable", () => {
    expect(
      parseConstraintDefinition(
        parse,
        table,
        "parent_excl",
        "EXCLUDE USING gist (during WITH &&)"
      )
    ).toMatchObject({ type: "unrepresentable" })
  })

  it("forms the snapshot has no field for are unrepresentable", () => {
    for (const def of [
      "FOREIGN KEY (pid) REFERENCES app.child(id) NOT VALID",
      "FOREIGN KEY (a, b) REFERENCES app.t(a, b) MATCH FULL",
      "FOREIGN KEY (a, b) REFERENCES app.t(a, b) ON DELETE SET NULL (b)",
      "CHECK ((n > 0)) NO INHERIT",
      "UNIQUE (code) INCLUDE (n)",
      "PRIMARY KEY (id) WITH (fillfactor='50')",
    ]) {
      expect(
        parseConstraintDefinition(parse, table, "c", def),
        def
      ).toMatchObject({ type: "unrepresentable" })
    }
  })
})

describe("parseIndexDefinition", () => {
  it("partial expression index with opclass desc nulls last include", () => {
    expect(
      parseIndexDefinition(
        parse,
        "CREATE INDEX child_email_idx ON app.child USING btree (lower(email) text_pattern_ops DESC NULLS LAST, id) INCLUDE (parent_id) WHERE (email IS NOT NULL)"
      )
    ).toEqual({
      type: "index",
      value: {
        name: "child_email_idx",
        unique: false,
        method: "btree",
        keys: [
          {
            expression: "lower(email)",
            order: "desc",
            nulls: "last",
            opclass: { name: "text_pattern_ops" },
          },
          { column: "id" },
        ],
        include: ["parent_id"],
        where: "email IS NOT NULL",
        nullsNotDistinct: false,
      },
    })
  })

  it("default ordering is omitted", () => {
    expect(
      parseIndexDefinition(
        parse,
        'CREATE UNIQUE INDEX "Odd, name" ON app."t (x)" USING btree (id, code DESC, n NULLS FIRST, ((a + b)) COLLATE "C") NULLS NOT DISTINCT'
      )
    ).toEqual({
      type: "index",
      value: {
        name: "Odd, name",
        unique: true,
        method: "btree",
        keys: [
          { column: "id" },
          { column: "code", order: "desc" },
          { column: "n", nulls: "first" },
          { expression: "(a + b)", collation: { name: "C" } },
        ],
        include: [],
        nullsNotDistinct: true,
      },
    })
  })

  it("storage parameters are unrepresentable", () => {
    expect(
      parseIndexDefinition(
        parse,
        "CREATE INDEX i ON app.t USING btree (id) WITH (fillfactor='50')"
      )
    ).toMatchObject({ type: "unrepresentable" })
    expect(
      parseIndexDefinition(
        parse,
        "CREATE INDEX i ON ONLY app.t USING btree (id)"
      )
    ).toMatchObject({ type: "unrepresentable" })
  })
})
