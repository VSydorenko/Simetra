import { PLATFORM_ROLES, type Filter, type RuntimeCatalog } from "simetra/model"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { uuid } from "../../src/compiler/__tests__/helpers"
import {
  ROLE_FILE,
  adminRoles,
  catalog as catalogObject,
  compileRights,
  grant,
  objects,
  policyDomain,
  role,
  type Layer,
} from "../../src/compiler/__tests__/fixtures/rights"
import { buildRuntimeCatalog } from "../../src/compiler/runtime-catalog"
import { executeRead, prepareRead, renderKnown } from "../../src/server/read"
import { signUp } from "./auth"
import { claimsFor, queryAs } from "./connection"
import { type PlanNode, scansOf } from "./explain-plan"
import { testProvider } from "./profile"
import {
  assignmentRow,
  deploy,
  describeTransaction,
  insert,
  profileLayer,
} from "./rights-seed"

/**
 * План пошуку під RLS на великій таблиці (спека П4-B §4.1, Рд43,
 * ADR-0097): `startsWith` за полем пошуку читається діапазоном індексу
 * нормалізованої колонки від ролі запиту, а `contains` лишається скануванням
 * рядків свого скоупу без індексу пошуку. Чи бере планувальник індекс під
 * політикою членства і скільки рядків читає скан, вирішує лише справжній
 * Postgres на засіві зі статистикою. Тут же замір `contains` за розміром
 * скоупу — з нього межа §4.1. Одне розгортання й засів на опис; транзакція
 * відкочується, тож на стеку нічого не лишається.
 *
 * Засів: три скоупи читача різного розміру (найбільший — `~100 000` рядків) і
 * чужий скоуп того самого розміру. Найменування — 32 символи: парні рядки —
 * латиниця (шістнадцяткова, великими), непарні — кирилиця (та сама цифра
 * через відповідність символів, великими); запит — малими, тож регістр
 * рядка й запиту різний.
 */

const TABLE = "party"
const PARTY_FILE = "catalogs/Party/Party.meta.json"
const PARTY_READER_ID = uuid(9500)
const PAGE = 200

/** Скоупи читача: розміри для заміру `contains`; найбільший — таблиця І1. */
const OWN_SIZES = [10_000, 30_000, 100_000]
const FOREIGN_SIZE = 100_000
/** Прогони заміру на скоуп після прогрівального; береться медіана. */
const RUNS = 5

/** Цифри md5 → великі літери кирилиці: той самий розподіл, інша абетка. */
const CYRILLIC = "АБВГҐДЕЄЖЗИІЇЙКЛ"

/** Префікси `startsWith`: латиниця й кирилиця, малими. */
const PREFIXES = ["a1b", "абв"]
/** Підрядок `contains` з середини: збігів мало, тож скан не зупиняє `LIMIT`. */
const INFIX = "c0de"

function partyLayer(): Layer {
  return {
    // Типове поле пошуку довідника — найменування (`mainPresentation`).
    [PARTY_FILE]: catalogObject(uuid(9400), "Party", TABLE),
    [ROLE_FILE("PartyReader")]: role(
      PARTY_READER_ID,
      "PartyReader",
      { scopeKind: "org" },
      { grants: [grant(objects(["Catalog", "Party"]), ["read"], "any")] }
    ),
  }
}

/** Рядки, прочитані вузлами таблиці: повернуті й відкинуті фільтром, усі цикли. */
const readRows = (scans: PlanNode[]) =>
  scans.reduce(
    (sum, n) =>
      sum + ((n.rows ?? 0) + (n.rowsRemovedByFilter ?? 0)) * (n.loops ?? 1),
    0
  )

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

export function defineSearchIndexPlanCases(): void {
  describe("search plans under RLS", () => {
    const tx = describeTransaction()
    let catalog: RuntimeCatalog
    let reader: string
    let scopeAttribute: string
    let searchIndex: string
    const own = OWN_SIZES.map((size, i) => ({ id: uuid(9901 + i), size }))
    const foreign = { id: uuid(9909), size: FOREIGN_SIZE }

    beforeAll(async () => {
      const result = await compileRights(
        policyDomain(adminRoles(), partyLayer(), profileLayer())
      )
      expect(result.diagnostics).toEqual([])
      catalog = buildRuntimeCatalog(result.model!)
      const party = catalog.objects.find((o) => o.name === "Party")!
      expect(
        party.attributes.find((a) => a.name === "description")!.search
      ).toBe("description_search")
      scopeAttribute = party.attributes.find(
        (a) => a.column === party.scopeColumn
      )!.name
      const client = await tx.open()
      await deploy(client, result.model!)
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_ROLES.command}`
      )

      reader = await signUp(client)
      for (const scope of [...own, foreign])
        await insert(client, "organization", { id: scope.id })
      for (const [i, scope] of own.entries()) {
        const member = uuid(9910 + i)
        await insert(client, "org_member", {
          id: member,
          org_id: scope.id,
          user_id: reader,
        })
        await insert(client, "org_role_assignments", {
          org_id: scope.id,
          ...assignmentRow(member, { archetype: PARTY_READER_ID }),
        })
      }
      // Чужий скоуп — ті самі найменування: рядок чужого скоупу в результаті
      // чи в читанні видно одразу.
      await client.query(
        `INSERT INTO public.${TABLE} (id, org_id, description)
         SELECT gen_random_uuid(), s.id,
                CASE WHEN g % 2 = 0 THEN upper(md5(g::text))
                     ELSE translate(md5(g::text), '0123456789abcdef', $3) END
         FROM unnest($1::uuid[], $2::int[]) AS s(id, size)
         CROSS JOIN LATERAL generate_series(1, s.size) AS g`,
        [
          [...own, foreign].map((s) => s.id),
          [...own, foreign].map((s) => s.size),
          CYRILLIC,
        ]
      )
      await client.query(`ANALYZE public.${TABLE}`)

      const { rows: indexes } = await client.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
         WHERE i.indrelid = 'public.${TABLE}'::regclass
           AND pg_get_indexdef(i.indexrelid) LIKE '%(description_search text_pattern_ops)%'`
      )
      expect(indexes).toHaveLength(1)
      searchIndex = indexes[0]!.name
    }, 300_000)

    afterAll(() => tx.close())

    /** Ключі рядків від власника (без RLS): еталон множини читання. */
    const expected = async (where: string, params: unknown[]) =>
      (
        await tx
          .client()
          .query<{ id: string }>(
            `SELECT id FROM public.${TABLE} WHERE ${where} ORDER BY id`,
            params
          )
      ).rows.map((r) => r.id)

    const statementOf = (where: Filter) => {
      const prepared = prepareRead(catalog, {
        object: { kind: "Catalog", name: "Party" },
        limit: PAGE,
        where,
      })
      if ("error" in prepared) throw new Error(JSON.stringify(prepared.error))
      return renderKnown(prepared.plan, null)
    }

    /** `EXPLAIN (ANALYZE)` від ролі запиту; `warm` прогонів перед ним відкидаються. */
    const explain = async (where: Filter, warm = 1) => {
      const { text, params } = statementOf(where)
      let root: Record<string, unknown> = {}
      for (let run = 0; run <= warm; run++) {
        const result = await queryAs<{ "QUERY PLAN": unknown }>(
          tx.client(),
          "user",
          claimsFor("user", reader),
          `EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${text}`,
          params
        )
        if (!("rows" in result))
          throw new Error(`EXPLAIN failed: ${result.code}`)
        root = (result.rows[0]!["QUERY PLAN"] as Record<string, unknown>[])[0]!
      }
      return {
        root,
        scans: scansOf(root, TABLE),
        ms: root["Execution Time"] as number,
      }
    }

    /** Ключі, які читає роль запиту тим самим шляхом, що й сервер. */
    const readKeys = async (where: Filter) => {
      const prepared = prepareRead(catalog, {
        object: { kind: "Catalog", name: "Party" },
        limit: PAGE,
        where,
      })
      if ("error" in prepared) throw new Error(JSON.stringify(prepared.error))
      const result = await executeRead(
        prepared.object,
        prepared.plan,
        async (statement) => {
          const read = await queryAs<Record<string, unknown>>(
            tx.client(),
            "user",
            claimsFor("user", reader),
            statement.text,
            statement.params
          )
          if (!("rows" in read)) throw new Error(`read failed: ${read.code}`)
          return read.rows
        },
        null
      )
      if (!("rows" in result)) throw new Error(JSON.stringify(result))
      return (result.rows as Record<string, unknown>[])
        .map((row) => row.ref as string)
        .sort()
    }

    const ownIds = () => own.map((s) => s.id)

    it.each(PREFIXES)(
      "startsWith %s reads the normalized column's index range from the request role",
      async (prefix) => {
        const where: Filter = {
          attribute: "description",
          op: "startsWith",
          value: prefix,
        }
        const { scans, ms } = await explain(where)
        const arms = scans.flatMap((n) => n.arms)
        console.info(
          `search-index-plan ${testProvider()} startsWith ${prefix}: ${ms} ms, read ${readRows(scans)}, ${JSON.stringify(scans.map((n) => ({ type: n.type, arms: n.arms })))}`
        )
        expect(scans.filter((n) => n.type === "Seq Scan")).toEqual([])
        // Діапазон `text_pattern_ops` — `starts_with` став умовою індексу, а
        // не фільтром після скану видимої множини.
        expect(arms).toContainEqual({
          index: searchIndex,
          condition: expect.stringMatching(
            /description_search ~>=~ .*description_search ~<~ /
          ),
        })
        const keys = await expected(
          `org_id = ANY($1::uuid[]) AND description LIKE upper($2) || '%'`,
          [ownIds(), prefix]
        )
        expect(keys.length, "the prefix matches rows").toBeGreaterThan(0)
        expect(keys.length).toBeLessThan(PAGE)
        // Лише свій скоуп: однакові найменування чужого скоупу RLS ховає.
        expect(await readKeys(where)).toEqual(keys)
      }
    )

    it.each(own.map((scope) => ({ scope })))(
      "contains scans only its scope of $scope.size rows, without the search index",
      async ({ scope }) => {
        const where: Filter = {
          and: [
            { attribute: scopeAttribute, op: "eq", value: scope.id },
            { attribute: "description", op: "contains", value: INFIX },
          ],
        }
        const runs: number[] = []
        let scans: PlanNode[] = []
        for (let run = 0; run < RUNS; run++) {
          const explained = await explain(where, run === 0 ? 1 : 0)
          runs.push(explained.ms)
          scans = explained.scans
        }
        const read = readRows(scans)
        console.info(
          `search-index-plan ${testProvider()} contains scope ${scope.size}: median ${median(runs)} ms (${runs.join(", ")}), read ${read}, ${JSON.stringify(scans.map((n) => ({ type: n.type, arms: n.arms, filter: n.filter })))}`
        )
        expect(scans.filter((n) => n.type === "Seq Scan")).toEqual([])
        const arms = scans.flatMap((n) => n.arms)
        expect(arms.map((a) => a.index)).not.toContain(searchIndex)
        // Скан не виходить за свій скоуп: прочитано не більше рядків, ніж у
        // ньому, а чужі скоупи того самого розміру не читаються.
        expect(read).toBeLessThanOrEqual(scope.size)
        const keys = await expected(
          `org_id = $1 AND description ILIKE '%' || $2 || '%'`,
          [scope.id, INFIX]
        )
        expect(keys.length, "the infix matches rows").toBeGreaterThan(0)
        expect(keys.length).toBeLessThan(PAGE)
        expect(await readKeys(where)).toEqual(keys)
      }
    )
  })
}
