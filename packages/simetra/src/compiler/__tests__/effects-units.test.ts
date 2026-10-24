import { parsePlPgSQLSync } from "@libpg-query/parser"
import { beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import { makeObjectName } from "simetra/model"
import { contentChangeCondition, contentColumns } from "../mechanics-units"
import { effectsTables, writesByCommandContract } from "../contracts"
import { writesByCommand } from "../rights/facts"
import { hasEmptySearchPath, routineLanguage } from "../sql/closed-forms"
import { executeGrants } from "../sql/execute-grants"
import type { SqlUnit } from "../sql/units"
import {
  COMMENT_TABLE,
  CHECKLIST_TABLE,
  HOURS_TABLES,
  RATE_TABLE,
  REASSIGN_ACTION_ID,
  REGION_NOTES_TABLE,
  TASK_FILE,
  compileRights,
  globalConstant,
  policyDomain,
  rightsFiles,
  writableRegister,
  writeRoles,
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
import { expectClean, uuid } from "./helpers"
import { kitchenSink } from "./fixtures/kitchen-sink"

let domain: CompiledModel
beforeAll(async () => {
  await loadShapeParsers()
  const result = await compileRights(
    policyDomain(writeRoles(), writableRegister())
  )
  expectClean(result)
  domain = result.model!
})

const effects = (model: CompiledModel) =>
  model.sqlUnits.filter((u) => u.generator === "effects")

function unit(model: CompiledModel, identity: string): SqlUnit {
  const found = model.sqlUnits.find((u) => u.identity === identity)
  expect(found, identity).toBeDefined()
  return found!
}

const tableOf = (model: CompiledModel, name: string) =>
  model.physical.tables.find((t) => t.name === name)!

/** Відмова тригера ефектів — оракул тесту, а не генератора. */
const refuse = (table: string, column?: string) =>
  `RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'command.forbidden', DETAIL = 'effect', TABLE = '${table}'` +
  (column === undefined ? "" : `, COLUMN = '${column}'`) +
  ";"

const raiseIf = (condition: string, table: string, column?: string) => [
  `IF ${condition} THEN`,
  refuse(table, column),
  "END IF;",
]

/** Жодна з колонок `columns` не змінилася на оновленні. */
const unchanged = (table: string, columns: readonly string[]) =>
  columns.flatMap((c) =>
    raiseIf(`OLD.${c} IS DISTINCT FROM NEW.${c}`, table, c)
  )

const onUpdate = (lines: readonly string[]) => [
  "IF TG_OP = 'UPDATE' THEN",
  ...lines,
  "END IF;",
]

const PREAMBLE = [
  "DECLARE",
  "  v_action text;",
  "  v_object text;",
  "  v_root uuid;",
  "BEGIN",
  "  SELECT c.action, c.object, c.root INTO v_action, v_object, v_root FROM simetra.command_current() AS c;",
  "  IF v_action IS NULL THEN",
  "    RETURN NULL;",
  "  END IF;",
]

const fnOf = (model: CompiledModel, table: string) =>
  unit(model, `function:public.${table}_simetra_effects()`)

describe("buildEffectsUnits", () => {
  it("checks the root row against the effects of the command action", () => {
    const t = "task"
    // Колонки порівняння — змістові без незмінних (ключ і скоуп перевіряє
    // окрема умова, Р2b1-20): авторство механіка не примушує, тож воно в
    // переліку (Р2b1-15).
    const content = contentColumns(tableOf(domain, t), "camelCase")
      .map((c) => c.name)
      .filter((c) => c !== "id" && c !== "org_id")
    expect(content).toEqual([
      "number",
      "date",
      "posted",
      "deletion_mark",
      "created_at",
      "created_by_id",
      "updated_by_id",
      "assignee_id",
      "project_id",
      "region_id",
    ])
    const except = (...columns: string[]) =>
      content.filter((c) => !columns.includes(c))
    // Шапка `update` — уся шапка без колонок переходів (Р2b1-18), тож
    // оновлення порівнює саме їх.
    const updateCompared = ["posted", "deletion_mark"]
    const direction = (from: boolean, to: boolean) =>
      raiseIf(
        `OLD.posted IS DISTINCT FROM NEW.posted AND (OLD.posted IS DISTINCT FROM ${from} OR NEW.posted IS DISTINCT FROM ${to})`,
        t,
        "posted"
      )
    const onlyOp = (op: string) => raiseIf(`TG_OP NOT IN ('${op}')`, t)
    const body = [
      ...PREAMBLE,
      // Незмінні колонки — лише на оновленні: вставка під `create` свій
      // скоуп лише отримує (Р2b1-20).
      ...raiseIf(
        "TG_OP = 'UPDATE' AND OLD.id IS DISTINCT FROM NEW.id",
        t,
        "id"
      ),
      ...raiseIf(
        "TG_OP = 'UPDATE' AND OLD.org_id IS DISTINCT FROM NEW.org_id",
        t,
        "org_id"
      ),
      ...raiseIf(
        "TG_OP = 'INSERT' AND NEW.deletion_mark IS DISTINCT FROM false",
        t,
        "deletion_mark"
      ),
      ...raiseIf(
        "TG_OP = 'INSERT' AND NEW.posted IS DISTINCT FROM false",
        t,
        "posted"
      ),
      // Некореневий рядок — за природною `update`, а не вихід.
      "IF v_object <> 'task' OR NOT coalesce(OLD.id = v_root OR NEW.id = v_root, false) THEN",
      ...onUpdate(unchanged(t, updateCompared)),
      "RETURN NULL;",
      "END IF;",
      "IF v_action = 'create' THEN",
      ...onlyOp("INSERT"),
      "ELSIF v_action = 'update' THEN",
      ...onlyOp("UPDATE"),
      ...onUpdate(unchanged(t, updateCompared)),
      "ELSIF v_action = 'markDeletion' THEN",
      ...onlyOp("UPDATE"),
      ...onUpdate(unchanged(t, except("deletion_mark"))),
      "ELSIF v_action = 'delete' THEN",
      ...onlyOp("DELETE"),
      "ELSIF v_action = 'post' THEN",
      ...onlyOp("UPDATE"),
      ...onUpdate([
        ...unchanged(t, except("posted")),
        ...direction(false, true),
      ]),
      "ELSIF v_action = 'unpost' THEN",
      ...onlyOp("UPDATE"),
      ...onUpdate([
        ...unchanged(t, except("posted")),
        ...direction(true, false),
      ]),
      `ELSIF v_action = '${REASSIGN_ACTION_ID}' THEN`,
      ...onlyOp("UPDATE"),
      ...onUpdate(unchanged(t, except("assignee_id"))),
      "ELSE",
      refuse(t),
      "END IF;",
      "RETURN NULL;",
      "END",
    ].join("\n")
    expect(bodyShape(fnOf(domain, t).sql)).toEqual(
      bodyShape(expectedFunction("public.task_simetra_effects", body))
    )
    // Позначка видалення — рівно змістові колонки без неї (і без незмінних).
    expect(except("deletion_mark")).toEqual(
      content.filter((c) => c !== "deletion_mark")
    )
  })

  it("a tabular section follows its owner's effects, deletion cascades", () => {
    const t = CHECKLIST_TABLE
    const fk = tableOf(domain, t).foreignKeys.find(
      (k) => k.references.table === "task"
    )!
    expect(fk.columns).toEqual(["org_id", "parent_id"])
    const body = [
      ...PREAMBLE,
      // Скоуп рядка ТЧ (Р2b1-20) і його власник (Р2b1-24) незмінні: рядок
      // не переходить ні до іншого тенанта, ні до іншого документа.
      ...raiseIf(
        "TG_OP = 'UPDATE' AND OLD.org_id IS DISTINCT FROM NEW.org_id",
        t,
        "org_id"
      ),
      ...raiseIf(
        "TG_OP = 'UPDATE' AND OLD.parent_id IS DISTINCT FROM NEW.parent_id",
        t,
        "parent_id"
      ),
      "IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.task WHERE org_id = OLD.org_id AND id = OLD.parent_id) THEN",
      "RETURN NULL;",
      "END IF;",
      // Природна дія ТЧ — `update` власника з ТЧ: дозволено все.
      "IF v_object <> 'task' OR NOT coalesce(OLD.parent_id = v_root OR NEW.parent_id = v_root, false) THEN",
      "RETURN NULL;",
      "END IF;",
      "IF v_action = 'create' THEN",
      ...raiseIf("TG_OP NOT IN ('INSERT')", t),
      "ELSIF v_action = 'update' THEN",
      "ELSIF v_action = 'markDeletion' THEN",
      refuse(t),
      "ELSIF v_action = 'delete' THEN",
      refuse(t),
      "ELSIF v_action = 'post' THEN",
      refuse(t),
      "ELSIF v_action = 'unpost' THEN",
      refuse(t),
      `ELSIF v_action = '${REASSIGN_ACTION_ID}' THEN`,
      refuse(t),
      "ELSE",
      refuse(t),
      "END IF;",
      "RETURN NULL;",
      "END",
    ].join("\n")
    expect(bodyShape(fnOf(domain, t).sql)).toEqual(
      bodyShape(expectedFunction(`public.${t}_simetra_effects`, body))
    )
  })

  it("the scope column is compared only on update", () => {
    // Р2b1-20: на вставці `OLD` немає — новий рядок під `create` і рядок ТЧ
    // свій скоуп лише отримують, тож жодна умова з `NEW.org_id` не діє поза
    // `UPDATE`.
    for (const table of ["task", CHECKLIST_TABLE]) {
      const conditions = bodyShape(fnOf(domain, table).sql).flatMap((s) =>
        s.expressions.filter((e) => e.role === "condition").map((e) => e.tree)
      )
      const scoped = conditions.filter((c) =>
        JSON.stringify(c).includes(
          '{"String":{"sval":"new"}},{"String":{"sval":"org_id"}}'
        )
      )
      expect(scoped, table).toEqual([
        tree(
          "SELECT TG_OP = 'UPDATE' AND OLD.org_id IS DISTINCT FROM NEW.org_id"
        ),
      ])
    }
  })

  it("the registry and the contract forms of writing by command agree", async () => {
    // Стадія 4 судить за реєстром (`writesByCommand`), генератори — за
    // контрактом (`writesByCommandContract`): розбіжність дала б тригер без
    // зарезервованого імені чи резерв без тригера.
    const models = [
      (
        await compileRights(
          policyDomain(writeRoles(), writableRegister(), globalConstant())
        )
      ).model!,
      (await compileRights(kitchenSink())).model!,
    ]
    const seen = new Set<boolean>()
    for (const model of models) {
      const byId = new Map(model.objects.map((o) => [o.id, o]))
      for (const contract of model.contracts.rights) {
        const object = byId.get(contract.objectId)!
        expect(writesByCommand(object), contract.kindLabel).toBe(
          writesByCommandContract(contract)
        )
        seen.add(writesByCommandContract(contract))
      }
    }
    // Обидві відповіді трапляються: системні довідники прав лише читаються.
    expect([...seen].sort()).toEqual([false, true])
  })

  it("every table with effects has a reserved function name", async () => {
    // Резервування стадії 4 (`writesByCommand`) і умова генератора (контракт
    // з дією з DML) — дві форми одного предиката: на моделях з функціями прав
    // вони дають ті самі таблиці.
    const constant = (await compileRights(policyDomain(globalConstant())))
      .model!
    for (const model of [domain, constant]) {
      const byId = new Map(model.objects.map((o) => [o.id, o]))
      const reserved = effectsTables(model.physical)
        .filter(({ table }) =>
          writesByCommand(byId.get(table.origin.objectId)!)
        )
        .map(
          ({ table }) =>
            `function:${table.schema}.${table.name}_simetra_effects()`
        )
        .sort()
      const generated = effects(model)
        .filter((u) => u.class === "function")
        .map((u) => u.identity)
        .sort()
      expect(generated.length).toBeGreaterThan(0)
      expect(generated).toEqual(reserved)
    }
  })

  it("the effects function is a closed definer granted to nobody", () => {
    const units = effects(domain)
    const functions = units.filter((u) => u.class === "function")
    expect(functions.map((u) => u.identity)).toContain(
      "function:public.task_simetra_effects()"
    )
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
      // `row_security = off`: власник під RLS дав би гучну помилку замість
      // тихого «власника немає» (як `carrierBackfillRefusals` 2a2).
      expect(
        nodes(create.options, "VariableSetStmt").map((v) => {
          const set = v as {
            name: string
            args: { A_Const: { sval?: { sval: string } } }[]
          }
          return [set.name, set.args[0]!.A_Const.sval?.sval]
        }),
        fn.identity
      ).toEqual([
        ["search_path", ""],
        ["row_security", "off"],
      ])
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
      // Єдине відношення тіла — власник у `NOT EXISTS`, лише у функції ТЧ.
      const owner = tableOf(domain, fn.name.replace(/_simetra_effects$/, ""))
        .origin.tabularSectionId
      expect(
        relationsOf(
          bodyShape(fn.sql).map((s) => s.expressions.map((e) => e.tree))
        ),
        fn.identity
      ).toEqual(
        owner === undefined
          ? []
          : [
              {
                schemaname: "public",
                relname: fn.name.startsWith("task_comment")
                  ? COMMENT_TABLE
                  : fn.name.startsWith("users")
                    ? "users"
                    : "task",
                inh: true,
                relpersistence: "p",
              },
            ]
      )
    }
    expect(
      units.filter((u) => u.class === "grant" && u.sql.startsWith("GRANT"))
    ).toEqual([])
  })

  it("fires after the row is final and skips copy-only updates", () => {
    const comment = tableOf(domain, COMMENT_TABLE)
    expect(
      effects(domain)
        .filter(
          (u) =>
            u.class === "trigger" &&
            u.identity.startsWith(`trigger:public.${COMMENT_TABLE}.`)
        )
        .map((u) => u.tree)
    ).toEqual([
      tree(
        `CREATE TRIGGER ${COMMENT_TABLE}_simetra_effects AFTER INSERT OR DELETE ON public.${COMMENT_TABLE} FOR EACH ROW EXECUTE FUNCTION public.${COMMENT_TABLE}_simetra_effects();`
      ),
      tree(
        `CREATE TRIGGER ${COMMENT_TABLE}_simetra_effects_update AFTER UPDATE ON public.${COMMENT_TABLE} FOR EACH ROW WHEN (${contentChangeCondition(comment, "camelCase")}) EXECUTE FUNCTION public.${COMMENT_TABLE}_simetra_effects();`
      ),
    ])
    expect(
      unit(domain, "trigger:public.task.task_simetra_effects").tree
    ).toEqual(
      tree(
        "CREATE TRIGGER task_simetra_effects AFTER INSERT OR UPDATE OR DELETE ON public.task FOR EACH ROW EXECUTE FUNCTION public.task_simetra_effects();"
      )
    )
    expect(
      effects(domain).some(
        (u) => u.identity === "trigger:public.task.task_simetra_effects_update"
      )
    ).toBe(false)
  })

  it("refuses with the effect code and no row data", () => {
    // `opt_type` розбору plpgsql: 0 ERRCODE, 1 MESSAGE, 2 DETAIL, 3 HINT,
    // 4 COLUMN, 7 TABLE.
    const OPTION = { 0: "ERRCODE", 1: "MESSAGE", 2: "DETAIL", 3: "HINT" }
    let raises = 0
    for (const fn of effects(domain).filter((u) => u.class === "function")) {
      const parsed = parsePlPgSQLSync(fn.sql)
      for (const raise of nodes(parsed, "PLpgSQL_stmt_raise")) {
        raises += 1
        const options = new Map(
          (
            raise as {
              options: {
                PLpgSQL_raise_option: {
                  opt_type: number
                  expr: { PLpgSQL_expr: { query: string } }
                }
              }[]
            }
          ).options.map(({ PLpgSQL_raise_option: o }) => [
            o.opt_type,
            o.expr.PLpgSQL_expr.query,
          ])
        )
        expect(options.get(0), fn.identity).toBe("'42501'")
        expect(options.get(1), fn.identity).toBe("'command.forbidden'")
        expect(options.get(2), fn.identity).toBe("'effect'")
        expect(options.get(7), fn.identity).toMatch(/^'[a-z_]+'$/)
        for (const [type, query] of options) {
          if (type in OPTION) {
            expect(query, `${fn.identity} ${type}`).not.toMatch(/NEW\.|OLD\./)
          }
          // Значення відмови — лише літерали: даних рядка в ній немає.
          expect(query, fn.identity).toMatch(/^'[^']*'$/)
        }
      }
    }
    expect(raises).toBeGreaterThan(0)
  })

  it("reads no flags, depth or current user", () => {
    for (const fn of effects(domain).filter((u) => u.class === "function")) {
      const shape = bodyShape(fn.sql)
      const calls = funcNames(shape)
      expect(calls, fn.identity).not.toContain("current_setting")
      expect(calls, fn.identity).not.toContain("pg_trigger_depth")
      // `current_user`/`session_user` — не виклики, а вузли SQLValueFunction.
      expect(
        nodes(
          shape.map((s) => s.expressions.map((e) => e.tree)),
          "SQLValueFunction"
        ),
        fn.identity
      ).toEqual([])
    }
  })

  it("no effects triggers on registers, constants or without rights functions", async () => {
    const tablesWithEffects = (model: CompiledModel) =>
      new Set(
        effects(model)
          .filter((u) => u.class === "trigger")
          .map((u) => u.identity.split(".")[1])
      )
    const onDomain = tablesWithEffects(domain)
    expect(onDomain.has("task")).toBe(true)
    expect(onDomain.has(CHECKLIST_TABLE)).toBe(true)
    for (const table of [REGION_NOTES_TABLE, ...Object.values(HOURS_TABLES)]) {
      expect(onDomain.has(table), table).toBe(false)
    }
    const constant = await compileRights(policyDomain(globalConstant()))
    expectClean(constant)
    expect(tablesWithEffects(constant.model!).has(RATE_TABLE)).toBe(false)
    // Константа без кореневої родини: «решта» за природною `update` на
    // вставці й оновленні, без умови кореня.
    const rate = constant
      .model!.sqlUnits.filter(
        (u) =>
          u.class === "policy" &&
          u.identity.startsWith(`policy:public.${RATE_TABLE}.`) &&
          /_(insert|update|delete)_(root|rest)_/.test(u.name)
      )
      .map((u) => u.name)
      .sort()
    expect(rate).toEqual([
      `${RATE_TABLE}_insert_rest_any`,
      `${RATE_TABLE}_update_rest_any`,
    ])
    expect(
      constant
        .model!.sqlUnits.filter((u) =>
          u.identity.startsWith(`policy:public.${RATE_TABLE}.`)
        )
        .map((u) => u.sql)
        .join(" ")
    ).not.toContain("command_root")
    const plain = await compileRights(rightsFiles())
    expect(effects(plain.model!)).toEqual([])
  })

  it("effects function names collide like carrier functions", async () => {
    // Р2b1-11: ім'я функції ефектів обрізає ім'я таблиці, тож у довгої
    // основної таблиці й її ТЧ воно однакове — як у функцій носіїв. У задачі
    // копій немає, а мітки носіїв таблиці й ТЧ різні, тож колізія одна.
    const long = "e".repeat(60)
    const result = await compileRights(
      policyDomain({
        [TASK_FILE]: {
          physicalName: long,
          tabularSections: [
            {
              id: uuid(6511),
              name: "checklist",
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
        TASK_FILE,
        "/physicalName",
        makeObjectName(long, undefined, "simetra_effects"),
      ],
    ])
  })
})
