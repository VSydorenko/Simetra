import { describe, expect, it } from "vitest"
import { connectPrivilegeSql } from "./app-database.mts"

describe("connectPrivilegeSql", () => {
  const sql = connectPrivilegeSql("app_db", ["a", "b"])

  it("revokes CONNECT from PUBLIC before any grant", () => {
    expect(sql[0]).toBe('REVOKE CONNECT ON DATABASE "app_db" FROM PUBLIC')
  })

  it("grants CONNECT to exactly the given roles and never to PUBLIC", () => {
    expect(sql.slice(1)).toEqual([
      'GRANT CONNECT ON DATABASE "app_db" TO "a"',
      'GRANT CONNECT ON DATABASE "app_db" TO "b"',
    ])
    expect(sql.filter((s) => /^GRANT.*PUBLIC/i.test(s))).toEqual([])
  })
})
