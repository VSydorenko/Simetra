import { beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import type { PhysicalSnapshot, PhysicalTable } from "simetra/model"
import { buildAuthorUnits } from "../author-units"
import {
  contentChangeCondition,
  mechanicsUpdateTriggerName,
} from "../mechanics-units"
import { executeGrants } from "../sql/execute-grants"
import { hasEmptySearchPath, routineLanguage } from "../sql/closed-forms"
import {
  NOTE_LONG,
  authorCarrier,
  compileRights,
  policyDomain,
  rightsFiles,
  singleTenantRights,
  writeRoles,
} from "./fixtures/rights"
import {
  bodyShape,
  expectedFunction,
  funcNames,
  loadShapeParsers,
  nodes,
  tree,
} from "./fixtures/sql-shape"
import { expectClean } from "./helpers"
import { snakeCaseTwin } from "./fixtures/snake-case"

let domain: CompiledModel
let notes: CompiledModel
beforeAll(async () => {
  await loadShapeParsers()
  const domainResult = await compileRights(policyDomain(writeRoles()))
  expectClean(domainResult)
  domain = domainResult.model!
  const notesResult = await compileRights(
    singleTenantRights({ ...authorCarrier(), ...authorCarrier("long") })
  )
  expectClean(notesResult)
  notes = notesResult.model!
})

const AUTHOR = "function:simetra.author()"

const authorUnits = (model: CompiledModel) =>
  model.sqlUnits.filter(
    (u) => u.generator === "mechanics" && u.identity.includes("author")
  )

const triggersOn = (model: CompiledModel, table: string) =>
  authorUnits(model)
    .filter(
      (u) =>
        u.class === "trigger" &&
        u.identity.startsWith(`trigger:public.${table}.`)
    )
    .map((u) => u.tree)

const tableOf = (model: CompiledModel, name: string) =>
  model.physical.tables.find((t) => t.name === name)!

describe("buildAuthorUnits", () => {
  it("forces both authors on insert and the updater on update, only under a command context", () => {
    const fn = domain.sqlUnits.find((u) => u.identity === AUTHOR)!
    const body = [
      "BEGIN",
      "  IF (SELECT c.action FROM simetra.command_current() AS c) IS NOT NULL THEN",
      "    IF TG_OP = 'INSERT' THEN",
      "      NEW.created_by_id := (SELECT simetra.current_user_id());",
      "    END IF;",
      "    NEW.updated_by_id := (SELECT simetra.current_user_id());",
      "  END IF;",
      "  RETURN NEW;",
      "END",
    ].join("\n")
    const shape = bodyShape(fn.sql)
    expect(shape).toEqual(bodyShape(expectedFunction("simetra.author", body)))
    // Відхилення 3 архітекторки: тіло лише кличе функції контексту й
    // користувача й не читає жодної таблиці.
    expect(funcNames(shape).sort()).toEqual([
      "command_current",
      "current_user_id",
      "current_user_id",
      "simetra",
      "simetra",
      "simetra",
    ])
    expect(
      nodes(
        shape.map((s) => s.expressions.map((e) => e.tree)),
        "RangeVar"
      )
    ).toEqual([])
    // `SECURITY DEFINER` з порожнім `search_path` і без інших налаштувань.
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
    expect(hasEmptySearchPath(fn.tree as never)).toBe(true)
    expect(
      nodes(create.options, "VariableSetStmt").map(
        (v) => (v as { name: string }).name
      )
    ).toEqual(["search_path"])
    // `EXECUTE` — нікому: ні `PUBLIC`, ні ролям API.
    expect(
      authorUnits(domain)
        .filter((u) => u.class === "grant")
        .map((u) => u.sql)
        .sort()
    ).toEqual(executeGrants("simetra.author()", [], "supabase").sort())
    expect(fn.requires).toEqual([
      { type: "unit", identity: "function:simetra.command_current()" },
      { type: "unit", identity: "function:simetra.current_user_id()" },
    ])
  })

  it("a table with authors and no carrier copies gets one INSERT OR UPDATE trigger", () => {
    expect(triggersOn(domain, "task")).toEqual([
      tree(
        "CREATE TRIGGER task_simetra_author BEFORE INSERT OR UPDATE ON public.task FOR EACH ROW EXECUTE FUNCTION simetra.author();"
      ),
    ])
  })

  it.each([
    ["note", "note_simetra_author", "note_simetra_author_update"],
    [
      NOTE_LONG,
      "note_aaaaaaaaaaaaaaaaaaaaaaaaaaa_334591de_simetra_author",
      "note_aaaaaaaaaaaaaaaaaaaaaaaaaaa_334591de_simetra_author_update",
    ],
  ])(
    "a copy of a carrier by the author splits the trigger with the touch condition: %s",
    (table, insert, update) => {
      const condition = contentChangeCondition(
        tableOf(notes, table),
        "camelCase",
        tableOf(notes, table).columns.filter((c) =>
          ["created_by_id", "updated_by_id"].includes(c.name)
        )
      )
      const changed = (columns: readonly string[]) =>
        columns.map((c) => `OLD.${c} IS DISTINCT FROM NEW.${c}`).join(" OR ")
      // Зміна лише автора — теж зміна рядка (Р-A1-10), поширення копії — ні.
      expect(tree(`SELECT ${condition}`)).toEqual(
        tree(
          `SELECT ((${changed(["id", "code", "description", "deletion_mark", "predefined_name", "created_at", "text"])}) OR (${changed(["created_by_id", "updated_by_id"])})) OR NOT (${changed(["created_by_id_mentor_id"])})`
        )
      )
      expect(triggersOn(notes, table)).toEqual([
        tree(
          `CREATE TRIGGER ${insert} BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION simetra.author();`
        ),
        tree(
          `CREATE TRIGGER ${update} BEFORE UPDATE ON public.${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION simetra.author();`
        ),
      ])
      // Та сама умова, що в механіки оновлення.
      const touch = notes.sqlUnits.find(
        (u) =>
          u.identity ===
          `trigger:public.${table}.${mechanicsUpdateTriggerName(table)}`
      )!
      expect(touch.tree).toEqual(
        tree(
          `CREATE TRIGGER ${mechanicsUpdateTriggerName(table)} BEFORE UPDATE ON public.${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION simetra.touch();`
        )
      )
    }
  )

  it("a table without trackAuthor gets no author trigger", () => {
    expect(tableOf(domain, "task_comment")).toBeDefined()
    expect(triggersOn(domain, "task_comment")).toEqual([])
  })

  it("without rights functions there is nothing to force", async () => {
    // «Користувачі» й `trackAuthor` є, ролей немає: функції контексту немає.
    const result = await compileRights(rightsFiles())
    expectClean(result, { allow: ["rights.scope-kind-unread"] })
    const model = result.model!
    expect(tableOf(model, "task").columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["created_by_id", "updated_by_id"])
    )
    expect(authorUnits(model)).toEqual([])
  })

  it.each([
    ["one column only", [["created_by_id", "createdBy"]]],
    [
      "a foreign physical name",
      [
        ["author_id", "createdBy"],
        ["updated_by_id", "updatedBy"],
      ],
    ],
  ])("%s is a model defect", async (_, columns) => {
    const table = {
      schema: "public",
      name: "odd",
      origin: { objectId: "x" },
      columns: columns.map(([name, standard]) => ({
        name,
        type: "uuid",
        notNull: false,
        origin: { standard },
      })),
    } as unknown as PhysicalTable
    expect(() =>
      buildAuthorUnits(
        { tables: [table], enumTypes: [] } as unknown as PhysicalSnapshot,
        domain.contracts,
        "camelCase",
        "supabase",
        "app",
        // Парсер не потрібен: перевірка — до генерації SQL.
        undefined as never
      )
    ).toThrow(/^internal: table public\.odd has author columns/)
  })
})

describe("author triggers in a compiled project", () => {
  it("a snake_case project finds author columns by its styled names", async () => {
    // Близнюк у snake_case (Рб1-3): фізичні імена ті самі, тож і тригери
    // авторства мусять збігтися з camelCase одиниця в одиницю.
    const snake = await compileRights(snakeCaseTwin(policyDomain(writeRoles())))
    expectClean(snake)
    const sql = (model: CompiledModel) =>
      authorUnits(model).map((u) => [u.identity, u.sql])
    expect(sql(snake.model!)).toEqual(sql(domain))
    expect(triggersOn(snake.model!, "task")).toEqual([
      tree(
        "CREATE TRIGGER task_simetra_author BEFORE INSERT OR UPDATE ON public.task FOR EACH ROW EXECUTE FUNCTION simetra.author();"
      ),
    ])
  })
})
