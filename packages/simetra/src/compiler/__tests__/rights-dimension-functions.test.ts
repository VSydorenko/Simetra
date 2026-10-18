import { describe, expect, it } from "vitest"
import type { Diagnostic } from "simetra/compiler"
import { MEMBER_FILE, compileRights, rightsFiles } from "./fixtures/rights"
import { uuid } from "./helpers"

const PROJECT = "project.meta.json"
const POINTER = "/accessDimensions/0/values/function"
const SQL_FILE = "sql/public/dimension-functions.sql"

/** Закрита оболонка функції виміру — та сама, що в функції множини скоупу. */
const CLOSED =
  "RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''"
/** Ланці ланцюжка вистачає мови й порожнього search_path. */
const LINK = "RETURNS SETOF uuid LANGUAGE sql STABLE SET search_path = ''"

const fn = (name: string, tail: string, body: string) =>
  `CREATE FUNCTION public.${name}() ${tail} AS $$ ${body} $$;\n`

/** Проєкт прав із виміром `region`, значення якого дає `public.region_ids()`. */
function files(
  sql: string,
  overrides: Record<string, Record<string, unknown>> = {}
) {
  const result = rightsFiles({
    [PROJECT]: {
      accessDimensions: [
        {
          id: uuid(6060),
          name: "region",
          target: { kind: "Catalog", name: "Region" },
          values: { function: { name: "region_ids" } },
        },
      ],
    },
    ...overrides,
  })
  result.set(SQL_FILE, sql)
  return result
}

async function errors(sql: string, overrides = {}) {
  const result = await compileRights(files(sql, overrides))
  return result.diagnostics.filter((d) => d.severity === "error")
}

const rightsErrors = (found: Diagnostic[]) =>
  found
    .filter((d) => d.code.startsWith("rights.dimension-function"))
    .map((d) => ({
      code: d.code,
      file: d.file,
      pointer: d.pointer,
      params: d.params,
    }))

describe("access dimension value function", () => {
  it("accepts a closed set function that reads app tables and the current user", async () => {
    expect(
      await errors(
        fn(
          "region_ids",
          CLOSED,
          "SELECT r.region_id FROM public.member_region r WHERE r.member_id = (SELECT simetra.current_user_id())"
        )
      )
    ).toEqual([])
  })

  it("follows calls into project sql functions", async () => {
    const head = fn("region_ids", CLOSED, "SELECT public.helper_ids()")
    expect(
      await errors(
        head +
          fn(
            "helper_ids",
            LINK,
            "SELECT r.region_id FROM public.member_region r"
          )
      )
    ).toEqual([])
    expect(
      rightsErrors(
        await errors(
          head + fn("helper_ids", LINK, "SELECT i.id FROM simetra.identities i")
        )
      )
    ).toEqual([
      {
        code: "rights.dimension-function-reads-rights",
        file: PROJECT,
        pointer: POINTER,
        params: {
          dimension: "region",
          chain: "public.region_ids → public.helper_ids",
          object: "simetra.identities",
        },
      },
    ])
  })

  it("fails closed on plpgsql and unknown functions in the chain", async () => {
    const plpgsql = await errors(
      fn("region_ids", CLOSED, "SELECT public.helper_ids()") +
        fn(
          "helper_ids",
          "RETURNS SETOF uuid LANGUAGE plpgsql STABLE SET search_path = ''",
          "BEGIN RETURN QUERY SELECT NULL::uuid; END"
        )
    )
    expect(rightsErrors(plpgsql).map((d) => d.params)).toEqual([
      {
        dimension: "region",
        chain: "public.region_ids → public.helper_ids",
        object: "plpgsql",
      },
    ])
    const unknown = await errors(fn("region_ids", CLOSED, "SELECT ext.foo()"))
    expect(rightsErrors(unknown).map((d) => d.params)).toEqual([
      {
        dimension: "region",
        chain: "public.region_ids → ext.foo",
        object: "unknown",
      },
    ])
  })

  it("allows generated membership functions and builtins", async () => {
    expect(
      await errors(
        fn(
          "region_ids",
          CLOSED,
          "SELECT r.region_id FROM public.member_region r WHERE r.member_id = coalesce(public.org_member_my_member(r.org_id), lower('x')::uuid)"
        )
      )
    ).toEqual([])
  })

  it("reports a missing function and a wrong signature", async () => {
    expect(
      rightsErrors(await errors(fn("other_ids", CLOSED, "SELECT NULL::uuid")))
    ).toEqual([
      {
        code: "rights.dimension-function-missing",
        file: PROJECT,
        pointer: POINTER,
        params: { dimension: "region", function: "public.region_ids" },
      },
    ])
    expect(
      rightsErrors(
        await errors(
          fn(
            "region_ids",
            "RETURNS SETOF uuid LANGUAGE sql STABLE SET search_path = ''",
            "SELECT NULL::uuid"
          )
        )
      )
    ).toEqual([
      {
        code: "rights.dimension-function-signature",
        file: PROJECT,
        pointer: POINTER,
        params: {
          dimension: "region",
          function: "public.region_ids",
          reason: "security",
        },
      },
    ])
    expect(
      rightsErrors(
        await errors(
          fn(
            "region_ids",
            "RETURNS SETOF uuid LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''",
            "SELECT NULL::uuid"
          )
        )
      ).map((d) => d.params)
    ).toEqual([
      {
        dimension: "region",
        function: "public.region_ids",
        problem: "it is not STABLE",
      },
    ])
  })

  it("checks the closed form of every function in the chain", async () => {
    const head = fn("region_ids", CLOSED, "SELECT public.helper_ids()")
    const linkReason = async (link: string) =>
      rightsErrors(await errors(head + link)).map((d) => [d.code, d.params])
    expect(
      await linkReason(
        fn(
          "helper_ids",
          "RETURNS SETOF uuid LANGUAGE sql STABLE SET search_path = simetra",
          "SELECT i.id FROM identities i"
        )
      )
    ).toEqual([
      [
        "rights.dimension-function-signature",
        {
          dimension: "region",
          function: "public.helper_ids",
          reason: "searchPath",
        },
      ],
    ])
    expect(
      await linkReason(
        fn(
          "helper_ids",
          "RETURNS SETOF uuid LANGUAGE sql STABLE",
          "SELECT r.region_id FROM public.member_region r"
        )
      )
    ).toEqual([
      [
        "rights.dimension-function-signature",
        {
          dimension: "region",
          function: "public.helper_ids",
          reason: "searchPath",
        },
      ],
    ])
    expect(
      await linkReason(
        fn("helper_ids", LINK, "SELECT r.region_id FROM member_region r")
      )
    ).toEqual([
      [
        "rights.dimension-function-signature",
        {
          dimension: "region",
          function: "public.helper_ids",
          reason: "unqualified",
        },
      ],
    ])
  })

  it("does not loop on recursive calls", async () => {
    // Цикл викликів уже відхиляє порядок створення (`sql.dependency-cycle`);
    // обхід мусить на ньому завершитися, не додавши власних діагностик.
    expect(
      rightsErrors(
        await errors(
          fn("region_ids", CLOSED, "SELECT public.helper_ids()") +
            fn("helper_ids", LINK, "SELECT public.region_ids()")
        )
      )
    ).toEqual([])
  })

  it("does not trust functions of a broken membership", async () => {
    const found = await errors(
      fn(
        "region_ids",
        CLOSED,
        "SELECT r.region_id FROM public.member_region r WHERE r.member_id = public.org_member_my_member(r.org_id)"
      ),
      {
        [MEMBER_FILE]: {
          membership: { user: "user" },
          attributes: [
            {
              id: uuid(6005),
              name: "user",
              physicalName: "user_id",
              type: "Ref",
              ref: { kind: "Catalog", name: "Region" },
            },
          ],
        },
      }
    )
    expect(found.map((d) => d.code)).toContain("membership.user-not-users-ref")
    expect(rightsErrors(found).map((d) => d.params)).toEqual([
      {
        dimension: "region",
        chain: "public.region_ids → public.org_member_my_member",
        object: "unknown",
      },
    ])
  })
})
