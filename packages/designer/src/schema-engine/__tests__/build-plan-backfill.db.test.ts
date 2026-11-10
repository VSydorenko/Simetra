import { describe, expect, it } from "vitest"
import {
  BACKFILL_SETTINGS,
  backfillAction,
  readBackfillCounts,
  withLocalSettings,
} from "simetra/schema"
import { loginUrl, uuid } from "../../../../simetra/test/support"
import { query } from "../../__tests__/support/db"
import {
  compiled,
  COPIER,
  COPIER_PASSWORD,
  dbs,
  EMPTY,
  establish,
  inTarget,
  type Json,
  NOTES,
  notes,
  params,
  plan,
  planned,
  stepMatching,
  useBuildPlanRoles,
  writer,
} from "./build-plan.support"

/**
 * Конвеєр плану `buildPlan` на справжній базі — підрахунок `NULL` перед
 * `NOT NULL` (платформна спека §6.2 п. 4, §6.6): кількість читає план на
 * цілі, відмова — до доказу. Заповнення з default виконує раннер; його
 * DB-тести — поруч із раннером. Спільна підготовка — `build-plan.support.ts`.
 */

useBuildPlanRoles()

const REQUIRED = { type: "String", length: 20, notNull: true }

/** Прийнята таблиця `app.notes` з рядками; `null` — `NULL` у `note`. */
const rows = (...values: (string | null)[]) =>
  `insert into app.notes (id, note) values ${values
    .map((v) => `(gen_random_uuid(), ${v === null ? "null" : `'${v}'`})`)
    .join(", ")};`

describe.concurrent("buildPlan backfill", () => {
  it("counts the NULL values on the target and refuses NOT NULL without a default", async () => {
    const before = await compiled({ [NOTES]: notes() })
    const after = await compiled({ [NOTES]: notes(REQUIRED) })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(url, rows(null, "a", null))
      const outcome = await plan(url, after)
      expect(outcome.status).toBe("refused")
      expect(params(outcome, "plan.not-null-violation")).toEqual([
        { table: "app.notes", column: "note", rows: 2 },
      ])
    })
  })

  it("plans a count under FORCE ROW LEVEL SECURITY for a role that bypasses it", async () => {
    // Роль плану цього стеку має BYPASSRLS, тож політика її не обмежує: тест
    // доводить лише, що FORCE RLS не ламає конвеєр. Р5 (`row_security =
    // off`) доводить наступний тест роллю без обходу
    const before = await compiled({ [NOTES]: notes() })
    const after = await compiled({ [NOTES]: notes(REQUIRED) })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(
        url,
        `${rows(null, null, "a")}
         alter table app.notes enable row level security;
         alter table app.notes force row level security;
         create policy notes_none on app.notes using (false);`
      )
      const outcome = await plan(url, after)
      expect(outcome.status).toBe("refused")
      expect(params(outcome, "plan.not-null-violation")).toEqual([
        { table: "app.notes", column: "note", rows: 2 },
      ])
    })
  })

  it("refuses a count that row security would cut, with its SQLSTATE", async () => {
    // Р5, І3: роль без BYPASSRLS, що не власник таблиці, під
    // `row_security = off` бачить усі рядки або дає гучне `42501` — не
    // неправдивий нуль від політики, що ховає всі рядки
    const before = await compiled({ [NOTES]: notes() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(
        url,
        `${rows(null, null, "a")}
         alter table app.notes enable row level security;
         alter table app.notes force row level security;
         create policy notes_none on app.notes using (false);
         grant usage on schema app to ${COPIER};
         grant select on app.notes to ${COPIER};`
      )
      const login = loginUrl(url, COPIER, COPIER_PASSWORD)
      const result = await dbs.reader.transaction(
        { url: login },
        "rollback",
        (tx) =>
          readBackfillCounts(tx, [
            {
              table: { schema: "app", name: "notes" },
              column: "note",
              count: "nulls",
            },
          ])
      )
      expect(result).toMatchObject({
        refusal: {
          code: "plan.backfill-count-failed",
          params: { table: "app.notes", column: "note", sqlstate: "42501" },
        },
      })
    })
  })

  it("never fills only the rows that row security shows", async () => {
    // І3: крок заповнення під роллю без BYPASSRLS на таблиці з FORCE RLS,
    // де політика показує лише один із двох `NULL`, дає гучне `42501`, а не
    // тихо оновлює видиму частину. Раннер запускає крок роллю з обходом
    // (гейт власника Р10), тож доказ — на тих самих частинах кроку:
    // `BACKFILL_SETTINGS` навколо SQL `backfillAction`
    const before = await compiled({ [NOTES]: notes() })
    const [shown, hidden] = [uuid(9440), uuid(9441)]
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(
        url,
        `insert into app.notes (id, note) values ('${shown}', null), ('${hidden}', null);
         alter table app.notes alter column note set default 'n/a';
         alter table app.notes enable row level security;
         alter table app.notes force row level security;
         create policy notes_one on app.notes using (id = '${shown}');
         grant usage on schema app to ${COPIER};
         grant select, update on app.notes to ${COPIER};`
      )
      const { sql } = backfillAction({
        table: { schema: "app", name: "notes" },
        column: "note",
        rowsAtPlan: 2,
        permission: true,
        default: "'n/a'",
        triggers: [],
      })
      const login = loginUrl(url, COPIER, COPIER_PASSWORD)
      const fill = writer.transaction({ url: login }, "rollback", (tx) =>
        withLocalSettings(tx, BACKFILL_SETTINGS, async () => {
          const [row] = await tx.query<{ n: string }>(
            `WITH filled AS (${sql} RETURNING 1) SELECT pg_catalog.count(*)::text AS n FROM filled`
          )
          return { filled: row?.n }
        })
      )
      await expect(fill).rejects.toMatchObject({ sqlstate: "42501" })
      expect(
        await query(url, "select id, note from app.notes order by id")
      ).toEqual([
        { id: shown, note: null },
        { id: hidden, note: null },
      ])
    })
  })

  it("refuses ADD COLUMN … NOT NULL without a default on a table with rows", async () => {
    const before = await compiled({ [NOTES]: notes() })
    // Колонка, якої ціль ще не має: двигун додає її разом із NOT NULL
    const extra = notes() as unknown as { columns: Json[] }
    extra.columns.push({
      id: uuid(9204),
      name: "extra",
      physicalName: "extra",
      ...REQUIRED,
    })
    const after = await compiled({ [NOTES]: extra })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(url, rows("a", "b"))
      const outcome = await plan(url, after)
      expect(outcome.status).toBe("refused")
      expect(params(outcome, "plan.not-null-violation")).toEqual([
        { table: "app.notes", column: "extra", rows: 2, detail: "addColumn" },
      ])
    })
  })

  it("refuses the backfill of a table with an UPDATE rule with the promotion code", async () => {
    // Р13: передумови запису спільні з кроками даних промоції — правило
    // писало б поза згодою, і лічильник заповнення нічого не довів би
    const before = await compiled({ [NOTES]: notes() })
    const after = await compiled({
      [NOTES]: notes({ ...REQUIRED, default: "''" }),
    })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(
        url,
        `${rows(null, "a")}
         create rule notes_also as on update to app.notes do also select 1;`
      )
      const outcome = await plan(url, after)
      expect(outcome.status).toBe("refused")
      expect(params(outcome, "plan.promotion-unsupported")).toEqual([
        expect.objectContaining({
          write: "backfill",
          reason: "dataStepTable",
          table: "app.notes",
          detail: "rule",
        }),
      ])
    })
  })

  it("marks SET NOT NULL without NULL values for the check before the step", async () => {
    // Р7: `NULL`, що з'являться після плану, раннер рахує перед кроком
    const before = await compiled({ [NOTES]: notes() })
    const after = await compiled({ [NOTES]: notes(REQUIRED) })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(url, rows("a", "b"))
      const artifact = planned(await plan(url, after))
      expect(artifact.steps.filter((s) => s.origin === "backfill")).toEqual([])
      const [setNotNull] = stepMatching(artifact, /SET NOT NULL/)
      expect(setNotNull?.notNull).toEqual([
        { table: { schema: "app", name: "notes" }, column: "note" },
      ])
    })
  })
})
