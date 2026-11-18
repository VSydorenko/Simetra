import { beforeAll, describe, expect, it } from "vitest"
import {
  buildRuntimeCatalog,
  compile,
  type CompileResult,
  type CompiledModel,
} from "simetra/compiler"
import { ZERO_UUID, objectTable } from "simetra/model"
import { buildCatalogCommandUnits } from "../catalog-command/units"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import { commandContractOf } from "./fixtures/catalog-command"
import { readReferenceDomain } from "./fixtures/reference-domain"
import {
  ORG_KIND_ID,
  adminRoles,
  commandCoreLayer,
  compileRights,
  policyDomain,
  rootCreationDomain,
  writeRoles,
} from "./fixtures/rights"
import { bodyShape, loadShapeParsers, nodes, tree } from "./fixtures/sql-shape"

/**
 * Виклик сигналу в ядрі команд (спека П4-B §8.2): де саме в тілі стоїть
 * `PERFORM simetra.signal(…)`, з якими аргументами і в яких об'єктів його
 * немає. Що з ним робить Postgres — DB-тест `signal-core`.
 */

let parse: SqlParser
let plpgsql: PlpgsqlParser
let core: CompiledModel
let roots: CompiledModel
beforeAll(async () => {
  await loadShapeParsers()
  parse = await loadSqlParser()
  plpgsql = await loadPlpgsqlParser()
  core = await compiled(
    compileRights(policyDomain(writeRoles(), adminRoles(), commandCoreLayer()))
  )
  roots = await compiled(compileRights(rootCreationDomain()))
})

async function compiled(
  result: CompileResult | Promise<CompileResult>
): Promise<CompiledModel> {
  const { model, diagnostics } = await result
  expect(diagnostics).toEqual([])
  return model!
}

const sqlOf = (model: CompiledModel, identity: string) => {
  const unit = model.sqlUnits.find(
    (u) => u.identity === `function:public.${identity}`
  )
  expect(unit, identity).toBeDefined()
  return unit!.sql
}
const objectIdOf = (model: CompiledModel, table: string) =>
  objectTable(model.physical.tables.find((t) => t.name === table)!).origin
    .objectId

type Shape = ReturnType<typeof bodyShape>
/** Індекси операторів з викликом `simetra.signal`. */
const signalCalls = (shape: Shape) =>
  shape.flatMap((s, i) =>
    s.type === "perform" &&
    JSON.stringify(s.expressions[0]?.tree).includes('{"sval":"signal"}')
      ? [i]
      : []
  )
const hasSignal = (sql: string) => signalCalls(bodyShape(sql)).length > 0
const dmlAt = (shape: Shape) =>
  shape.flatMap((s, i) =>
    ["InsertStmt", "UpdateStmt", "DeleteStmt"].some(
      (kind) => nodes(s.expressions[0]?.tree, kind).length > 0
    )
      ? [i]
      : []
  )
const call = (args: string) => tree(`SELECT simetra.signal(${args})`)

describe("command core: the signal call", () => {
  it("save signals after the header and tabular DML with the version after, right before the result", () => {
    const shape = bodyShape(sqlOf(core, "ticket_save(jsonb,int8)"))
    const calls = signalCalls(shape)
    expect(calls).toHaveLength(1)
    const [at] = calls as [number]
    // Ticket має ТЧ: останній DML — рядки ТЧ, і сигнал іде після нього.
    expect(Math.max(...dmlAt(shape))).toBeLessThan(at)
    expect(shape[at]!.depth).toBe(1)
    expect(shape[at + 1]!.target).toEqual({ variable: "v_result" })
    expect(shape[at]!.expressions[0]!.tree).toEqual(
      call(
        `'${objectIdOf(core, "ticket")}'::uuid, '${ORG_KIND_ID}'::uuid, v_row.org_id, jsonb_build_object('id', v_row.id), v_row.version, CASE WHEN p_expected_version IS NULL THEN 'create' ELSE 'update' END`
      )
    )
  })

  it("mark_deletion signals after the UPDATE and its row count check", () => {
    const shape = bodyShape(sqlOf(core, "ticket_mark_deletion(uuid,int8,bool)"))
    const [at] = signalCalls(shape) as [number]
    const update = Math.max(...dmlAt(shape))
    expect(shape[update + 1]!.type).toBe("getdiag")
    // getdiag → IF v_count = 0 → RAISE → сигнал.
    expect(at).toBe(update + 4)
    expect(shape[at]!.expressions[0]!.tree).toEqual(
      call(
        `'${objectIdOf(core, "ticket")}'::uuid, '${ORG_KIND_ID}'::uuid, v_row.org_id, jsonb_build_object('id', v_row.id), v_row.version, 'markDeletion'`
      )
    )
  })

  it("an unscoped object signals into the zero scope", () => {
    const shape = bodyShape(sqlOf(core, "global_roles_save(jsonb,int8)"))
    const [at] = signalCalls(shape) as [number]
    const zero = `'${ZERO_UUID}'::uuid`
    expect(shape[at]!.expressions[0]!.tree).toEqual(
      call(
        `'${objectIdOf(core, "global_roles")}'::uuid, ${zero}, ${zero}, jsonb_build_object('id', v_row.id), v_row.version, CASE WHEN p_expected_version IS NULL THEN 'create' ELSE 'update' END`
      )
    )
  })

  it("Users never signal", () => {
    expect(hasSignal(sqlOf(core, "users_save(jsonb,int8)"))).toBe(false)
  })

  it("an object whose key is not a single uuid column never signals", () => {
    const contract = commandContractOf(core, "ticket", { parse, plpgsql })
    const save = (physical: CompiledModel["physical"]) =>
      buildCatalogCommandUnits({
        catalogCommands: [contract],
        contracts: core.contracts,
        scopeKinds: core.scopeKinds,
        physical,
        attributeCase: core.project.naming.attributeCase,
        provider: core.project.database.provider,
        module: "app",
        units: core.sqlUnits,
        parse,
        plpgsql,
      }).find((u) => u.identity === "function:public.ticket_save(jsonb,int8)")!
        .sql
    const textKey = {
      ...core.physical,
      tables: core.physical.tables.map((t) =>
        t.name === "ticket"
          ? {
              ...t,
              columns: t.columns.map((c) =>
                c.name === "id" ? { ...c, type: "text" } : c
              ),
            }
          : t
      ),
    }
    // Контроль: той самий вхід з ключем `uuid` сигнал шле.
    expect(hasSignal(save(core.physical))).toBe(true)
    expect(hasSignal(save(textKey))).toBe(false)
  })

  it("the root signals into its own channel: the scope is its id", () => {
    const shape = bodyShape(sqlOf(roots, "organization_save(jsonb,int8)"))
    const [at] = signalCalls(shape) as [number]
    expect(shape[at]!.expressions[0]!.tree).toEqual(
      call(
        `'${objectIdOf(roots, "organization")}'::uuid, '${ORG_KIND_ID}'::uuid, v_row.id, jsonb_build_object('id', v_row.id), v_row.version, CASE WHEN p_expected_version IS NULL THEN 'create' ELSE 'update' END`
      )
    )
  })

  it("create_root with a root creator signals last, after the grant and the reads, with the inserted version", () => {
    const shape = bodyShape(
      sqlOf(roots, "organization_create_root(jsonb,jsonb,uuid)")
    )
    const calls = signalCalls(shape)
    expect(calls).toHaveLength(1)
    const [at] = calls as [number]
    const grant = shape.findIndex(
      (s) =>
        s.type === "perform" &&
        JSON.stringify(s.expressions[0]?.tree) ===
          JSON.stringify(
            tree(
              "SELECT simetra.org_id_root_creator(v_in.id, p_member_id, p_member)"
            )
          )
    )
    const memberRead = shape.findIndex(
      (s) => s.target?.variable === "v_member_row"
    )
    expect(grant).toBeGreaterThan(0)
    expect(memberRead).toBeGreaterThan(grant)
    expect(at).toBeGreaterThan(memberRead)
    expect(shape[at]!.depth).toBe(1)
    expect(shape[at + 1]!.type).toBe("return")
    expect(shape).toHaveLength(at + 2)
    expect(shape[at]!.expressions[0]!.tree).toEqual(
      call(
        `'${objectIdOf(roots, "organization")}'::uuid, '${ORG_KIND_ID}'::uuid, v_in.id, jsonb_build_object('id', v_in.id), v_root_version::bigint, 'create'`
      )
    )
  })

  // Р8 плану B2: у моделі оператора актор нового скоупу не читає, і режим
  // відправки відхилив би сигнал — разом із командою.
  it("create_root of the operator model has no signal call", () => {
    expect(
      hasSignal(sqlOf(roots, "branch_create_root(jsonb,jsonb,uuid)"))
    ).toBe(false)
    expect(hasSignal(sqlOf(roots, "branch_save(jsonb,int8)"))).toBe(true)
  })

  it("the core requires the signal function unit", () => {
    const unit = core.sqlUnits.find(
      (u) => u.identity === "function:public.ticket_save(jsonb,int8)"
    )!
    const signal = core.sqlUnits.find(
      (u) =>
        u.class === "function" &&
        u.identity.startsWith("function:simetra.signal(")
    )!
    expect(unit.requires).toContainEqual({
      type: "unit",
      identity: signal.identity,
    })
  })
})

// Одне джерело (спека П4-B §8.3): ознака `signal` каталогу рантайму — рівно
// наявність виклику в ядрі, над справжнім доменом прикладу.
describe("the signal flag of the reference domain", () => {
  it("equals the presence of the call in every command core function", async () => {
    const result = await compile(readReferenceDomain())
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const model = result.model!
    // Ядро створення кореня без творця сигналу не шле за задумом (Р8).
    const withoutCreator = new Set(
      model.scopeKinds.flatMap((k) =>
        "objectId" in k.root && k.rootCreator === undefined
          ? [k.root.objectId]
          : []
      )
    )
    const functions = model.sqlUnits.filter(
      (u) => u.generator === "catalogCommand" && u.class === "function"
    )
    const flags = buildRuntimeCatalog(model).objects.flatMap((object) => {
      const own = functions.filter(
        (u) =>
          u.ownerObjectId === object.id &&
          // Перевірка рядка членства — не ядро запису.
          !u.identity.includes("_simetra_member_check(")
      )
      if (own.length === 0) return []
      return own.map((u) => ({
        fn: u.identity,
        signal:
          object.signal &&
          !(
            u.identity.includes("_create_root(") &&
            withoutCreator.has(object.id)
          ),
        call: hasSignal(u.sql),
      }))
    })
    // Обидві гілки представлено: інакше рівність нічого б не доводила.
    expect(flags.some((f) => f.signal)).toBe(true)
    expect(flags.some((f) => !f.signal)).toBe(true)
    expect(flags.filter((f) => f.call !== f.signal)).toEqual([])
  })
})
