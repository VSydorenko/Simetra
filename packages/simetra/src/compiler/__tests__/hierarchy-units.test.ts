import { beforeAll, describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  HIERARCHY_LOCK_SPACE,
  hierarchyLockSql,
  hierarchyNames,
} from "../hierarchy-units"
import { executeGrants } from "../sql/execute-grants"
import { hasEmptySearchPath, routineLanguage } from "../sql/closed-forms"
import {
  TICKET_CHECKLIST_TABLE,
  TICKET_TABLE,
  commandCoreLayer,
  compileRights,
  compiledPolicyDomain,
  policyDomain,
  writeRoles,
} from "./fixtures/rights"
import {
  bodyShape,
  expectedFunction,
  loadShapeParsers,
  nodes,
  tree,
} from "./fixtures/sql-shape"
import { catalog, expectClean, metaFiles, project } from "./helpers"

let domain: CompiledModel
beforeAll(async () => {
  await loadShapeParsers()
  const result = await compileRights(
    policyDomain(writeRoles(), commandCoreLayer())
  )
  expectClean(result)
  domain = result.model!
})

const hierarchyUnits = (model: CompiledModel, table: string) =>
  model.sqlUnits.filter(
    (u) =>
      u.generator === "mechanics" &&
      u.identity.includes(`${table}_simetra_hierarchy`)
  )

const triggersOf = (model: CompiledModel, table: string) =>
  hierarchyUnits(model, table)
    .filter((u) => u.class === "trigger")
    .map((u) => u.tree)

const lock = `pg_advisory_xact_lock(${HIERARCHY_LOCK_SPACE}, 'public.ticket'::regclass::oid::int)`

const body = (parent: string, key: string, table: string) => {
  const invalid = `RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'command.invalid', DETAIL = '${parent}';`
  return [
    "BEGIN",
    "  IF current_setting('transaction_isolation') <> 'read committed' THEN",
    "    RAISE EXCEPTION USING ERRCODE = '0A000', MESSAGE = 'hierarchy.isolation';",
    "  END IF;",
    `  IF NEW.${parent} = NEW.${key} THEN`,
    `    ${invalid}`,
    "  END IF;",
    `  PERFORM pg_advisory_xact_lock(${HIERARCHY_LOCK_SPACE}, 'public.${table}'::regclass::oid::int);`,
    `  IF EXISTS (WITH RECURSIVE up(node) AS (SELECT p.${parent} FROM public.${table} p WHERE p.${key} = NEW.${parent} UNION ALL SELECT p.${parent} FROM public.${table} p JOIN up ON p.${key} = up.node) CYCLE node SET looped USING trail SELECT 1 FROM up WHERE up.node = NEW.${key}) THEN`,
    `    ${invalid}`,
    "  END IF;",
    "  RETURN NULL;",
    "END",
  ].join("\n")
}

describe("buildHierarchyUnits", () => {
  it("checks isolation first, then self-reference, lock and the ancestors of the new parent", () => {
    const fn = domain.sqlUnits.find(
      (u) => u.identity === "function:public.ticket_simetra_hierarchy()"
    )!
    expect(bodyShape(fn.sql)).toEqual(
      bodyShape(
        expectedFunction(
          "public.ticket_simetra_hierarchy",
          body("parent_id", "id", TICKET_TABLE)
        )
      )
    )
    expect(fn.requires).toEqual([
      { type: "table", schema: "public", name: TICKET_TABLE },
    ])
  })

  it("the function is SECURITY DEFINER, VOLATILE, with empty search_path and row_security off, executable by nobody", () => {
    const fn = domain.sqlUnits.find(
      (u) => u.identity === "function:public.ticket_simetra_hierarchy()"
    )!
    const create = (
      fn.tree as {
        CreateFunctionStmt: {
          options: { DefElem: { defname: string; arg?: unknown } }[]
        }
      }
    ).CreateFunctionStmt
    expect(routineLanguage(fn.tree as never)).toBe("plpgsql")
    expect(
      create.options.find((o) => o.DefElem.defname === "security")?.DefElem.arg
    ).toEqual({ Boolean: { boolval: true } })
    // Типова `VOLATILE`: `STABLE` обходив би знімок до очікування на замок.
    expect(
      create.options.find((o) => o.DefElem.defname === "volatility")
    ).toBeUndefined()
    expect(hasEmptySearchPath(fn.tree as never)).toBe(true)
    expect(
      nodes(create.options, "VariableSetStmt").map((v) => {
        const set = v as {
          name: string
          args: { A_Const: { sval?: { sval: string } } }[]
        }
        return [set.name, set.args[0]!.A_Const.sval?.sval]
      })
    ).toEqual([
      ["search_path", ""],
      ["row_security", "off"],
    ])
    expect(
      hierarchyUnits(domain, TICKET_TABLE)
        .filter((u) => u.class === "grant")
        .map((u) => u.sql)
        .sort()
    ).toEqual(
      executeGrants("public.ticket_simetra_hierarchy()", [], "supabase").sort()
    )
  })

  it("AFTER INSERT with a parent and AFTER UPDATE of the parent value, without OF", () => {
    expect(triggersOf(domain, TICKET_TABLE)).toEqual([
      tree(
        "CREATE TRIGGER ticket_simetra_hierarchy AFTER INSERT ON public.ticket FOR EACH ROW WHEN (NEW.parent_id IS NOT NULL) EXECUTE FUNCTION public.ticket_simetra_hierarchy();"
      ),
      tree(
        "CREATE TRIGGER ticket_simetra_hierarchy_update AFTER UPDATE ON public.ticket FOR EACH ROW WHEN (NEW.parent_id IS DISTINCT FROM OLD.parent_id) EXECUTE FUNCTION public.ticket_simetra_hierarchy();"
      ),
    ])
  })

  it("a catalog without hierarchy and a tabular section's parent_id get no trigger", () => {
    expect(
      domain.physical.tables
        .find((t) => t.name === TICKET_CHECKLIST_TABLE)
        ?.columns.map((c) => c.name)
    ).toContain("parent_id")
    expect(
      domain.sqlUnits
        .filter(
          (u) => u.class === "trigger" && u.identity.includes("_hierarchy")
        )
        .map((u) => u.identity)
    ).toEqual([
      "trigger:public.ticket.ticket_simetra_hierarchy",
      "trigger:public.ticket.ticket_simetra_hierarchy_update",
    ])
  })

  it("reserves the function name against a verbatim function", async () => {
    // Ім'я функції від таблиці (спека П4 §6.6, як функції носіїв): дослівна функція
    // з тим самим іменем замінила б тіло тригера.
    const { diagnostics } = await compiledPolicyDomain(
      {
        "sql/public/clash.sql":
          "CREATE FUNCTION public.ticket_simetra_hierarchy() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN RETURN NULL; END $$;",
      },
      [writeRoles(), commandCoreLayer()]
    )
    expect(
      diagnostics
        .filter((d) => d.code === "physical.function-duplicate")
        .map((d) => d.params)
    ).toEqual([
      {
        schema: "public",
        name: "ticket_simetra_hierarchy",
        description: "hierarchy check of public.ticket",
        other: "a function in sql/public/clash.sql",
      },
    ])
  })

  it("the lock call is one expression for the trigger and the command core", () => {
    expect(hierarchyLockSql({ schema: "public", name: TICKET_TABLE })).toBe(
      lock
    )
  })

  it("names follow the Postgres algorithm with the whole label", () => {
    const long = "a".repeat(60)
    const names = hierarchyNames({ schema: "public", name: long })
    expect(names.insert).toMatch(/_simetra_hierarchy$/)
    expect(names.update).toMatch(/_simetra_hierarchy_update$/)
    expect(new TextEncoder().encode(names.update).length).toBeLessThanOrEqual(
      63
    )
    expect(names.fn).toEqual({ schema: "public", name: names.insert })
  })

  it("snake_case: the parent column is found by the styled registry name", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project({
          naming: { attributeCase: "snake_case" },
        }),
        "catalogs/Folder/Folder.meta.json": catalog("Folder", {
          hierarchyType: "ItemsOnly",
        }),
      })
    )
    expectClean(result, { allow: ["rights.scope-kind-unread"] })
    const model = result.model!
    const table = model.physical.tables.find(
      (t) => t.origin.tabularSectionId === undefined && t.name === "folder"
    )!
    expect(
      table.columns.find((c) => c.name === "parent_id")?.origin.standard
    ).toBe("parent")
    const fn = model.sqlUnits.find(
      (u) => u.identity === "function:public.folder_simetra_hierarchy()"
    )!
    expect(bodyShape(fn.sql)).toEqual(
      bodyShape(
        expectedFunction(
          "public.folder_simetra_hierarchy",
          body("parent_id", "id", "folder")
        )
      )
    )
    expect(triggersOf(model, "folder")).toHaveLength(2)
  })
})
