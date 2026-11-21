import { beforeAll, describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  DATABASE_PROVIDERS,
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  SIGNAL_NOTIFY_CHANNEL,
  SIGNAL_OUTBOX,
  SIGNAL_PAYLOAD_MAX_BYTES,
  type DatabaseProvider,
} from "simetra/model"
import { SIGNAL_OUTBOX_TRIGGERS } from "../platform/outbox"
import { bodyShape, loadShapeParsers, nodes, tree } from "./fixtures/sql-shape"
import { catalog, metaFiles, project, uuid } from "./helpers"

/**
 * Outbox сигналів (спека профілю `postgres` §5.1–§5.2): таблиця знімка з
 * платформним походженням і одиниці шару — у кожному проєкті, гранти — за
 * профілем провайдера.
 */

beforeAll(loadShapeParsers)

const TABLE = `${SIGNAL_OUTBOX.schema}.${SIGNAL_OUTBOX.name}`

async function compiled(
  provider: DatabaseProvider,
  entries: Record<string, unknown> = {}
): Promise<CompiledModel> {
  const result = await compile(
    metaFiles({
      "project.meta.json": project({ database: { provider } }),
      "catalogs/Currency/Currency.meta.json": catalog("Currency"),
      ...entries,
    })
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

const outboxOf = (model: CompiledModel) =>
  model.physical.tables.find(
    (t) => t.schema === SIGNAL_OUTBOX.schema && t.name === SIGNAL_OUTBOX.name
  )

const unitsOn = (model: CompiledModel) =>
  model.sqlUnits.filter((u) => u.generator === "signalOutbox")

const checkOf = (model: CompiledModel, label: string) =>
  outboxOf(model)!.checks.find(
    (c) => c.name === `${SIGNAL_OUTBOX.name}_${label}_check`
  )!.expression

const exprTree = (expression: string) => tree(`SELECT ${expression}`)

describe("signal outbox", () => {
  it.each(DATABASE_PROVIDERS)(
    "%s: is a snapshot table of the platform without an object, in a project without users",
    async (provider) => {
      const model = await compiled(provider)
      const table = outboxOf(model)
      expect(table).toBeDefined()
      expect(table!.origin).toEqual({ part: "signalOutbox" })
      expect(table!.rowLevelSecurity).toBe("enabled")
      expect(table!.primaryKey?.columns).toEqual(["id"])
      expect(
        table!.columns.map((c) => [
          c.name,
          c.type,
          c.notNull,
          c.default ?? null,
          c.identity?.generation ?? null,
        ])
      ).toEqual([
        ["id", "bigint", true, null, "always"],
        ["method", "text", true, null, null],
        ["payload", "jsonb", true, null, null],
        ["partition", "integer", true, "0", null],
        ["created_at", "timestamp with time zone", true, "now()", null],
      ])
      expect(unitsOn(model).length).toBeGreaterThan(0)
    }
  )

  it("the CHECKs close the method, the partition and the payload size in octets", async () => {
    const model = await compiled("postgres")
    expect(exprTree(checkOf(model, "method"))).toEqual(
      exprTree("method = 'publish'")
    )
    expect(exprTree(checkOf(model, "partition"))).toEqual(
      exprTree("partition = 0")
    )
    expect(exprTree(checkOf(model, "size"))).toEqual(
      exprTree(`octet_length(payload::text) <= ${SIGNAL_PAYLOAD_MAX_BYTES}`)
    )
    // Прив'язка до `id` (Р13) — обидва ключі, кожен рядком; під `IS TRUE`:
    // `NULL` відсутнього ключа не пропускає рядок
    expect(exprTree(checkOf(model, "id"))).toEqual(
      exprTree(
        "(jsonb_typeof(payload -> 'idempotency_key') = 'string'" +
          " AND (payload ->> 'idempotency_key') = id::text" +
          " AND jsonb_typeof(payload -> 'data' -> 'id') = 'string'" +
          " AND (payload -> 'data' ->> 'id') = id::text) IS TRUE"
      )
    )
    // Форма — теж під `IS TRUE`; поведінку кожної її умови доводить DB-тест
    expect(
      nodes(exprTree(checkOf(model, "payload")), "BooleanTest")
    ).toHaveLength(1)
  })

  it("creation order: the table before its triggers, policies, grants and prune", async () => {
    const model = await compiled("postgres")
    const order = model.creationOrder.map((node) =>
      node.type === "unit"
        ? node.identity
        : `${node.type}:${node.schema}.${node.name}`
    )
    const table = order.indexOf(`table:${TABLE}`)
    expect(table).toBeGreaterThanOrEqual(0)
    const prune = `function:${SIGNAL_OUTBOX.schema}.signal_outbox_prune("interval")`
    const after = unitsOn(model)
      .filter(
        (u) =>
          u.class === "trigger" ||
          u.class === "policy" ||
          u.identity === prune ||
          (u.class === "grant" && u.sql.includes(` TABLE ${TABLE} `))
      )
      .map((u) => u.identity)
    expect(after.length).toBeGreaterThan(0)
    for (const identity of after)
      expect(order.indexOf(identity), identity).toBeGreaterThan(table)
    // Тіло plpgsql граф не читає: ребро до таблиці `prune` називає явно
    expect(model.sqlUnits.find((u) => u.identity === prune)?.requires).toEqual([
      { type: "table", ...SIGNAL_OUTBOX },
    ])
  })

  it("stamp — BEFORE INSERT per row, notify — AFTER INSERT per statement", async () => {
    const model = await compiled("postgres")
    const trigger = (name: string) => {
      const unit = model.sqlUnits.find(
        (u) => u.identity === `trigger:${TABLE}.${name}`
      )
      expect(unit, name).toBeDefined()
      return nodes(tree(unit!.sql), "CreateTrigStmt")[0] as {
        row?: boolean
        timing?: number
        events?: number
      }
    }
    const stamp = trigger(SIGNAL_OUTBOX_TRIGGERS.stamp)
    const notify = trigger(SIGNAL_OUTBOX_TRIGGERS.notify)
    // Postgres: TRIGGER_TYPE_BEFORE = 2, TRIGGER_TYPE_INSERT = 4; AFTER — 0.
    expect([stamp.row, stamp.timing, stamp.events]).toEqual([true, 2, 4])
    expect([notify.row ?? false, notify.timing ?? 0, notify.events]).toEqual([
      false,
      0,
      4,
    ])
    const notifyFn = model.sqlUnits.find(
      (u) =>
        u.identity === `function:${SIGNAL_OUTBOX.schema}.signal_outbox_notify()`
    )!
    expect(JSON.stringify(bodyShape(notifyFn.sql))).toContain(
      SIGNAL_NOTIFY_CHANNEL
    )
  })

  it.each(DATABASE_PROVIDERS)(
    "%s: grants — command inserts two columns, the consumer reads and deletes, nobody else anything",
    async (provider) => {
      const model = await compiled(provider)
      const q = (role: string) => `"${role}"`
      const api = Object.values(PROVIDER_API_ROLES[provider]).filter(
        (role): role is string => typeof role === "string"
      )
      const sequence = `${TABLE}_id_seq`
      const functions = [
        `${SIGNAL_OUTBOX.schema}.signal_outbox_stamp()`,
        `${SIGNAL_OUTBOX.schema}.signal_outbox_notify()`,
        `${SIGNAL_OUTBOX.schema}.signal_outbox_prune(interval)`,
      ]
      const consumer = q(PLATFORM_ROLES.signalConsumer)
      const expected = [
        `REVOKE ALL ON TABLE ${TABLE} FROM PUBLIC;`,
        ...api.map((role) => `REVOKE ALL ON TABLE ${TABLE} FROM ${q(role)};`),
        `REVOKE ALL ON SEQUENCE ${sequence} FROM PUBLIC;`,
        ...api.map(
          (role) => `REVOKE ALL ON SEQUENCE ${sequence} FROM ${q(role)};`
        ),
        `GRANT INSERT (method, payload) ON TABLE ${TABLE} TO ${q(PLATFORM_ROLES.command)};`,
        `GRANT USAGE ON SCHEMA "${SIGNAL_OUTBOX.schema}" TO ${consumer};`,
        `GRANT SELECT ON TABLE ${TABLE} TO ${consumer};`,
        `GRANT DELETE ON TABLE ${TABLE} TO ${consumer};`,
        ...functions.flatMap((fn) => [
          `REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC;`,
          ...api.map(
            (role) => `REVOKE EXECUTE ON FUNCTION ${fn} FROM ${q(role)};`
          ),
        ]),
      ].map(tree)
      const grants = unitsOn(model)
        .filter((u) => u.class === "grant")
        .map((u) => tree(u.sql))
      expect(grants).toHaveLength(expected.length)
      expect(grants).toEqual(expect.arrayContaining(expected))
      const policies = unitsOn(model)
        .filter((u) => u.class === "policy")
        .map((u) => tree(u.sql))
      expect(policies).toEqual(
        expect.arrayContaining(
          ["SELECT", "DELETE"].map((command) =>
            tree(
              `CREATE POLICY signal_outbox_consumer_${command.toLowerCase()} ON ${TABLE} FOR ${command} TO ${consumer} USING (true);`
            )
          )
        )
      )
      expect(policies).toHaveLength(2)
    }
  )

  it("is the same with a users catalog", async () => {
    const plain = await compiled("supabase")
    const withUsers = await compiled("supabase", {
      "catalogs/Users/Users.meta.json": catalog("Users", {
        id: uuid(70),
        role: "users",
        scope: "none",
      }),
    })
    expect(outboxOf(withUsers)).toEqual(outboxOf(plain))
    expect(unitsOn(withUsers).map((u) => u.sql)).toEqual(
      unitsOn(plain).map((u) => u.sql)
    )
  })
})
