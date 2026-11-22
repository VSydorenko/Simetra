import { beforeAll, describe, expect, it } from "vitest"
import { commandContextWrite, providerCalls } from "../sql/command-context"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import { loadSqlParser, type SqlParser } from "../sql/parse"

// Р18: значення опції `SET search_path` функції не називає схему платформи —
// інакше її тіло кликало б функції платформи без схеми.
let parse: SqlParser
let plpgsql: PlpgsqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
  plpgsql = await loadPlpgsqlParser()
})

function hits(option: string, owner?: string) {
  const sql = `CREATE FUNCTION public.f() RETURNS int LANGUAGE sql STABLE SECURITY DEFINER ${option} AS $$ SELECT 1 $$;`
  const parsed = parse(sql)
  if (!parsed.ok) throw new Error(parsed.message)
  return commandContextWrite(
    parsed.statements[0]!.stmt,
    sql,
    parse,
    plpgsql,
    providerCalls(undefined, []),
    owner
  ).map((hit) => [hit.form, hit.setting])
}

describe("the search_path function option and the platform schema", () => {
  it.each([
    ["SET search_path = simetra"],
    [`SET search_path = "simetra"`],
    ["SET search_path = SIMETRA"],
    [`SET search_path = "Simetra"`],
    ["SET search_path = public, simetra"],
    [`SET search_path = '  "simetra" , public'`],
    ["SET search_path = simetra, pg_temp"],
    [`SET search_path TO extensions, "simetra"`],
  ])("%s is refused", (option) => {
    expect(hits(option)).toEqual([["functionOption", "search_path"]])
  })

  it.each([
    ["SET search_path = ''"],
    ["SET search_path = public"],
    ["SET search_path = public, extensions"],
    [`SET search_path = "$user", public`],
    ["SET search_path = simetra_x"],
  ])("%s passes", (option) => {
    expect(hits(option)).toEqual([])
  })

  it("$user is refused when the owner is named as the platform schema", () => {
    expect(hits(`SET search_path = "$user", public`, "simetra")).toEqual([
      ["functionOption", "search_path"],
    ])
    expect(hits(`SET search_path = "$user"`, `"SIMETRA"`)).toEqual([
      ["functionOption", "search_path"],
    ])
    expect(hits(`SET search_path = "$user"`, "simetra_owner")).toEqual([])
  })

  it("SET search_path FROM CURRENT is judged as a risk too", () => {
    expect(hits("SET search_path FROM CURRENT")).toEqual([
      ["functionOption", "search_path"],
    ])
    const sql = "ALTER FUNCTION public.f() SET search_path FROM CURRENT;"
    const parsed = parse(sql)
    if (!parsed.ok) throw new Error(parsed.message)
    expect(
      commandContextWrite(
        parsed.statements[0]!.stmt,
        sql,
        parse,
        plpgsql,
        providerCalls(undefined, [])
      ).map((hit) => hit.form)
    ).toEqual(["functionOption"])
  })

  it("an ALTER FUNCTION option is judged the same way", () => {
    const sql = "ALTER FUNCTION public.f() SET search_path = simetra;"
    const parsed = parse(sql)
    if (!parsed.ok) throw new Error(parsed.message)
    expect(
      commandContextWrite(
        parsed.statements[0]!.stmt,
        sql,
        parse,
        plpgsql,
        providerCalls(undefined, [])
      ).map((hit) => hit.form)
    ).toEqual(["functionOption"])
  })
})
