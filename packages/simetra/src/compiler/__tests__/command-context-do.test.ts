import { beforeAll, describe, expect, it } from "vitest"
import { commandContextWrite, providerCalls } from "../sql/command-context"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import { loadSqlParser, type SqlParser } from "../sql/parse"

// Блок `DO` (вкладений у тіло, літеральний `EXECUTE 'DO …'`, чи окремий
// оператор) виконується в тій самій сесії: захищене налаштування в ньому —
// той самий запис, що й у тілі функції.
let parse: SqlParser
let plpgsql: PlpgsqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
  plpgsql = await loadPlpgsqlParser()
})

function forms(sql: string) {
  const parsed = parse(sql)
  if (!parsed.ok) throw new Error(parsed.message)
  return commandContextWrite(
    parsed.statements[0]!.stmt,
    sql,
    parse,
    plpgsql,
    providerCalls(undefined, [])
  ).map((hit) => [hit.form, hit.setting])
}

const definer = (body: string) =>
  `CREATE FUNCTION public.f() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN ${body} RETURN 1; END $$;`

describe("a DO block is judged by the protected-setting rule", () => {
  it("a DO statement in a plpgsql body that sets search_path is a write", () => {
    expect(
      forms(
        definer(
          "DO $x$ BEGIN SET search_path = simetra; PERFORM storage_instance_id(); END $x$;"
        )
      )
    ).toEqual([["setStatement", "search_path"]])
  })

  it("set_config in a nested DO is a write", () => {
    expect(
      forms(
        definer(
          "DO $x$ BEGIN PERFORM set_config('search_path', 'simetra', true); END $x$;"
        )
      )
    ).toEqual([["setConfig", "search_path"]])
  })

  it("EXECUTE of a literal DO is a write", () => {
    expect(
      forms(
        definer("EXECUTE 'DO $x$ BEGIN SET search_path = simetra; END $x$';")
      )
    ).toEqual([["setStatement", "search_path"]])
  })

  it("a DO inside a DO is judged to the bottom", () => {
    expect(
      forms(
        definer(
          "DO $a$ BEGIN EXECUTE 'DO $b$ BEGIN SET ROLE postgres; END $b$'; END $a$;"
        )
      )
    ).toEqual([["setStatement", "role"]])
  })

  it("a top-level DO with an EXECUTE of an ALTER FUNCTION option is a write", () => {
    expect(
      forms(
        "DO $x$ BEGIN EXECUTE 'ALTER FUNCTION public.f() SET search_path = simetra'; END $x$;"
      )
    ).toEqual([["setStatement", "search_path"]])
  })

  it("a harmless DO passes", () => {
    expect(forms(definer("DO $x$ BEGIN PERFORM 1; END $x$;"))).toEqual([])
    expect(forms("DO $x$ BEGIN PERFORM 1; END $x$;")).toEqual([])
  })
})
