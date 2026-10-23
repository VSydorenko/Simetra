import { beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import { hasEmptySearchPath, routineLanguage } from "../sql/closed-forms"
import { executeGrants } from "../sql/execute-grants"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import { withoutLocations, type SqlUnit } from "../sql/units"
import {
  COMMENT_FILE,
  compileRights,
  policyDomain,
  rightsFiles,
  scopeRootCarrier,
} from "./fixtures/rights"
import { uuid } from "./helpers"

let parse: SqlParser
let plpgsql: PlpgsqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
  plpgsql = await loadPlpgsqlParser()
})

const carriers = (model: CompiledModel) =>
  model.sqlUnits.filter((u) => u.generator === "carriers")

function unit(model: CompiledModel, identity: string): SqlUnit {
  const found = model.sqlUnits.find((u) => u.identity === identity)
  expect(found, identity).toBeDefined()
  return found!
}

function tree(sql: string): unknown {
  const parsed = parse(sql)
  if (!parsed.ok || parsed.statements.length !== 1)
    throw new Error(`does not parse: ${sql}`)
  return withoutLocations(parsed.statements[0]!.stmt)
}

/**
 * Тіло plpgsql як дерево операторів: вид, глибина, ціль, `RETURN` і дерево
 * розбору кожного виразу — форматування не впливає, а кожен запит
 * порівнюється цілим (зокрема `FOR SHARE` і ціль `INTO`).
 */
function bodyShape(createFunction: string) {
  const parsed = plpgsql(createFunction)
  if (!parsed.ok || parsed.fn === undefined)
    throw new Error(`body does not parse: ${createFunction}`)
  return parsed.fn.statements.map((s) => ({
    type: s.type,
    depth: s.depth,
    target: s.target,
    returns: s.returns,
    expressions: s.expressions.map((e) => ({
      role: e.role,
      into: e.into,
      // Вираз (`parseMode` 2) — без `SELECT`, запит — цілий оператор.
      tree: tree(e.parseMode === 0 ? e.query : `SELECT ${e.query}`),
    })),
  }))
}

/** Очікувана функція-тригер з тілом `body`. */
const expectedFunction = (fn: string, body: string) =>
  `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$\n${body}\n$$;`

/** Вузли дерева з ключем `key`, у порядку обходу. */
function nodes(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => nodes(item, key))
  if (typeof value !== "object" || value === null) return []
  const node = value as Record<string, unknown>
  return [
    ...(key in node ? [node[key]] : []),
    ...Object.values(node).flatMap((child) => nodes(child, key)),
  ]
}

/** Відношення дерева: кожен вузол з `relname`. */
function relationsOf(
  value: unknown
): { schemaname?: string; relname: string }[] {
  if (Array.isArray(value)) return value.flatMap(relationsOf)
  if (typeof value !== "object" || value === null) return []
  const node = value as Record<string, unknown>
  return [
    ...(typeof node.relname === "string"
      ? [node as { schemaname?: string; relname: string }]
      : []),
    ...Object.values(node).flatMap(relationsOf),
  ]
}

const funcNames = (shape: ReturnType<typeof bodyShape>) =>
  nodes(
    shape.map((s) => s.expressions.map((e) => e.tree)),
    "FuncCall"
  ).flatMap((call) =>
    (call as { funcname: { String: { sval: string } }[] }).funcname.map(
      (n) => n.String.sval
    )
  )

describe("buildCarrierUnits", () => {
  it("derives copies on insert and on a changed link FOR SHARE, keeps them otherwise", async () => {
    const model = (await compileRights(policyDomain())).model!
    expect(
      unit(
        model,
        "trigger:public.task_checklist.task_checklist_simetra_carriers"
      ).tree
    ).toEqual(
      tree(
        "CREATE TRIGGER task_checklist_simetra_carriers BEFORE INSERT OR UPDATE ON public.task_checklist FOR EACH ROW EXECUTE FUNCTION public.task_checklist_simetra_carriers();"
      )
    )
    const fn = unit(
      model,
      "function:public.task_checklist_simetra_carriers()"
    ).sql
    const source =
      "FROM public.task s WHERE s.org_id = NEW.org_id AND s.id = NEW.parent_id"
    const rederive = (copy: string) =>
      `    IF NEW.${copy} IS DISTINCT FROM OLD.${copy} THEN\n` +
      `      SELECT s.${copy} INTO NEW.${copy} ${source};\n` +
      "    END IF;"
    expect(bodyShape(fn)).toEqual(
      bodyShape(
        expectedFunction(
          "public.task_checklist_simetra_carriers",
          [
            "BEGIN",
            "  IF TG_OP = 'INSERT' OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN",
            "    SELECT s.assignee_id, s.project_id, s.region_id",
            "      INTO NEW.assignee_id, NEW.project_id, NEW.region_id",
            `      ${source} FOR SHARE;`,
            "  ELSE",
            rederive("assignee_id"),
            rederive("project_id"),
            rederive("region_id"),
            "  END IF;",
            "  RETURN NEW;",
            "END",
          ].join("\n")
        )
      )
    )
    // Жодного прапорця сесії чи глибини тригерів: копію визначає лише джерело.
    const calls = funcNames(bodyShape(fn))
    expect(calls).not.toContain("current_setting")
    expect(calls).not.toContain("pg_trigger_depth")
  })

  it("propagates every column a copy reads, scope first", async () => {
    const model = (await compileRights(policyDomain())).model!
    expect(
      unit(model, "trigger:public.task.task_simetra_carriers_out").tree
    ).toEqual(
      tree(
        "CREATE TRIGGER task_simetra_carriers_out AFTER UPDATE ON public.task FOR EACH ROW WHEN (OLD.assignee_id IS DISTINCT FROM NEW.assignee_id OR OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.region_id IS DISTINCT FROM NEW.region_id) EXECUTE FUNCTION public.task_simetra_carriers_out();"
      )
    )
    expect(
      unit(model, "trigger:public.task.task_simetra_carriers_out_insert").tree
    ).toEqual(
      tree(
        "CREATE TRIGGER task_simetra_carriers_out_insert AFTER INSERT ON public.task FOR EACH ROW EXECUTE FUNCTION public.task_simetra_carriers_out();"
      )
    )
    expect(
      bodyShape(unit(model, "function:public.task_simetra_carriers_out()").sql)
    ).toEqual(
      bodyShape(
        expectedFunction(
          "public.task_simetra_carriers_out",
          [
            "BEGIN",
            "  UPDATE public.task_checklist d SET assignee_id = NEW.assignee_id, project_id = NEW.project_id, region_id = NEW.region_id",
            "    WHERE d.org_id = NEW.org_id AND d.parent_id = NEW.id AND (d.assignee_id IS DISTINCT FROM NEW.assignee_id OR d.project_id IS DISTINCT FROM NEW.project_id OR d.region_id IS DISTINCT FROM NEW.region_id);",
            "  UPDATE public.task_comment d SET task_id_assignee_id = NEW.assignee_id",
            "    WHERE d.org_id = NEW.org_id AND d.task_id = NEW.id AND (d.task_id_assignee_id IS DISTINCT FROM NEW.assignee_id);",
            "  UPDATE public.task_report d SET task_id_assignee_id = NEW.assignee_id",
            "    WHERE d.org_id = NEW.org_id AND d.task_id = NEW.id AND (d.task_id_assignee_id IS DISTINCT FROM NEW.assignee_id);",
            "  RETURN NULL;",
            "END",
          ].join("\n")
        )
      )
    )
    // Другий хід: копію шляху коментаря читає копія його ТЧ.
    expect(
      unit(
        model,
        "trigger:public.task_comment.task_comment_simetra_carriers_out"
      ).tree
    ).toEqual(
      tree(
        "CREATE TRIGGER task_comment_simetra_carriers_out AFTER UPDATE ON public.task_comment FOR EACH ROW WHEN (OLD.task_id_assignee_id IS DISTINCT FROM NEW.task_id_assignee_id) EXECUTE FUNCTION public.task_comment_simetra_carriers_out();"
      )
    )
    expect(
      bodyShape(
        unit(model, "function:public.task_comment_simetra_carriers_out()").sql
      )
    ).toEqual(
      bodyShape(
        expectedFunction(
          "public.task_comment_simetra_carriers_out",
          [
            "BEGIN",
            "  UPDATE public.task_comment_attachments d SET task_id_assignee_id = NEW.task_id_assignee_id",
            "    WHERE d.org_id = NEW.org_id AND d.parent_id = NEW.id AND (d.task_id_assignee_id IS DISTINCT FROM NEW.task_id_assignee_id);",
            "  RETURN NULL;",
            "END",
          ].join("\n")
        )
      )
    )
  })

  it("links a tabular row of the scope root by parent_id alone", async () => {
    const model = (await compileRights(policyDomain(scopeRootCarrier()))).model!
    expect(
      bodyShape(
        unit(model, "function:public.organization_sites_simetra_carriers()").sql
      )
    ).toEqual(
      bodyShape(
        expectedFunction(
          "public.organization_sites_simetra_carriers",
          [
            "BEGIN",
            "  IF TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN",
            "    SELECT s.owner_id INTO NEW.owner_id FROM public.organization s WHERE s.id = NEW.parent_id FOR SHARE;",
            "  ELSE",
            "    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN",
            "      SELECT s.owner_id INTO NEW.owner_id FROM public.organization s WHERE s.id = NEW.parent_id;",
            "    END IF;",
            "  END IF;",
            "  RETURN NEW;",
            "END",
          ].join("\n")
        )
      )
    )
    expect(
      bodyShape(
        unit(model, "function:public.organization_simetra_carriers_out()").sql
      )
    ).toEqual(
      bodyShape(
        expectedFunction(
          "public.organization_simetra_carriers_out",
          [
            "BEGIN",
            "  UPDATE public.organization_sites d SET owner_id = NEW.owner_id",
            "    WHERE d.parent_id = NEW.id AND (d.owner_id IS DISTINCT FROM NEW.owner_id);",
            "  RETURN NULL;",
            "END",
          ].join("\n")
        )
      )
    )
  })

  it("carrier functions are closed and grant nothing", async () => {
    const model = (await compileRights(policyDomain())).model!
    const units = carriers(model)
    const functions = units.filter((u) => u.class === "function")
    expect(functions.map((u) => u.identity).sort()).toEqual([
      "function:public.task_checklist_simetra_carriers()",
      "function:public.task_comment_attachments_simetra_carriers()",
      "function:public.task_comment_simetra_carriers()",
      "function:public.task_comment_simetra_carriers_out()",
      "function:public.task_report_simetra_carriers()",
      "function:public.task_simetra_carriers_out()",
    ])
    for (const fn of functions) {
      const create = (
        fn.tree as {
          CreateFunctionStmt: {
            options: { DefElem: { defname: string; arg?: unknown } }[]
          }
        }
      ).CreateFunctionStmt
      expect(routineLanguage(fn.tree as never), fn.identity).toBe("plpgsql")
      expect(
        create.options.find((o) => o.DefElem.defname === "security")?.DefElem
          .arg,
        fn.identity
      ).toEqual({ Boolean: { boolval: true } })
      expect(hasEmptySearchPath(fn.tree as never), fn.identity).toBe(true)
      // Кожне відношення тіла — кваліфіковане (і ціль `UPDATE`, яку дерево
      // несе без обгортки `RangeVar`).
      const relations = relationsOf(
        bodyShape(fn.sql).map((s) => s.expressions.map((e) => e.tree))
      )
      expect(relations.length, fn.identity).toBeGreaterThan(0)
      for (const r of relations) expect(r.schemaname, r.relname).toBe("public")
      const signature = fn.identity.slice("function:".length)
      expect(
        units
          .filter(
            (u) =>
              u.class === "grant" && u.sql.includes(`FUNCTION ${signature} `)
          )
          .map((u) => u.sql)
          .sort()
      ).toEqual(executeGrants(signature, [], "supabase").sort())
    }
  })

  it("renders nothing for a table without copies", async () => {
    expect(carriers((await compileRights(rightsFiles())).model!)).toEqual([])
  })

  it("carrier function names collide like membership functions", async () => {
    // Ім'я функції носіїв обрізає ім'я таблиці до тих самих 46 байтів: у
    // довгої основної таблиці й її ТЧ вони однакові.
    const long = "c".repeat(60)
    const result = await compileRights(
      policyDomain({
        [COMMENT_FILE]: {
          physicalName: long,
          tabularSections: [
            {
              id: uuid(6521),
              name: "attachments",
              physicalName: `${long}_a`,
              attributes: [],
            },
          ],
        },
      })
    )
    expect(
      result.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => [d.code, d.file, d.pointer])
    ).toEqual([["physical.function-duplicate", COMMENT_FILE, "/physicalName"]])
  })
})
