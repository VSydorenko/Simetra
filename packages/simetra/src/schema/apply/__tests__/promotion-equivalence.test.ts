import { describe, expect, it } from "vitest"
import {
  canonicalRenames,
  tableKey,
  type EquivalenceObject,
} from "simetra/schema"

/**
 * Канонічні імена (спека промоції §5): об'єкт копії, рівний об'єкту тіні
 * за формою без імені, отримує ім'я тіні кроком каталогу, а не DROP+CREATE
 * двигуна.
 */

const con = (
  table: string,
  name: string,
  contype: string,
  def: string,
  valid = true
): EquivalenceObject => ({
  kind: "constraint",
  schema: "app",
  table,
  name,
  key: JSON.stringify([contype, def]),
  valid,
})

const idx = (
  table: string,
  name: string,
  key: string,
  valid = true
): EquivalenceObject => ({
  kind: "index",
  schema: "app",
  table,
  name,
  key,
  valid,
})

const seq = (
  table: string,
  name: string,
  column: string,
  usedByDefault = true
): EquivalenceObject => ({
  kind: "sequence",
  schema: "app",
  table,
  name,
  key: JSON.stringify([column, usedByDefault]),
  valid: true,
})

const none = new Map<string, string>()

describe("canonicalRenames", () => {
  it("renames the equivalent primary key, unique constraint, foreign key, index and sequence", () => {
    const fk = "FOREIGN KEY (owner) REFERENCES app.owners(id)"
    const clone = [
      con("items", "old_pkey", "p", "PRIMARY KEY (id)"),
      con("items", "old_code_key", "u", "UNIQUE (code)"),
      con("items", "old_fkey", "f", fk),
      idx("items", "old_name_idx", "btree(name)"),
      seq("items", "old_id_seq", "id"),
    ]
    const shadow = [
      con("items", "new_pkey", "p", "PRIMARY KEY (id)"),
      con("items", "new_code_key", "u", "UNIQUE (code)"),
      con("items", "new_fkey", "f", fk),
      idx("items", "new_name_idx", "btree(name)"),
      seq("items", "new_id_seq", "id"),
    ]
    // Блокування — у старому імені таблиці: так її бачить ціль
    const tablesNewToOld = new Map([
      [tableKey("app", "items"), tableKey("app", "legacy_items")],
    ])
    const { steps, tempNames, renames } = canonicalRenames(
      clone,
      shadow,
      tablesNewToOld
    )
    // Секція плану бере канонічні імена звідси, у порядку кроків
    const items = { schema: "app", name: "items" }
    expect(renames).toEqual([
      {
        kind: "constraint",
        table: items,
        from: "old_code_key",
        to: "new_code_key",
      },
      { kind: "constraint", table: items, from: "old_fkey", to: "new_fkey" },
      { kind: "constraint", table: items, from: "old_pkey", to: "new_pkey" },
      { kind: "index", table: items, from: "old_name_idx", to: "new_name_idx" },
      { kind: "sequence", table: items, from: "old_id_seq", to: "new_id_seq" },
    ])
    expect(steps.map((s) => s.sql)).toEqual([
      "ALTER TABLE app.items RENAME CONSTRAINT old_code_key TO new_code_key",
      "ALTER TABLE app.items RENAME CONSTRAINT old_fkey TO new_fkey",
      "ALTER TABLE app.items RENAME CONSTRAINT old_pkey TO new_pkey",
      "ALTER INDEX app.old_name_idx RENAME TO new_name_idx",
      "ALTER SEQUENCE app.old_id_seq RENAME TO new_id_seq",
    ])
    for (const s of steps) {
      expect(s.origin).toBe("intent")
      expect(s.class).toBe("catalogOnly")
      expect(s.lockedTables).toEqual([{ schema: "app", name: "legacy_items" }])
    }
    expect(tempNames.size).toBe(0)
  })

  it("never matches an invalid index or a NOT VALID constraint", () => {
    const def = "CHECK ((qty > 0)) NOT VALID"
    const clone = [
      con("items", "old_check", "c", def, false),
      idx("items", "old_idx", "btree(name)", false),
    ]
    const shadow = [
      con("items", "new_check", "c", def),
      idx("items", "new_idx", "btree(name)"),
    ]
    expect(canonicalRenames(clone, shadow, none).steps).toEqual([])
  })

  it("does not match a unique constraint to a standalone unique index", () => {
    const clone = [idx("items", "items_code_idx", "unique btree(code)")]
    const shadow = [con("items", "items_code_key", "u", "UNIQUE (code)")]
    expect(canonicalRenames(clone, shadow, none).steps).toEqual([])
  })

  it("matches each candidate once and takes the first by name", () => {
    // `B` < `a` у кодових одиницях (як `COLLATE "C"`), не в локалі
    const clone = [
      idx("items", "a_idx", "btree(name)"),
      idx("items", "B_idx", "btree(name)"),
    ]
    const shadow = [
      idx("items", "x_idx", "btree(name)"),
      idx("items", "y_idx", "btree(name)"),
      idx("items", "z_idx", "btree(name)"),
    ]
    expect(
      canonicalRenames(clone, shadow, none).steps.map((s) => s.sql)
    ).toEqual([
      'ALTER INDEX app."B_idx" RENAME TO x_idx',
      "ALTER INDEX app.a_idx RENAME TO y_idx",
    ])
  })

  it("renames a sequence only when exactly one candidate matches", () => {
    // Дві послідовності OWNED BY однієї колонки, жодну не вживає DEFAULT:
    // лічильник — дані, тож вибір за ім'ям міг би віддати чужий лічильник
    const clone = [
      seq("items", "a_seq", "id", false),
      seq("items", "b_seq", "id", false),
    ]
    const shadow = [seq("items", "items_id_seq", "id", false)]
    expect(canonicalRenames(clone, shadow, none).steps).toEqual([])
  })

  it("prefers the sequence the column default uses", () => {
    const clone = [
      seq("items", "a_seq", "id", false),
      seq("items", "b_seq", "id", true),
    ]
    const shadow = [seq("items", "items_id_seq", "id", true)]
    expect(
      canonicalRenames(clone, shadow, none).steps.map((s) => s.sql)
    ).toEqual(["ALTER SEQUENCE app.b_seq RENAME TO items_id_seq"])
  })

  it("moves an occupying object out of the way", () => {
    // Окремий унікальний індекс копії тримає ім'я, якого тінь хоче для
    // обмеження: перейменування обмеження перейменовує і його індекс у тому
    // самому просторі імен відношень схеми
    const clone = [
      idx("items", "items_code_key", "unique btree(code)"),
      con("items", "legacy_code_uq", "u", "UNIQUE (code)"),
    ]
    const shadow = [con("items", "items_code_key", "u", "UNIQUE (code)")]
    const { steps, tempNames } = canonicalRenames(clone, shadow, none)
    expect(steps.map((s) => s.sql)).toEqual([
      "ALTER INDEX app.items_code_key RENAME TO simetra_tmp_1",
      "ALTER TABLE app.items RENAME CONSTRAINT legacy_code_uq TO items_code_key",
    ])
    expect([...tempNames]).toEqual([
      [JSON.stringify(["app", "items", "simetra_tmp_1"]), "items_code_key"],
    ])
  })

  it("leaves a shadow name the clone already uses to the engine", () => {
    const clone = [
      idx("items", "a_idx", "btree(a)"),
      idx("items", "b_idx", "btree(b)"),
    ]
    const shadow = [
      idx("items", "b_idx", "btree(a)"),
      idx("items", "a_idx", "btree(b)"),
    ]
    // Ім'я тіні на копії вже є — кандидатів не шукаємо, двигун перебудує
    expect(canonicalRenames(clone, shadow, none).steps).toEqual([])
  })

  it("swaps names across tables through a temporary name that does not survive", () => {
    // Індекси різних таблиць ділять простір імен відношень схеми
    const clone = [
      idx("t1", "a_idx", "btree(x)"),
      idx("t2", "b_idx", "btree(y)"),
    ]
    const shadow = [
      idx("t1", "b_idx", "btree(x)"),
      idx("t2", "a_idx", "btree(y)"),
    ]
    const { steps, tempNames } = canonicalRenames(clone, shadow, none)
    expect(steps.map((s) => s.sql)).toEqual([
      "ALTER INDEX app.a_idx RENAME TO simetra_tmp_1",
      "ALTER INDEX app.b_idx RENAME TO a_idx",
      "ALTER INDEX app.simetra_tmp_1 RENAME TO b_idx",
    ])
    expect(tempNames.size).toBe(0)
  })

  it("does not treat a check constraint as occupying a relation name", () => {
    const clone = [
      con("items", "items_name_idx", "c", "CHECK ((qty > 0))"),
      idx("items", "legacy_idx", "btree(name)"),
    ]
    const shadow = [
      con("items", "items_name_idx", "c", "CHECK ((qty > 0))"),
      idx("items", "items_name_idx", "btree(name)"),
    ]
    expect(
      canonicalRenames(clone, shadow, none).steps.map((s) => s.sql)
    ).toEqual(["ALTER INDEX app.legacy_idx RENAME TO items_name_idx"])
  })
})
