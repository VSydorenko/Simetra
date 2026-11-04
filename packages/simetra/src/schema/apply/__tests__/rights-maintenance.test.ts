import { beforeAll, describe, expect, it } from "vitest"
import {
  buildRuntimeCatalog,
  compile,
  loadSqlParser,
  withoutLocations,
  type CompiledModel,
  type SqlParser,
} from "simetra/compiler"
import { RIGHTS_MAINTENANCE_SETTING } from "simetra/model"
import {
  ApplyConnectionLost,
  ApplyDbError,
  type ApplyDatabase,
  type ApplyTransaction,
} from "../port"
import {
  runRightsMaintenance,
  type RightsMaintenanceRequest,
} from "../rights-maintenance"
import {
  adminRoles,
  adoptedSourcesDomain,
  commandCoreLayer,
  GLOBAL_ADMIN_ID,
  ORG_ADMIN_ID,
  policyDomain,
} from "../../../compiler/__tests__/fixtures/rights"
import { uuid } from "../../../compiler/__tests__/helpers"

/**
 * Ядро інструмента обслуговування прав на порт-фейку: відмови до запису й
 * властивості послідовності (замок, хеш, `row_security`, режим `LOCAL`, один
 * оператор без CTE, значення лише в параметрах). Що база приймає SQL і
 * судить запобіжниками — DB-тести designer (Задача 9).
 */

let parse: SqlParser
let model: CompiledModel
let adopted: CompiledModel
beforeAll(async () => {
  parse = await loadSqlParser()
  model = (await compile(policyDomain(adminRoles(), commandCoreLayer()))).model!
  adopted = (await compile(adoptedSourcesDomain())).model!
})

const USER = uuid(9701)
const SCOPE = uuid(9702)
const MEMBER = uuid(9703)
const NEW_ID = uuid(9704)
const TARGET = { url: "postgres://maintenance.test/db" }

const first: RightsMaintenanceRequest = {
  action: "firstGlobalAssignment",
  user: USER,
  role: "GlobalAdmin",
}
const restore: RightsMaintenanceRequest = {
  action: "restoreGlobalFullAccess",
  user: USER,
}
const tenant = (
  over: Partial<
    Extract<RightsMaintenanceRequest, { action: "tenantFullAccess" }>
  > = {}
): RightsMaintenanceRequest => ({
  action: "tenantFullAccess",
  scopeKind: "org",
  scope: SCOPE,
  user: USER,
  role: "OrgAdmin",
  ...over,
})
const ACTIONS: [string, RightsMaintenanceRequest, string][] = [
  ["firstGlobalAssignment", first, GLOBAL_ADMIN_ID],
  ["restoreGlobalFullAccess", restore, GLOBAL_ADMIN_ID],
  ["tenantFullAccess", tenant(), ORG_ADMIN_ID],
]

/** Відповідь фейка на читання; читання розрізняються псевдонімом колонки. */
interface State {
  locked?: boolean
  hash?: string | null | ApplyDbError
  user?: { invalid: boolean } | null
  assigned?: boolean
  holder?: boolean
  root?: boolean
  member?: string | null
  effective?: boolean
  /** Помилка на операторі, що задовольняє `when`. */
  fail?: { when: (sql: string) => boolean; error: Error }
  commit?: Error
}

interface Sent {
  sql: string
  params: readonly unknown[]
}

const STATE_READS = ["invalid", "assigned", "holder", "root", "member"]
const aliasOf = (sql: string): string | undefined =>
  [
    "locked",
    "hash",
    "invalid",
    "assigned",
    "holder",
    "root",
    "member",
    "effective",
    "id",
  ].find((alias) => sql.includes(` AS ${alias}`))

function fakeDatabase(state: State, applied: string) {
  const log: (Sent | "BEGIN" | "COMMIT" | "ROLLBACK")[] = []
  let transactions = 0
  const rows = (sql: string): Record<string, unknown>[] => {
    const yes = (flag: boolean | undefined) => (flag === true ? [{ x: 1 }] : [])
    switch (aliasOf(sql)) {
      case "locked":
        return [{ locked: state.locked ?? true }]
      case "hash": {
        if (state.hash instanceof ApplyDbError) throw state.hash
        return [{ hash: state.hash === undefined ? applied : state.hash }]
      }
      case "invalid":
        return state.user === null ? [] : [state.user ?? { invalid: false }]
      case "assigned":
        return yes(state.assigned)
      case "holder":
        return yes(state.holder)
      case "root":
        return yes(state.root ?? true)
      case "member":
        return state.member == null ? [] : [{ member: state.member }]
      case "effective":
        return yes(state.effective ?? true)
      case "id":
        return [{ id: NEW_ID }]
      default:
        return []
    }
  }
  const tx: ApplyTransaction = {
    async query<R extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = []
    ): Promise<R[]> {
      log.push({ sql, params })
      if (state.fail?.when(sql)) throw state.fail.error
      return rows(sql) as R[]
    },
    extract() {
      throw new Error("maintenance never extracts")
    },
  }
  const dbs: ApplyDatabase = {
    async transaction(_db, end, fn) {
      transactions++
      log.push("BEGIN")
      let result
      try {
        result = await fn(tx)
      } catch (error) {
        log.push("ROLLBACK")
        throw error
      }
      log.push(end === "commit" ? "COMMIT" : "ROLLBACK")
      if (state.commit !== undefined) throw state.commit
      return result
    },
  }
  const statements = () =>
    log.filter((entry): entry is Sent => typeof entry === "object")
  return { dbs, log, statements, transactions: () => transactions }
}

const run = (
  request: RightsMaintenanceRequest,
  state: State = {},
  on: CompiledModel = model
) => {
  const fake = fakeDatabase(state, on.hash)
  return {
    fake,
    result: runRightsMaintenance(fake.dbs, TARGET, on, request),
  }
}

/** Модель з підміненими контрактами — для ролей, яких фікстура не дає. */
const withContracts = (
  patch: (
    contracts: CompiledModel["contracts"]
  ) => Partial<CompiledModel["contracts"]>
): CompiledModel => ({
  ...model,
  contracts: { ...model.contracts, ...patch(model.contracts) },
})
const globalAdmin = (contracts: CompiledModel["contracts"]) =>
  contracts.roles.find((r) => r.roleId === GLOBAL_ADMIN_ID)!
const withRolePatch = (patch: Record<string, unknown>) =>
  withContracts((c) => ({
    roles: c.roles.map((r) =>
      r.roleId === GLOBAL_ADMIN_ID ? { ...r, ...patch } : r
    ),
  }))

const isWrite = (sql: string) => /^\s*INSERT\b/i.test(sql)
const isMode = (sent: Sent) => sent.params[0] === RIGHTS_MAINTENANCE_SETTING
const indexOf = (sent: Sent[], test: (s: Sent) => boolean) =>
  sent.findIndex(test)

/** Імена вузлів дерева розбору — для «без CTE» і «один запис». */
function nodeTypes(node: unknown, into: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) nodeTypes(item, into)
  } else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (/^[A-Z]/.test(key)) into.push(key)
      if (key === "withClause") into.push("WithClause")
      nodeTypes(value, into)
    }
  }
  return into
}

function single(sql: string): Record<string, unknown> {
  const parsed = parse(sql)
  if (!parsed.ok) throw new Error(`SQL does not parse: ${sql}`)
  expect(parsed.statements, sql).toHaveLength(1)
  return withoutLocations(parsed.statements[0]!.stmt) as Record<string, unknown>
}

describe("runRightsMaintenance: refusals before connecting", () => {
  it.each<
    [
      string,
      RightsMaintenanceRequest,
      () => CompiledModel,
      string,
      Record<string, unknown>,
    ]
  >([
    [
      "an unknown role",
      { ...first, role: "Nobody" },
      () => model,
      "maintenance.unknown-role",
      { role: "Nobody" },
    ],
    [
      "a role of another level",
      { ...first, role: "OrgAdmin" },
      () => model,
      "maintenance.role-level",
      { role: "OrgAdmin" },
    ],
    [
      "a global role without fullAccess",
      { ...restore, role: "Support" },
      () => model,
      "maintenance.role-level",
      { role: "Support" },
    ],
    [
      "two global fullAccess roles and no role named",
      restore,
      () =>
        withContracts((c) => ({
          roles: [
            ...c.roles,
            { ...globalAdmin(c), roleId: uuid(9790), name: "SecondAdmin" },
          ],
        })),
      "maintenance.role-ambiguous",
      { roles: "GlobalAdmin, SecondAdmin" },
    ],
    [
      "no global fullAccess role",
      restore,
      () => withRolePatch({ fullAccess: false }),
      "maintenance.role-level",
      { role: "(none)" },
    ],
    [
      "a role that is not assignable",
      first,
      () => withRolePatch({ assignable: false }),
      "maintenance.role-level",
      { role: "GlobalAdmin" },
    ],
    [
      "a container role",
      tenant({ role: "ProjectLead" }),
      () => model,
      "maintenance.role-level",
      { role: "ProjectLead" },
    ],
    [
      "an unknown scope kind",
      tenant({ scopeKind: "team" }),
      () => model,
      "maintenance.unknown-scope-kind",
      { scopeKind: "team" },
    ],
    [
      "no assignments catalog on the level",
      first,
      () =>
        withContracts((c) => ({
          rightsCatalogs: c.rightsCatalogs.filter(
            (catalog) => catalog.level.level !== "global"
          ),
        })),
      "maintenance.no-catalog",
      { level: "global" },
    ],
    [
      "a member with the forced user",
      tenant({ member: { user: USER } }),
      () => model,
      "maintenance.invalid-member",
      { path: "user" },
    ],
    [
      "a member with the forced scope",
      tenant({ member: { org: SCOPE } }),
      () => model,
      "maintenance.invalid-member",
      { path: "org" },
    ],
    [
      "a member with an unknown attribute",
      tenant({ member: { nickname: "x" } }),
      () => model,
      "maintenance.invalid-member",
      { path: "nickname" },
    ],
  ])("%s", async (_, request, on, code, params) => {
    const { fake, result } = run(request, {}, on())
    const outcome = await result
    expect(outcome).toMatchObject({
      ok: false,
      diagnostic: { code, params: expect.objectContaining(params) },
    })
    expect(fake.transactions()).toBe(0)
  })
})

describe("runRightsMaintenance: the write sequence", () => {
  it.each(ACTIONS)(
    "%s: lock first, hash and row_security before the state, LOCAL mode before the first write",
    async (_, request, roleId) => {
      const { fake, result } = run(request)
      expect(await result).toEqual({
        ok: true,
        done:
          request.action === "tenantFullAccess"
            ? { assignment: NEW_ID, member: NEW_ID }
            : { assignment: NEW_ID },
      })
      const sent = fake.statements()
      expect(fake.log.at(-1)).toBe("COMMIT")
      expect(sent[0]!.sql).toMatch(/pg_try_advisory_xact_lock/)
      const state = indexOf(sent, (s) =>
        STATE_READS.includes(aliasOf(s.sql) ?? "")
      )
      const lastState =
        sent.length -
        1 -
        indexOf([...sent].reverse(), (s) =>
          STATE_READS.includes(aliasOf(s.sql) ?? "")
        )
      const hash = indexOf(sent, (s) => aliasOf(s.sql) === "hash")
      const rowSecurity = indexOf(sent, (s) => {
        const tree = JSON.stringify(single(s.sql))
        return (
          tree.includes('"sval":"row_security"') &&
          tree.includes('"sval":"off"')
        )
      })
      const mode = indexOf(sent, isMode)
      const write = indexOf(sent, (s) => isWrite(s.sql))
      expect(state).toBeGreaterThan(0)
      expect(hash).toBeGreaterThan(0)
      expect(hash).toBeLessThan(state)
      expect(rowSecurity).toBeGreaterThan(hash)
      expect(rowSecurity).toBeLessThan(state)
      expect(mode).toBeGreaterThan(lastState)
      expect(mode).toBeLessThan(write)
      // `set_config(<налаштування>, 'on', true)`: третій аргумент — `LOCAL`
      const call = JSON.stringify(single(sent[mode]!.sql))
      expect(call).toContain('"sval":"set_config"')
      expect(call).toContain('"ParamRef":{"number":1}')
      expect(call).toContain('"sval":"on"')
      expect(call).toContain('"boolval":{"boolval":true}')
      expect(sent.filter(isMode)).toHaveLength(1)
      // Архетип — роль запиту, і він — лише параметр
      const assignment = sent.filter((s) => isWrite(s.sql)).at(-1)!
      expect(assignment.params).toContain(roleId)
      expect(assignment.params).toContain(
        request.action === "tenantFullAccess" ? NEW_ID : USER
      )
    }
  )

  it.each(ACTIONS)(
    "%s: every statement is one statement without CTE and writes one relation at most",
    async (_, request) => {
      const { fake, result } = run(request)
      expect((await result).ok).toBe(true)
      for (const { sql } of fake.statements()) {
        const types = nodeTypes(single(sql))
        expect(types, sql).not.toContain("WithClause")
        expect(types, sql).not.toContain("CommonTableExpr")
        const writes = types.filter((t) =>
          ["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"].includes(t)
        )
        expect(writes.length, sql).toBe(isWrite(sql) ? 1 : 0)
      }
    }
  )

  it("keeps a member value with a quote and every id in the parameters", async () => {
    const { fake, result } = run(tenant({ member: { description: "O'Brien" } }))
    expect((await result).ok).toBe(true)
    const sent = fake.statements()
    for (const { sql } of sent) {
      for (const value of ["Brien", USER, SCOPE, ORG_ADMIN_ID, NEW_ID])
        expect(sql, value).not.toContain(value)
    }
    const insert = sent.find((s) => isWrite(s.sql) && s.params.length === 1)!
    expect(JSON.parse(insert.params[0] as string)).toMatchObject({
      description: "O'Brien",
    })
  })

  it.each(ACTIONS)(
    "%s: an assignment that is not effective rolls back as not-effective",
    async (_, request) => {
      const { fake, result } = run(request, { effective: false })
      expect(await result).toMatchObject({
        ok: false,
        diagnostic: {
          code: "maintenance.not-effective",
          params: { user: USER },
        },
      })
      expect(fake.log).not.toContain("COMMIT")
      expect(fake.log.at(-1)).toBe("ROLLBACK")
    }
  )
})

describe("runRightsMaintenance: refusals inside the transaction", () => {
  it("busy: the lock is held — nothing else is sent", async () => {
    const { fake, result } = run(first, { locked: false })
    expect(await result).toMatchObject({
      ok: false,
      diagnostic: { code: "maintenance.busy" },
    })
    expect(fake.statements()).toHaveLength(1)
  })

  it.each<[string, State, Record<string, unknown>]>([
    ["another hash", { hash: "f".repeat(64) }, { applied: "f".repeat(64) }],
    ["no applied state", { hash: null }, { applied: "none" }],
    [
      "no hash function",
      { hash: new ApplyDbError("function does not exist", "42883") },
      { applied: "none" },
    ],
    [
      "no platform schema",
      { hash: new ApplyDbError("schema does not exist", "3F000") },
      { applied: "none" },
    ],
  ])(
    "model-mismatch on %s: the maintenance mode is never set",
    async (_, state, params) => {
      const { fake, result } = run(first, state)
      expect(await result).toMatchObject({
        ok: false,
        diagnostic: {
          code: "maintenance.model-mismatch",
          params: { ...params, compiled: model.hash },
        },
      })
      expect(fake.statements().some(isMode)).toBe(false)
      expect(fake.log.at(-1)).toBe("ROLLBACK")
    }
  )

  it.each<
    [string, RightsMaintenanceRequest, State, string, Record<string, unknown>]
  >([
    [
      "unknown user",
      first,
      { user: null },
      "maintenance.unknown-user",
      { user: USER },
    ],
    [
      "invalid user",
      first,
      { user: { invalid: true } },
      "maintenance.not-effective",
      { user: USER },
    ],
    [
      "a live global assignment",
      first,
      { assigned: true },
      "maintenance.not-first",
      {},
    ],
    [
      "a global holder",
      restore,
      { holder: true },
      "maintenance.holder-exists",
      { level: "global" },
    ],
    [
      "no scope root",
      tenant(),
      { root: false },
      "maintenance.scope-missing",
      { scope: SCOPE },
    ],
    [
      "a scope holder",
      tenant(),
      { holder: true },
      "maintenance.holder-exists",
      { level: "scope:org" },
    ],
    [
      "a member given for an existing member",
      tenant({ member: { description: "x" } }),
      { member: MEMBER },
      "maintenance.invalid-member",
      { path: "member" },
    ],
  ])(
    "%s: refused before any write",
    async (_, request, state, code, params) => {
      const { fake, result } = run(request, state)
      expect(await result).toMatchObject({
        ok: false,
        diagnostic: { code, params },
      })
      const sent = fake.statements()
      expect(sent.some(isMode)).toBe(false)
      expect(sent.some((s) => isWrite(s.sql))).toBe(false)
      expect(fake.log.at(-1)).toBe("ROLLBACK")
    }
  )

  it("assigns the role to an existing member without a new member row", async () => {
    const { fake, result } = run(tenant(), { member: MEMBER })
    expect(await result).toEqual({
      ok: true,
      done: { assignment: NEW_ID, member: MEMBER },
    })
    const writes = fake.statements().filter((s) => isWrite(s.sql))
    expect(writes).toHaveLength(1)
    expect(writes[0]!.params).toContain(MEMBER)
  })

  it.each<[string, () => CompiledModel]>([
    ["an adopted membership source", () => adopted],
    [
      "a membership catalog without a runtime core",
      () => {
        const membership = model.contracts.membership[0]!
        return {
          ...model,
          catalogCommands: model.catalogCommands.filter(
            (c) => c.objectId !== membership.objectId
          ),
        }
      },
    ],
  ])("%s: no-catalog only on the insert branch", async (_, on) => {
    const missing = run(tenant(), { member: null }, on())
    expect(await missing.result).toMatchObject({
      ok: false,
      diagnostic: {
        code: "maintenance.no-catalog",
        params: { level: "scope:org" },
      },
    })
    expect(missing.fake.statements().some(isMode)).toBe(false)
    expect(missing.fake.statements().some((s) => isWrite(s.sql))).toBe(false)
    const existing = run(tenant(), { member: MEMBER }, on())
    expect(await existing.result).toEqual({
      ok: true,
      done: { assignment: NEW_ID, member: MEMBER },
    })
  })
})

describe("runRightsMaintenance: database errors", () => {
  const atCommit = (error: Error): State => ({ commit: error })

  it.each<[string, State, Record<string, unknown>]>([
    [
      "a guard refusal at COMMIT",
      atCommit(
        new ApplyDbError("command.forbidden", "42501", {
          detail: "rights-context",
        })
      ),
      { reason: "rights-context" },
    ],
    [
      "a context refusal",
      atCommit(
        new ApplyDbError("command.context", "42501", { detail: "missing" })
      ),
      { reason: "missing" },
    ],
    [
      "a reason detail under a message off the whitelist",
      atCommit(
        new ApplyDbError("permission denied for table x", "42501", {
          detail: "escalation",
        })
      ),
      { reason: "denied" },
    ],
    [
      "a detail off the whitelist under a guard message",
      atCommit(
        new ApplyDbError("command.forbidden", "42501", { detail: "secret" })
      ),
      { reason: "denied" },
    ],
  ])("42501 — %s → maintenance.refused", async (_, state, params) => {
    const { result } = run(first, state)
    expect(await result).toMatchObject({
      ok: false,
      diagnostic: { code: "maintenance.refused", params },
    })
  })

  it("23502 on the member row names the attribute", async () => {
    const membership = model.contracts.membership[0]!
    const object = buildRuntimeCatalog(model).objects.find(
      (o) => o.id === membership.objectId
    )!
    const description = object.attributes.find((a) => a.name === "description")!
    const { result } = run(tenant(), {
      fail: {
        when: (sql) => isWrite(sql) && sql.includes("jsonb_populate_record"),
        error: new ApplyDbError("null value", "23502", {
          table: membership.table.name,
          column: description.column,
        }),
      },
    })
    expect(await result).toMatchObject({
      ok: false,
      diagnostic: {
        code: "maintenance.member-required",
        params: { attribute: "description" },
      },
    })
  })

  it("a connection lost after the body is outcome-unknown", async () => {
    const { result } = run(first, atCommit(new ApplyConnectionLost("gone")))
    expect(await result).toMatchObject({
      ok: false,
      diagnostic: { code: "maintenance.outcome-unknown" },
    })
  })

  it.each<[string, Error]>([
    ["a connection lost before the body ends", new ApplyConnectionLost("gone")],
    ["another database error", new ApplyDbError("duplicate key", "23505")],
  ])("%s propagates", async (_, error) => {
    const { result } = run(first, {
      fail: { when: (sql) => isWrite(sql), error },
    })
    await expect(result).rejects.toBe(error)
  })
})
