import { describe, expect, it } from "vitest"
import { readCatalog } from "./catalog"
import { withRollback } from "./connection"

describe("DB test stack", () => {
  it("rollback leaves no trace", async () => {
    await withRollback(async (client) => {
      await client.query("CREATE SCHEMA e1_probe")
      const inside = await client.query(
        "SELECT 1 FROM pg_namespace WHERE nspname = 'e1_probe'"
      )
      expect(inside.rowCount).toBe(1)
    })
    await withRollback(async (client) => {
      const after = await client.query(
        "SELECT 1 FROM pg_namespace WHERE nspname = 'e1_probe'"
      )
      expect(after.rowCount).toBe(0)
    })
  })

  it("rolls back even when the callback throws", async () => {
    await expect(
      withRollback(async (client) => {
        await client.query("CREATE SCHEMA e1_probe_throw")
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
    await withRollback(async (client) => {
      const after = await client.query(
        "SELECT 1 FROM pg_namespace WHERE nspname = 'e1_probe_throw'"
      )
      expect(after.rowCount).toBe(0)
    })
  })

  it("provider base state is visible", async () => {
    await withRollback(async (client) => {
      const result = await client.query(
        "SELECT to_regclass('auth.users') IS NOT NULL AS present"
      )
      expect(result.rows[0]).toEqual({ present: true })
    })
  })

  it("readCatalog reads a table", async () => {
    await withRollback(async (client) => {
      await client.query(`
        CREATE SCHEMA e1_cat;
        CREATE TYPE e1_cat.status AS ENUM ('open', 'closed');
        CREATE TABLE e1_cat.item (
          id uuid NOT NULL,
          code text COLLATE "C" NOT NULL,
          kind integer,
          state e1_cat.status NOT NULL DEFAULT 'open',
          seq integer GENERATED ALWAYS AS IDENTITY,
          label text GENERATED ALWAYS AS (upper(code)) STORED,
          CONSTRAINT item_pk PRIMARY KEY (id),
          CONSTRAINT item_code_kind_uq UNIQUE NULLS NOT DISTINCT (code, kind)
            DEFERRABLE INITIALLY DEFERRED,
          CONSTRAINT item_kind_ck CHECK (kind > 0)
        );
        CREATE INDEX item_state_ix ON e1_cat.item (state) WHERE kind IS NOT NULL;
        CREATE INDEX item_lower_ix ON e1_cat.item
          (lower(code) DESC NULLS LAST, kind NULLS FIRST) INCLUDE (state);
        CREATE TABLE e1_cat.tag (
          item_id uuid,
          CONSTRAINT tag_item_fk FOREIGN KEY (item_id) REFERENCES e1_cat.item (id)
            ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE
        );
        ALTER TABLE e1_cat.item ENABLE ROW LEVEL SECURITY;
        ALTER TABLE e1_cat.item FORCE ROW LEVEL SECURITY;
        COMMENT ON TABLE e1_cat.item IS 'Item';
        COMMENT ON COLUMN e1_cat.item.code IS 'Code';
        COMMENT ON TYPE e1_cat.status IS 'Status';
        CREATE FUNCTION e1_cat.twice(x integer) RETURNS integer
          LANGUAGE sql IMMUTABLE AS 'SELECT x * 2';
      `)

      const catalog = await readCatalog(client, ["e1_cat"])

      expect(catalog).toEqual({
        enumTypes: [
          {
            schema: "e1_cat",
            name: "status",
            values: ["open", "closed"],
            comment: "Status",
          },
        ],
        tables: [
          {
            schema: "e1_cat",
            name: "item",
            comment: "Item",
            rowLevelSecurity: "forced",
            columns: [
              { name: "id", type: "uuid", notNull: true },
              {
                name: "code",
                type: "text",
                notNull: true,
                collation: { name: "C" },
                comment: "Code",
              },
              { name: "kind", type: "integer", notNull: false },
              {
                name: "state",
                type: "<schema>.status",
                notNull: true,
                default: "'open'::<schema>.status",
              },
              {
                name: "seq",
                type: "integer",
                notNull: true,
                identity: { generation: "always", sequence: "item_seq_seq" },
              },
              {
                name: "label",
                type: "text",
                notNull: false,
                generated: { expression: "upper(code)" },
              },
            ],
            constraints: [
              {
                name: "item_code_kind_uq",
                type: "unique",
                definition:
                  "UNIQUE NULLS NOT DISTINCT (code, kind) DEFERRABLE INITIALLY DEFERRED",
                columns: ["code", "kind"],
                deferrable: true,
                initiallyDeferred: true,
                index: "item_code_kind_uq",
              },
              {
                name: "item_kind_ck",
                type: "check",
                definition: "CHECK ((kind > 0))",
                columns: ["kind"],
                deferrable: false,
                initiallyDeferred: false,
              },
              {
                name: "item_pk",
                type: "primaryKey",
                definition: "PRIMARY KEY (id)",
                columns: ["id"],
                deferrable: false,
                initiallyDeferred: false,
                index: "item_pk",
              },
            ],
            indexes: [
              {
                name: "item_code_kind_uq",
                definition:
                  "CREATE UNIQUE INDEX item_code_kind_uq ON <schema>.item USING btree (code, kind) NULLS NOT DISTINCT",
                unique: true,
                method: "btree",
                keys: [{ column: "code" }, { column: "kind" }],
                include: [],
                nullsNotDistinct: true,
                constraint: "item_code_kind_uq",
              },
              {
                name: "item_lower_ix",
                definition:
                  "CREATE INDEX item_lower_ix ON <schema>.item USING btree (lower(code) DESC NULLS LAST, kind NULLS FIRST) INCLUDE (state)",
                unique: false,
                method: "btree",
                keys: [
                  { expression: "lower(code)", order: "desc", nulls: "last" },
                  { column: "kind", nulls: "first" },
                ],
                include: ["state"],
                nullsNotDistinct: false,
              },
              {
                name: "item_pk",
                definition:
                  "CREATE UNIQUE INDEX item_pk ON <schema>.item USING btree (id)",
                unique: true,
                method: "btree",
                keys: [{ column: "id" }],
                include: [],
                nullsNotDistinct: false,
                constraint: "item_pk",
              },
              {
                name: "item_state_ix",
                definition:
                  "CREATE INDEX item_state_ix ON <schema>.item USING btree (state) WHERE (kind IS NOT NULL)",
                unique: false,
                method: "btree",
                keys: [{ column: "state" }],
                include: [],
                where: "(kind IS NOT NULL)",
                nullsNotDistinct: false,
              },
            ],
          },
          {
            schema: "e1_cat",
            name: "tag",
            rowLevelSecurity: "off",
            columns: [{ name: "item_id", type: "uuid", notNull: false }],
            constraints: [
              {
                name: "tag_item_fk",
                type: "foreignKey",
                definition:
                  "FOREIGN KEY (item_id) REFERENCES <schema>.item(id) ON UPDATE RESTRICT ON DELETE CASCADE DEFERRABLE",
                columns: ["item_id"],
                deferrable: true,
                initiallyDeferred: false,
                references: {
                  schema: "e1_cat",
                  table: "item",
                  columns: ["id"],
                  onDelete: "cascade",
                  onUpdate: "restrict",
                },
              },
            ],
            indexes: [],
          },
        ],
        functions: [
          {
            schema: "e1_cat",
            name: "twice",
            arguments: "x integer",
            result: "integer",
          },
        ],
      })
    })
  })
})
