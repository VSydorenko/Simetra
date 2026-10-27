import { beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import { carrierBackfillStatements } from "../rights/carrier-units"
import { hasEmptySearchPath, routineLanguage } from "../sql/closed-forms"
import { executeGrants } from "../sql/execute-grants"
import type { SqlUnit } from "../sql/units"
import {
  COMMENT_FILE,
  compileRights,
  policyDomain,
  rightsFiles,
  scopeRootCarrier,
} from "./fixtures/rights"
import {
  bodyShape,
  expectedFunction,
  funcNames,
  loadShapeParsers,
  nodes,
  relationsOf,
  tree,
} from "./fixtures/sql-shape"
import { uuid } from "./helpers"

beforeAll(loadShapeParsers)

const carriers = (model: CompiledModel) =>
  model.sqlUnits.filter((u) => u.generator === "carriers")

function unit(model: CompiledModel, identity: string): SqlUnit {
  const found = model.sqlUnits.find((u) => u.identity === identity)
  expect(found, identity).toBeDefined()
  return found!
}

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

  it("carrier function names collide like membership functions, effects ones do not", async () => {
    // Ім'я функції носіїв обрізає ім'я таблиці до тих самих 46 байтів: у
    // довгої основної таблиці й її ТЧ вони однакові — колізію ловить
    // компілятор. Функції ефектів на довгих іменах дістають стабільний хеш
    // таблиці (Р2c2-20), тож другої колізії вже немає: перевірка тримає обидва
    // факти — носії збігаються, ефекти ні.
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
        .map((d) => [d.code, d.file, d.pointer, d.params?.name])
    ).toEqual([
      [
        "physical.function-duplicate",
        COMMENT_FILE,
        "/physicalName",
        expect.stringMatching(/_simetra_carriers$/),
      ],
    ])
  })
})

describe("carrierBackfillStatements", () => {
  const pending = (name: string, ...columns: string[]) => ({
    table: { schema: "public", name },
    columns,
  })
  const physicalOf = async (...layers: Parameters<typeof policyDomain>) =>
    (await compileRights(policyDomain(...layers))).model!.physical

  /**
   * Пари рівності умови: `{ local, source }` за аліасами — `d` (залежна) чи
   * `NEW` (рядок джерела в тригері поширення) проти `s` (джерело кроку).
   */
  function linkPairs(where: unknown): { local: string; source: string }[] {
    const field = (ref: unknown) => {
      const fields = (
        ref as { ColumnRef: { fields: { String: { sval: string } }[] } }
      ).ColumnRef.fields.map((f) => f.String.sval)
      return { alias: fields[0]!, column: fields[1]! }
    }
    return nodes(where, "A_Expr").flatMap((node) => {
      const expr = node as { kind: string; lexpr: unknown; rexpr: unknown }
      if (expr.kind !== "AEXPR_OP") return []
      const [l, r] = [field(expr.lexpr), field(expr.rexpr)]
      const local = l.alias === "d" ? l : r
      const source = l.alias === "d" ? r : l
      return [{ local: local.column, source: source.column }]
    })
  }

  it("backfills copies through the composite key of their link", async () => {
    const physical = await physicalOf()
    const statements = carrierBackfillStatements(physical, [
      pending("task_checklist", "assignee_id", "region_id", "project_id"),
    ])
    expect(statements.map((s) => [s.table, s.source, tree(s.sql)])).toEqual([
      [
        { schema: "public", name: "task_checklist" },
        { schema: "public", name: "task" },
        tree(
          "UPDATE public.task_checklist AS d SET (assignee_id, project_id, region_id) = (SELECT s.assignee_id, s.project_id, s.region_id FROM public.task AS s WHERE s.org_id OPERATOR(pg_catalog.=) d.org_id AND s.id OPERATOR(pg_catalog.=) d.parent_id)" +
            " WHERE d.assignee_id IS DISTINCT FROM (SELECT s.assignee_id FROM public.task AS s WHERE s.org_id OPERATOR(pg_catalog.=) d.org_id AND s.id OPERATOR(pg_catalog.=) d.parent_id)" +
            " OR d.project_id IS DISTINCT FROM (SELECT s.project_id FROM public.task AS s WHERE s.org_id OPERATOR(pg_catalog.=) d.org_id AND s.id OPERATOR(pg_catalog.=) d.parent_id)" +
            " OR d.region_id IS DISTINCT FROM (SELECT s.region_id FROM public.task AS s WHERE s.org_id OPERATOR(pg_catalog.=) d.org_id AND s.id OPERATOR(pg_catalog.=) d.parent_id)"
        ),
      ],
    ])
    // Лише очікувані колонки: решта копій зв'язку вже узгоджена.
    expect(
      carrierBackfillStatements(physical, [
        pending("task_checklist", "region_id"),
      ]).map((s) => tree(s.sql))
    ).toEqual([
      tree(
        "UPDATE public.task_checklist AS d SET (region_id) = (SELECT s.region_id FROM public.task AS s WHERE s.org_id OPERATOR(pg_catalog.=) d.org_id AND s.id OPERATOR(pg_catalog.=) d.parent_id)" +
          " WHERE d.region_id IS DISTINCT FROM (SELECT s.region_id FROM public.task AS s WHERE s.org_id OPERATOR(pg_catalog.=) d.org_id AND s.id OPERATOR(pg_catalog.=) d.parent_id)"
      ),
    ])
  })

  it("a row without a link gets a NULL copy", async () => {
    // Підзапит у `SET`, а не `UPDATE … FROM`: внутрішнє з'єднання пропустило
    // б рядок з `NULL` у зв'язку, і старе значення лишилося б під іменем
    // копії (Р2b2-2).
    const [statement] = carrierBackfillStatements(await physicalOf(), [
      pending("task_comment", "task_id_assignee_id"),
    ])
    const update = (
      tree(statement!.sql) as { UpdateStmt: Record<string, unknown> }
    ).UpdateStmt
    expect(update.fromClause).toBeUndefined()
    expect(nodes(update.targetList, "SubLink")).toHaveLength(1)
  })

  it("orders a copy after the copy it reads", async () => {
    // Ім'я ТЧ коментаря менше за ім'я коментаря: порядок за іменем поставив
    // би копію копії раніше за копію, яку вона читає.
    const physical = await physicalOf({
      [COMMENT_FILE]: {
        tabularSections: [
          {
            id: uuid(6521),
            name: "attachments",
            physicalName: "a_comment_files",
            attributes: [],
          },
        ],
      },
    })
    const files = pending("a_comment_files", "task_id_assignee_id")
    const comment = pending("task_comment", "task_id_assignee_id")
    for (const input of [
      [files, comment],
      [comment, files],
    ]) {
      expect(
        carrierBackfillStatements(physical, input).map((s) => s.table.name)
      ).toEqual(["task_comment", "a_comment_files"])
    }
  })

  it("the backfill joins like the propagation trigger", async () => {
    const result = await compileRights(policyDomain())
    const model = result.model!
    const [statement] = carrierBackfillStatements(model.physical, [
      pending("task_comment", "task_id_assignee_id"),
    ])
    const update = (
      tree(statement!.sql) as {
        UpdateStmt: { targetList: unknown }
      }
    ).UpdateStmt
    const sub = nodes(update.targetList, "SubLink")[0] as {
      subselect: { SelectStmt: { whereClause: unknown } }
    }
    const propagation = bodyShape(
      unit(model, "function:public.task_simetra_carriers_out()").sql
    )
    const toComment = propagation
      .flatMap((s) => s.expressions.map((e) => e.tree))
      .map((t) => (t as { UpdateStmt?: Record<string, unknown> }).UpdateStmt)
      .find(
        (u) =>
          (u?.relation as { relname: string } | undefined)?.relname ===
          "task_comment"
      )!
    // Пари тригера — без умови «копія відрізняється» (`IS DISTINCT FROM`).
    expect(linkPairs(sub.subselect.SelectStmt.whereClause)).toEqual([
      { local: "org_id", source: "org_id" },
      { local: "task_id", source: "id" },
    ])
    expect(linkPairs(toComment.whereClause)).toEqual(
      linkPairs(sub.subselect.SelectStmt.whereClause)
    )
  })

  it("refuses a pending copy the snapshot does not know", async () => {
    const physical = await physicalOf()
    for (const input of [
      pending("task_checklist", "note"),
      pending("task_checklist", "missing"),
      pending("no_such_table", "assignee_id"),
    ]) {
      expect(() => carrierBackfillStatements(physical, [input])).toThrow(
        `internal: pending carrier public.${input.table.name}.${input.columns[0]} is not a copy in the desired snapshot`
      )
    }
  })
})
