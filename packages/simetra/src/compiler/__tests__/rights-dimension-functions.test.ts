import { describe, expect, it } from "vitest"
import type { Diagnostic } from "simetra/compiler"
import {
  MEMBER_FILE,
  compileRights,
  rightsFiles,
  rolesAndSets,
} from "./fixtures/rights"
import { acceptDebt, uuid } from "./helpers"

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
  // Представлення й функції поза закритою оболонкою — борг; ратчет боргу тут
  // не предмет, тож перелік приймає весь борг фікстури.
  const result = await compileRights(await acceptDebt(files(sql, overrides)))
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

  // Таблиці системних довідників прав (основні й ТЧ дельти) — дані прав:
  // множина значень виміру не може залежати від гранту.
  it.each([
    {
      case: "directly",
      sql: fn(
        "region_ids",
        CLOSED,
        "SELECT a.container FROM public.org_role_assignments a"
      ),
      chain: "public.region_ids",
      object: "public.org_role_assignments",
    },
    {
      case: "through a project sql function",
      sql:
        fn("region_ids", CLOSED, "SELECT public.helper_ids()") +
        fn(
          "helper_ids",
          LINK,
          "SELECT d.dimension FROM public.org_roles_delta d"
        ),
      chain: "public.region_ids → public.helper_ids",
      object: "public.org_roles_delta",
    },
  ])(
    "rejects a dimension function that reads a rights catalog $case",
    async ({ sql, chain, object }) => {
      expect(rightsErrors(await errors(sql, rolesAndSets()))).toEqual([
        {
          code: "rights.dimension-function-reads-rights",
          file: PROJECT,
          pointer: POINTER,
          params: { dimension: "region", chain, object },
        },
      ])
    }
  )

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
    // `RESET ALL` після `SET search_path = ''` повертає шлях сесії.
    expect(
      await linkReason(
        fn(
          "helper_ids",
          `${LINK} RESET ALL`,
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
  describe("fix round 1", () => {
    const head = (body: string) => fn("region_ids", CLOSED, body)
    const params = async (sql: string) =>
      rightsErrors(await errors(sql)).map((d) => [d.code, d.params])
    // Функцію, що виконує текст SQL, відмовляє ранній блок форм модулів
    // (`dynamicText`, Р2c1-32): до судження функції виміру справа не доходить.
    const textWrites = async (sql: string) =>
      (await errors(sql))
        .filter((d) => d.code === "sql.command-context-write")
        .map((d) => d.params?.form)
    const reads = (chain: string, object: string) => [
      "rights.dimension-function-reads-rights",
      { dimension: "region", chain, object },
    ]
    const signature = (fn: string, reason: string) => [
      "rights.dimension-function-signature",
      { dimension: "region", function: fn, reason },
    ]

    it("follows project views", async () => {
      const viewHead = head("SELECT v.id FROM public.v v")
      expect(
        await params(
          viewHead +
            "CREATE VIEW public.v AS SELECT i.id FROM simetra.identities i;\n"
        )
      ).toEqual([reads("public.region_ids → public.v", "simetra.identities")])
      expect(
        await params(
          viewHead +
            "CREATE FUNCTION public.p() RETURNS uuid LANGUAGE plpgsql STABLE AS $$ BEGIN RETURN NULL; END $$;\n" +
            "CREATE VIEW public.v AS SELECT public.p() AS id;\n"
        )
      ).toEqual([reads("public.region_ids → public.v → public.p", "plpgsql")])
      expect(
        await params(
          viewHead +
            "CREATE VIEW public.v AS SELECT r.region_id AS id FROM member_region r;\n"
        )
      ).toEqual([signature("public.v", "viewUnqualified")])
      expect(
        await params(
          viewHead +
            "CREATE VIEW public.v AS SELECT r.region_id AS id FROM public.member_region r;\n"
        )
      ).toEqual([])
    })

    it("rejects SQL-standard bodies in the head and in a link", async () => {
      expect(
        await params(
          "CREATE FUNCTION public.region_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' BEGIN ATOMIC SELECT NULL::uuid; END;\n"
        )
      ).toEqual([signature("public.region_ids", "sqlBody")])
      expect(
        await params(
          head("SELECT public.helper_id()") +
            "CREATE FUNCTION public.helper_id() RETURNS uuid LANGUAGE sql STABLE SET search_path = '' RETURN NULL::uuid;\n"
        )
      ).toEqual([signature("public.helper_id", "sqlBody")])
    })

    it("judges a project function that shares a membership function name", async () => {
      // Стадія 4 уже відхиляє колізію імен (`physical.function-duplicate` на
      // `/membership`), тож членство стає недовіреним; обхід і сам судить
      // одиницю проєкту раніше за довіру до згенерованого імені.
      const found = await errors(
        head(
          "SELECT r.region_id FROM public.member_region r WHERE r.member_id = public.org_member_my_member(r.org_id::text)"
        ) +
          "CREATE FUNCTION public.org_member_my_member(p text) RETURNS uuid LANGUAGE plpgsql STABLE AS $$ BEGIN RETURN NULL; END $$;\n"
      )
      expect(found.map((d) => d.code)).toContain("physical.function-duplicate")
      expect(rightsErrors(found).map((d) => [d.code, d.params])).toEqual([
        reads("public.region_ids → public.org_member_my_member", "plpgsql"),
      ])
    })

    it("requires schema-qualified calls in views", async () => {
      const viewHead = head("SELECT v.id FROM public.v v")
      const view = (select: string) =>
        viewHead + `CREATE VIEW public.v AS ${select};\n`
      expect(
        await params(
          view(
            "SELECT lower(r.region_id::text)::uuid AS id FROM public.member_region r"
          )
        )
      ).toEqual([signature("public.v", "viewUnqualified")])
      // Не виклики функцій: COALESCE, NULLIF, CASE і CAST — вирази дерева.
      expect(
        await params(
          view(
            "SELECT COALESCE(NULLIF(r.region_id, r.region_id), CASE WHEN r.region_id IS NULL THEN NULL ELSE CAST(r.region_id AS uuid) END) AS id, pg_catalog.lower('x') AS t FROM public.member_region r"
          )
        )
      ).toEqual([])
    })

    it.each([
      ["schema_to_xml", "schema_to_xml('public', true, true, '')"],
      [
        "pg_catalog.database_to_xml",
        "pg_catalog.database_to_xml(true, true, '')",
      ],
      ["ts_stat", "ts_stat('select 1')"],
      ["ts_rewrite", "ts_rewrite('a'::tsquery, 'select 1')"],
    ])("rejects the dynamic builtin %s", async (_name, call) => {
      expect(
        await textWrites(head(`SELECT NULL::uuid WHERE ${call} IS NOT NULL`))
      ).toEqual(["dynamicText"])
    })

    it("rejects builtins that execute SQL from a string", async () => {
      expect(
        await textWrites(
          head(
            "SELECT NULL::uuid WHERE query_to_xml('select 1', true, true, '') IS NOT NULL"
          )
        )
      ).toEqual(["dynamicText"])
      expect(
        await textWrites(
          head(
            "SELECT NULL::uuid WHERE pg_catalog.table_to_xml('public.member_region'::regclass, true, true, '') IS NOT NULL"
          )
        )
      ).toEqual(["dynamicText"])
    })

    it("rejects other platform functions and non-sql links, allows pg_catalog builtins", async () => {
      expect(await params(head("SELECT simetra.role_ids()"))).toEqual([
        reads("public.region_ids", "simetra.role_ids"),
      ])
      expect(
        await params(
          head("SELECT public.helper_ids()") +
            "CREATE FUNCTION public.helper_ids() RETURNS SETOF uuid LANGUAGE c STABLE AS 'helper_lib', 'helper_ids';\n"
        )
      ).toEqual([reads("public.region_ids → public.helper_ids", "unknown")])
      expect(await errors(head("SELECT pg_catalog.lower('x')::uuid"))).toEqual(
        []
      )
    })
  })
})
