import { beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import {
  COMMAND_SETTING,
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
} from "simetra/model"
import { COMMAND_FUNCTIONS } from "../rights/command-units"
import { hasEmptySearchPath, routineLanguage } from "../sql/closed-forms"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import { withoutLocations, type SqlUnit } from "../sql/units"
import {
  REASSIGN_ACTION_ID,
  compileRights,
  policyDomain,
  rightsFiles,
  withRoles,
  writeRoles,
} from "./fixtures/rights"
import { nodes } from "./fixtures/sql-shape"

let parse: SqlParser
let plpgsql: PlpgsqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
  plpgsql = await loadPlpgsqlParser()
})

const commandUnits = (model: CompiledModel) =>
  model.sqlUnits.filter((u) => u.generator === "command")

const functions = (model: CompiledModel) =>
  commandUnits(model).filter((u) => u.class === "function")

const byName = (model: CompiledModel, name: string): SqlUnit => {
  const found = functions(model).filter((u) => u.name === name)
  expect(found, name).toHaveLength(1)
  return found[0]!
}

interface CreateFunction {
  options?: {
    DefElem?: {
      defname?: string
      arg?: { String?: { sval?: string }; Boolean?: { boolval?: boolean } }
    }
  }[]
}

const option = (unit: SqlUnit, name: string) =>
  (
    (unit.tree as { CreateFunctionStmt: CreateFunction }).CreateFunctionStmt
      .options ?? []
  ).find((o) => o.DefElem?.defname === name)?.DefElem?.arg

/** Дерева виразів тіла plpgsql: кожен вираз чи запит як розібране дерево. */
function bodyTrees(unit: SqlUnit): unknown[] {
  const parsed = plpgsql(unit.sql)
  if (!parsed.ok || parsed.fn === undefined)
    throw new Error(`body does not parse: ${unit.identity}`)
  return parsed.fn.statements.flatMap((s) =>
    s.expressions.map((e) => {
      // Присвоєння несе вираз із ціллю: ціль не частина виразу.
      const query =
        s.type === "assign" ? e.query.replace(/^.*?:=/, "") : e.query
      const sql = e.parseMode === 0 ? query : `SELECT ${query}`
      const result = parse(sql)
      if (!result.ok) throw new Error(`does not parse: ${sql}`)
      return withoutLocations(result.statements[0]!.stmt)
    })
  )
}

/** Виклики функцій тіла: останнє ім'я й сталі аргументи (boolean чи текст). */
function calls(unit: SqlUnit): { name: string; args: unknown[] }[] {
  return nodes(bodyTrees(unit), "FuncCall").map((call) => {
    const c = call as {
      funcname: { String: { sval: string } }[]
      args?: { A_Const?: { boolval?: { boolval?: boolean } } }[]
    }
    return {
      name: c.funcname.at(-1)!.String.sval,
      // protobuf не пише `false`: порожній об'єкт `boolval` — це `false`.
      args: (c.args ?? []).map((a) =>
        a.A_Const?.boolval === undefined
          ? null
          : (a.A_Const.boolval.boolval ?? false)
      ),
    }
  })
}

function granted(model: CompiledModel) {
  const grants = new Map<string, string[]>()
  const revoked = new Map<string, string[]>()
  for (const unit of commandUnits(model)) {
    const grant = (
      unit.tree as {
        GrantStmt?: {
          is_grant?: boolean
          objects: {
            ObjectWithArgs: { objname: { String: { sval: string } }[] }
          }[]
          grantees: { RoleSpec: { roletype: string; rolename?: string } }[]
        }
      }
    ).GrantStmt
    if (grant === undefined) continue
    const fn = grant.objects[0]!.ObjectWithArgs.objname.at(-1)!.String.sval
    const target = grant.is_grant === true ? grants : revoked
    for (const { RoleSpec } of grant.grantees) {
      const role =
        RoleSpec.roletype === "ROLESPEC_PUBLIC" ? "PUBLIC" : RoleSpec.rolename!
      target.set(fn, [...(target.get(fn) ?? []), role].sort())
    }
  }
  return { granted: grants, revoked }
}

describe("buildCommandUnits", () => {
  it("renders no command functions without rights functions", async () => {
    const result = await compileRights(rightsFiles())
    expect(commandUnits(result.model!)).toEqual([])
  })

  it("declares the command functions closed, invoker and for the command role only", async () => {
    const model = (await compileRights(withRoles())).model!
    expect(functions(model).map((u) => u.identity)).toEqual([
      "function:simetra.command_action()",
      "function:simetra.command_current()",
      "function:simetra.command_parsed(bool)",
      "function:simetra.command_root(text)",
    ])
    const { granted: grants, revoked } = granted(model)
    const api = Object.values(PROVIDER_API_ROLES.supabase)
    for (const unit of functions(model)) {
      expect(routineLanguage(unit.tree as never), unit.name).toBe("plpgsql")
      expect(hasEmptySearchPath(unit.tree as never), unit.name).toBe(true)
      expect(option(unit, "volatility")?.String?.sval, unit.name).toBe("stable")
      expect(option(unit, "security")?.Boolean?.boolval, unit.name).not.toBe(
        true
      )
      expect(grants.get(unit.name), unit.name).toEqual([PLATFORM_ROLES.command])
      expect(revoked.get(unit.name), unit.name).toEqual(
        ["PUBLIC", ...api].sort()
      )
    }
  })

  it("refuses a context with an unknown object action", async () => {
    const result = await compileRights(policyDomain(writeRoles()))
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const model = result.model!
    const expected = model.contracts.rights
      .flatMap((c) =>
        c.actions
          .filter((a) => a.effects.dml.length > 0)
          .map((a) => [c.kindLabel, a.action])
      )
      .sort((a, b) => (a.join() < b.join() ? -1 : 1))
    const unit = byName(model, COMMAND_FUNCTIONS.parsed.name)
    const lists = nodes(bodyTrees(unit), "valuesLists").flatMap(
      (list) => list as unknown[]
    )
    const pairs = lists.map((row) =>
      (nodes(row, "A_Const") as { sval: { sval: string } }[]).map(
        (c) => c.sval.sval
      )
    )
    expect(pairs).toEqual(expected)
    expect(pairs).toContainEqual(["task", REASSIGN_ACTION_ID])
    expect(pairs).toContainEqual(["org_roles", "administerRights"])
    expect(pairs).toContainEqual(["org_role_assignments", "administerRights"])
    expect(pairs).not.toContainEqual(["task", "read"])
    expect(unit.sql).toContain("DETAIL = 'unknown-action'")
  })

  it("parses the setting once", async () => {
    const model = (await compileRights(withRoles())).model!
    const using = functions(model)
      .filter((u) => calls(u).some((c) => c.name === "current_setting"))
      .map((u) => u.name)
    expect(using).toEqual([COMMAND_FUNCTIONS.parsed.name])
    expect(byName(model, COMMAND_FUNCTIONS.parsed.name).sql).toContain(
      `current_setting('${COMMAND_SETTING}', true)`
    )
    const strict = (name: string) =>
      calls(byName(model, name)).filter((c) => c.name === "command_parsed")
    expect(strict(COMMAND_FUNCTIONS.action.name)).toEqual([
      { name: "command_parsed", args: [true] },
    ])
    expect(strict(COMMAND_FUNCTIONS.root.name)).toEqual([
      { name: "command_parsed", args: [true] },
    ])
    expect(strict(COMMAND_FUNCTIONS.current.name)).toEqual([
      { name: "command_parsed", args: [false] },
    ])
  })
})
