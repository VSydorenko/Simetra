import { beforeAll, describe, expect, it } from "vitest"
import { compile, type CompiledModel, type Diagnostic } from "simetra/compiler"
import { PLATFORM_ROLES, PROVIDER_API_ROLES } from "simetra/model"
import { isSignalObject } from "../access-units"
import { SIGNAL_FUNCTIONS, SIGNAL_INSERT_POLICY } from "../signal/units"
import {
  ANNOUNCEMENT_ID,
  ORG_KIND_ID,
  TASK_ID,
  compileRights,
  policyDomain,
  promotableTaskNote,
  writeRoles,
} from "./fixtures/rights"
import { acceptDebt, catalog, metaFiles, project, uuid } from "./helpers"

/**
 * Генератор `signal` (спека П4-B §8.2, §8.3): оракул каналу, правило форми
 * сигналу й політика `INSERT` outbox. Що Postgres з ними робить — DB-тест
 * `signal-topic-allowed`; тут — текст і гранти, які дає компілятор.
 */

const USERS_ID = uuid(6003)
const ORGANIZATION_ID = uuid(6002)
const COMMAND = PLATFORM_ROLES.command

let model: CompiledModel
const signalUnits = () => model.sqlUnits.filter((u) => u.generator === "signal")
const functionSql = (name: string) =>
  signalUnits().find(
    (u) =>
      u.class === "function" &&
      u.identity.startsWith(`function:simetra.${name}(`)
  )!.sql
/** Гілки оракула: UUID об'єкта → умова гілки. */
const branches = () =>
  new Map(
    [
      ...functionSql(SIGNAL_FUNCTIONS.topicAllowed.name).matchAll(
        /^ {4}WHEN '([0-9a-f-]+)'::uuid THEN (.*)$/gm
      ),
    ].map(([, id, condition]) => [id!, condition!])
  )

beforeAll(async () => {
  const result = await compileRights(policyDomain(writeRoles()))
  expect(result.diagnostics).toEqual([])
  model = result.model!
})

describe("signal authorization units", () => {
  it("grants EXECUTE on the topic oracle only to the command and user roles, the shape rule only to the command role (Р10, Р15)", () => {
    const roles = PROVIDER_API_ROLES.supabase
    const topic = "simetra.signal_topic_allowed(text, boolean)"
    const payload = "simetra.signal_payload_allowed(jsonb)"
    expect(
      signalUnits()
        .filter((u) => u.class === "grant")
        .map((u) => u.sql)
        .sort()
    ).toEqual(
      [
        `REVOKE EXECUTE ON FUNCTION ${topic} FROM PUBLIC;`,
        `REVOKE EXECUTE ON FUNCTION ${topic} FROM ${roles.anonymous};`,
        `REVOKE EXECUTE ON FUNCTION ${topic} FROM ${roles.service};`,
        `GRANT EXECUTE ON FUNCTION ${topic} TO ${roles.user};`,
        `GRANT EXECUTE ON FUNCTION ${topic} TO ${COMMAND};`,
        `REVOKE EXECUTE ON FUNCTION ${payload} FROM PUBLIC;`,
        `REVOKE EXECUTE ON FUNCTION ${payload} FROM ${roles.anonymous};`,
        `REVOKE EXECUTE ON FUNCTION ${payload} FROM ${roles.user};`,
        `REVOKE EXECUTE ON FUNCTION ${payload} FROM ${roles.service};`,
        `GRANT EXECUTE ON FUNCTION ${payload} TO ${COMMAND};`,
      ].sort()
    )
  })

  it("the topic oracle is SECURITY DEFINER, the shape rule SECURITY INVOKER, both STABLE with an empty search_path", () => {
    const head = (sql: string) => sql.split("\nAS ")[0]
    expect(head(functionSql(SIGNAL_FUNCTIONS.topicAllowed.name))).toBe(
      "CREATE OR REPLACE FUNCTION simetra.signal_topic_allowed(p_topic text, p_send boolean)\nRETURNS boolean\nLANGUAGE plpgsql STABLE SECURITY DEFINER\nSET search_path = ''"
    )
    expect(head(functionSql(SIGNAL_FUNCTIONS.payloadAllowed.name))).toBe(
      "CREATE OR REPLACE FUNCTION simetra.signal_payload_allowed(p_payload jsonb)\nRETURNS boolean\nLANGUAGE plpgsql STABLE SECURITY INVOKER\nSET search_path = ''"
    )
  })

  it("has a branch for every signal object and none for Users", () => {
    const ids = [...branches().keys()]
    expect(ids).toContain(TASK_ID)
    expect(ids).toContain(ANNOUNCEMENT_ID)
    expect(ids).toContain(ORGANIZATION_ID)
    expect(ids).not.toContain(USERS_ID)
    // Одне рішення для оракула й каталогу рантайму (спека П4-B §8.3).
    const signal = [...new Set(model.contracts.access.map((a) => a.objectId))]
      .filter((id) => isSignalObject(model, id))
      .sort()
    expect(ids).toEqual(signal)
  })

  it("subscribes to a scoped object by the scope and a row-free read right, without the container (invariant 8)", () => {
    const scope =
      "v_scope = ANY (ARRAY(SELECT public.org_member_member_scopes()))"
    const read = (fn: string, extra = "") =>
      `v_scope = ANY (ARRAY(SELECT simetra.${fn}('read', 'task'${extra})))`
    expect(branches().get(TASK_ID)).toBe(
      `v_kind = '${ORG_KIND_ID}'::uuid AND CASE WHEN p_send THEN ${scope} ELSE ${scope} AND (${read("rights_any")} OR ${read("rights_own")} OR ${read("rights_dim", ", '00000000-0000-4000-8000-000000006060'::uuid")}) END`
    )
    expect(functionSql(SIGNAL_FUNCTIONS.topicAllowed.name)).not.toMatch(
      /rights_container/
    )
  })

  it("subscribes to an unscoped object by has_right with the zero scope", () => {
    const zero = "'00000000-0000-0000-0000-000000000000'::uuid"
    expect(branches().get(ANNOUNCEMENT_ID)).toBe(
      `v_kind = ${zero} AND CASE WHEN p_send THEN v_scope = ${zero} ELSE v_scope = ${zero} AND ((SELECT simetra.has_right('read', 'announcement', 'any', NULL))) END`
    )
  })

  it("lets the command role insert into the outbox only through the shape rule (Р15)", () => {
    expect(
      signalUnits()
        .filter((u) => u.class === "policy")
        .map((u) => u.sql)
    ).toEqual([
      `CREATE POLICY ${SIGNAL_INSERT_POLICY} ON simetra.signal_outbox FOR INSERT TO ${COMMAND} WITH CHECK (simetra.signal_payload_allowed(payload));`,
    ])
  })

  it("generates nothing without rights functions", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Item/Item.meta.json": catalog("Item"),
      })
    )
    expect(result.diagnostics).toEqual([])
    expect(
      result.model!.sqlUnits.filter((u) => u.generator === "signal")
    ).toEqual([])
  })
})

describe("application SQL writes no signal (invariant 7)", () => {
  const EXTRA = "sql/public/extra.sql"
  const plpgsql = (body: string) =>
    `CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${body}; END $$`
  const codes = (diagnostics: readonly Diagnostic[]) =>
    diagnostics.map((d) => d.code)

  it.each([
    {
      name: "an outbox insert (Rule 1)",
      body: `INSERT INTO simetra.signal_outbox (method, payload) VALUES ('publish', '{}')`,
      code: "sql.kind-table-verbatim",
    },
    {
      name: "a signal call",
      body: "PERFORM simetra.signal(NULL, NULL, NULL, NULL, NULL, NULL)",
      code: "sql.platform-function-call",
    },
    {
      name: "a topic oracle call",
      body: "PERFORM simetra.signal_topic_allowed('x', true)",
      code: "sql.platform-function-call",
    },
  ])("$name → $code", async ({ body, code }) => {
    const files = policyDomain(promotableTaskNote())
    files.set(EXTRA, plpgsql(body))
    const result = await compile(await acceptDebt(files))
    expect(codes(result.diagnostics)).toEqual([code])
  })
})
