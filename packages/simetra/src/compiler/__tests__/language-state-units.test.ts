import { beforeAll, describe, expect, it } from "vitest"
import { isObjectTable } from "simetra/model"
import { compile, type CompiledModel } from "simetra/compiler"
import { languageStateNames } from "../language-state-units"
import { executeGrants } from "../sql/execute-grants"
import { hasEmptySearchPath, routineLanguage } from "../sql/closed-forms"
import {
  LANGUAGES_TABLE,
  compiledPolicyDomain,
  languagesLayer,
  policyDomain,
} from "./fixtures/rights"
import {
  bodyShape,
  expectedFunction,
  loadShapeParsers,
  nodes,
  tree,
} from "./fixtures/sql-shape"
import {
  catalog,
  expectClean,
  languagesCatalog,
  metaFiles,
  project,
} from "./helpers"

const FN = "public.languages_simetra_language"

/** Профіль `supabase`, camelCase, з функціями прав (домен політик). */
let camel: CompiledModel
/** Профіль `postgres`, `snake_case`, без ролей — отже без функцій прав. */
let snake: CompiledModel
beforeAll(async () => {
  await loadShapeParsers()
  const domain = await compile(policyDomain(languagesLayer()))
  expectClean(domain)
  camel = domain.model!
  const plain = await compile(
    metaFiles({
      "project.meta.json": project({
        database: { provider: "postgres" },
        naming: { attributeCase: "snake_case" },
        primaryDataLanguage: "uk",
      }),
      "catalogs/Languages/Languages.meta.json": languagesCatalog({
        scope: "none",
      }),
      "catalogs/Item/Item.meta.json": catalog("Item"),
    })
  )
  expectClean(plain, { allow: ["rights.scope-kind-unread"] })
  snake = plain.model!
})

const MODELS: [string, () => CompiledModel, "supabase" | "postgres"][] = [
  ["supabase camelCase with rights", () => camel, "supabase"],
  ["postgres snake_case without rights", () => snake, "postgres"],
]

const languageUnits = (model: CompiledModel) =>
  model.sqlUnits.filter(
    (u) =>
      u.generator === "mechanics" &&
      u.identity.includes(`${LANGUAGES_TABLE}_simetra_language`)
  )

const refuse =
  "RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'command.invalid', DETAIL = 'language-state';"

/** Оракул тіла (Р-B2-4, матриця §3, шов Р-B2-9) — літералом, не з факту T0. */
const BODY = [
  "BEGIN",
  "  IF TG_OP = 'TRUNCATE' THEN",
  `    ${refuse}`,
  "  END IF;",
  "  IF TG_OP = 'DELETE' THEN",
  `    ${refuse}`,
  "  END IF;",
  "  IF TG_OP = 'INSERT' THEN",
  "    IF NEW.is_primary IS NOT TRUE AND NEW.state IS DISTINCT FROM 'draft' THEN",
  `      ${refuse}`,
  "    END IF;",
  "    RETURN NEW;",
  "  END IF;",
  "  IF NEW.is_primary IS DISTINCT FROM OLD.is_primary THEN",
  `    ${refuse}`,
  "  END IF;",
  "  IF NEW.code IS DISTINCT FROM OLD.code THEN",
  `    ${refuse}`,
  "  END IF;",
  "  IF NEW.deletion_mark IS TRUE AND OLD.deletion_mark IS NOT TRUE THEN",
  `    ${refuse}`,
  "  END IF;",
  "  IF NEW.state IS DISTINCT FROM OLD.state THEN",
  "    IF ((OLD.state, NEW.state) IN (('draft', 'published'), ('draft', 'disabled'), ('published', 'disabled'), ('disabled', 'draft'), ('disabled', 'published'))) IS NOT TRUE THEN",
  `      ${refuse}`,
  "    END IF;",
  "    IF NEW.state = 'published' AND NEW.is_primary IS NOT TRUE THEN",
  "      <<publication_gate>>",
  "      BEGIN",
  "        NULL;",
  "      END publication_gate;",
  "    END IF;",
  "  END IF;",
  "  RETURN NEW;",
  "END",
].join("\n")

describe("buildLanguageStateUnits (Р-B2-4)", () => {
  describe.each(MODELS)("%s", (_, model, provider) => {
    const fn = () =>
      model().sqlUnits.find((u) => u.identity === `function:${FN}()`)!

    it("refuses TRUNCATE, DELETE, a non-draft insert, changes of is_primary, code and the mark, and transitions outside the matrix", () => {
      expect(bodyShape(fn().sql)).toEqual(bodyShape(expectedFunction(FN, BODY)))
    })

    it("keeps the empty publication gate of B4 as a named block on the move of a non-primary language to published (Р-B2-9)", () => {
      // Форма тіла мітки блоку не несе: мітку видно лише в тексті функції.
      expect(fn().sql).toContain("<<publication_gate>>")
      expect(fn().sql).toContain("END publication_gate;")
    })

    it("the function is SECURITY DEFINER with empty search_path and row_security off, executable by nobody", () => {
      const create = (
        fn().tree as {
          CreateFunctionStmt: {
            options: { DefElem: { defname: string; arg?: unknown } }[]
          }
        }
      ).CreateFunctionStmt
      expect(routineLanguage(fn().tree as never)).toBe("plpgsql")
      expect(
        create.options.find((o) => o.DefElem.defname === "security")?.DefElem
          .arg
      ).toEqual({ Boolean: { boolval: true } })
      expect(hasEmptySearchPath(fn().tree as never)).toBe(true)
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
        languageUnits(model())
          .filter((u) => u.class === "grant")
          .map((u) => u.sql)
          .sort()
      ).toEqual(executeGrants(`${FN}()`, [], provider).sort())
    })

    it("one row BEFORE trigger on every write and a statement guard of TRUNCATE call the one function", () => {
      expect(
        languageUnits(model())
          .filter((u) => u.class === "trigger")
          .map((u) => u.tree)
      ).toEqual([
        tree(
          `CREATE TRIGGER languages_simetra_language BEFORE INSERT OR UPDATE OR DELETE ON public.languages FOR EACH ROW EXECUTE FUNCTION ${FN}();`
        ),
        tree(
          `CREATE TRIGGER languages_simetra_language_truncate BEFORE TRUNCATE ON public.languages FOR EACH STATEMENT EXECUTE FUNCTION ${FN}();`
        ),
      ])
    })

    it("a catalog without the role gets no language state unit", () => {
      const languages = model().physical.tables.find(
        (t) => t.name === LANGUAGES_TABLE
      )!
      if (!isObjectTable(languages)) throw new Error("not an object table")
      expect(
        new Set(
          model()
            .sqlUnits.filter((u) => u.identity.includes("_simetra_language"))
            .map((u) => u.ownerObjectId)
        )
      ).toEqual(new Set([languages.origin.objectId]))
    })
  })

  it("reserves the function name against a verbatim function", async () => {
    const { diagnostics } = await compiledPolicyDomain(
      {
        "sql/public/clash.sql":
          "CREATE FUNCTION public.languages_simetra_language() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN RETURN NULL; END $$;",
      },
      [languagesLayer()]
    )
    expect(
      diagnostics
        .filter((d) => d.code === "physical.function-duplicate")
        .map((d) => d.params)
    ).toEqual([
      {
        schema: "public",
        name: "languages_simetra_language",
        description: "language state check of public.languages",
        other: "a function in sql/public/clash.sql",
      },
    ])
  })

  it("the row trigger fires before the touch trigger: Postgres orders BEFORE triggers by name bytes", () => {
    const names = languageStateNames({ schema: "public", name: "a".repeat(60) })
    expect(names.fn).toEqual({ schema: "public", name: names.row })
    expect(
      Buffer.compare(
        Buffer.from(
          languageStateNames({ schema: "public", name: "items" }).row
        ),
        Buffer.from("items_simetra_touch")
      )
    ).toBe(-1)
    expect(new TextEncoder().encode(names.truncate).length).toBeLessThanOrEqual(
      63
    )
  })
})
