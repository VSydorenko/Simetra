import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { rehearsalHash } from "simetra/schema"
import { describe, expect, it } from "vitest"
import type { ApplyData, PlanData } from "../tools/apply-tools"
import { inTarget, query, withCopy } from "./support/db"
import {
  scope,
  usePromotionCleanup,
  EMPTY,
  templateOf,
  ROWS,
  projectWith,
  options,
  call,
  codes,
  errors,
  planned,
  apply,
  promoted,
  state,
  ledger,
  reportAt,
  INACTIVE,
  AUDIT,
  audited,
} from "./promotion-commit.support"

/**
 * Повний цикл промоції з кроком даних інструментами:
 * `promote` → `plan` → репетиція на копії цілі з даними → `apply` з
 * `COMMIT` → повторний `plan` нічого не планує. Копія — окрема база
 * `CREATE DATABASE … TEMPLATE <ціль>`: ті самі факти сервера, голова ledger і
 * власники, тож раннер приймає її за копію цієї цілі. Проєкт синтетичний.
 */

usePromotionCleanup()

describe("promotion commit", () => {
  it("promotes, rehearses on a copy with data, commits and plans nothing", async () => {
    await inTarget(EMPTY, scope, async (url) => {
      const { dir, data } = await promoted(url)
      expect(
        await query(
          url,
          "select count(*) filter (where inactive)::int as t, count(*) filter (where inactive is null)::int as n from app.members"
        )
      ).toEqual([{ t: INACTIVE, n: 67 }])

      // План промоції з одним кроком даних; попередження про відкладений
      // COMMIT більше немає
      const promotion = data.promotion!
      expect(promotion.tables).toEqual([
        { schema: "app", from: "members", to: "member" },
      ])
      expect(promotion.data).toHaveLength(1)
      expect(promotion.data[0]).toMatchObject({
        before: { schema: "app", table: "members" },
        after: { schema: "app", table: "member" },
        columns: [
          {
            column: "deletion_mark",
            expression: "coalesce(inactive, false)",
          },
        ],
      })
      const plan = await call("plan", {}, options(dir, url))
      expect(codes(plan)).not.toContain("plan.promotion-commit-pending")

      // Репетиція на копії з даними: відкат, звіт записано, рядки — усі 500
      let file = ""
      await withCopy(templateOf(url), async (copy) => {
        const r = await apply(dir, copy, data, { rehearse: true })
        expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
        expect((r.data as ApplyData).status).toBe("rolledBack")
        file = (r.data as ApplyData).report!
        expect(file).toMatch(/\.rehearsal\.json$/)
      })
      const report = await reportAt(dir, file)
      expect(report.planHash).toBe(data.planHash)
      expect(report.rows).toEqual([
        { schema: "app", table: "members", rows: ROWS },
      ])

      // Застосування з COMMIT: позначка — рівно там, де `inactive = true`
      const r = await apply(dir, url, data)
      expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
      expect(codes(r)).not.toContain("apply.rehearsal-fewer-rows")
      expect((r.data as ApplyData).status).toBe("committed")
      expect(
        await query(
          url,
          "select count(*)::int as rows, count(*) filter (where deletion_mark)::int as marked, count(*) filter (where deletion_mark is null)::int as nulls from app.member"
        )
      ).toEqual([{ rows: ROWS, marked: INACTIVE, nulls: 0 }])
      const last = (await ledger(url)).at(-1)!
      expect(last.promotion).not.toBeNull()
      expect(last.rehearsal_hash).toBe(await rehearsalHash(report))

      // Повторний план: нічого застосовувати
      const again = await call("plan", {}, options(dir, url))
      expect(again.ok, JSON.stringify(again.diagnostics)).toBe(true)
      expect(errors(again)).toEqual([])
      expect(again.data).toEqual({
        unchanged: true,
        rightsOrphans: { roles: [], assignments: [], deltas: [] },
      })
      expect(again.artifacts).toEqual([])
    })
  })

  it("refuses to commit without a rehearsal report", async () => {
    await inTarget(EMPTY, scope, async (url) => {
      const { dir, data } = await promoted(url)
      const before = await state(url)
      const r = await apply(dir, url, data)
      expect(errors(r)).toEqual(["apply.rehearsal-required"])
      expect(r.data).toBeUndefined()
      expect(await state(url)).toEqual(before)
    })
  })

  it("refuses to commit after a rehearsal on an emptied copy", async () => {
    // Копія без рядків: репетиція проходить і пише звіт з `rows: 0`, але про
    // дані цілі вона нічого не довела — фаза 6c відмовляє в транзакції
    await inTarget(EMPTY, scope, async (url) => {
      const { dir, data } = await promoted(url)
      let file = ""
      await withCopy(templateOf(url), async (copy) => {
        await query(copy, "delete from app.members")
        const r = await apply(dir, copy, data, { rehearse: true })
        expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
        expect((r.data as ApplyData).status).toBe("rolledBack")
        file = (r.data as ApplyData).report!
      })
      expect((await reportAt(dir, file)).rows).toEqual([
        { schema: "app", table: "members", rows: 0 },
      ])

      const before = await state(url)
      expect(before.members).toEqual([{ rows: ROWS, inactive: INACTIVE }])
      const r = await apply(dir, url, data)
      expect(r.diagnostics.map((d) => [d.code, d.params])).toEqual([
        ["apply.rehearsal-copy-empty", { table: "app.members" }],
      ])
      expect(await state(url)).toEqual(before)
    })
  })

  it.each([
    ["an integer", { type: "Integer" }],
    ["a varchar", { type: "String", length: 20 }],
  ])(
    "warns of the UPDATE OF narrowing on %s column and the numbering in a promotion plan",
    async (_, type) => {
      const fixture = audited(type)
      await inTarget(EMPTY, scope, async (url) => {
        const dir = await projectWith(fixture)
        const committed = await apply(dir, url, await planned(dir, url))
        expect(
          errors(committed),
          JSON.stringify(committed.diagnostics)
        ).toEqual([])
        const promote = await call(
          "promote",
          fixture.mapping(),
          options(dir, url)
        )
        expect(errors(promote), JSON.stringify(promote.diagnostics)).toEqual([])
        // Підписку на довідник можна описати лише після промоції: до неї
        // довідника `Member` немає, а без неї прийнятому тригеру нема заміни
        const file = join(
          dir,
          "event-subscriptions/AuditMember/AuditMember.meta.json"
        )
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, JSON.stringify(fixture.subscription))
        const r = await call("plan", {}, options(dir, url))
        expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
        expect((r.data as PlanData).promotion).not.toBeNull()
        // Колонка — у старому імені, як тригер і таблиця запису
        expect(
          r.diagnostics
            .filter((d) => d.severity === "warning")
            .filter((d) =>
              [
                "plan.update-of-narrowed",
                "plan.numbering-not-generated",
              ].includes(d.code)
            )
            .map((d) => [d.code, d.params])
        ).toEqual([
          [
            "plan.numbering-not-generated",
            { object: "Member", table: "app.member" },
          ],
          [
            "plan.update-of-narrowed",
            { trigger: AUDIT, table: "app.member", columns: "rank" },
          ],
        ])
      })
    }
  )
})
