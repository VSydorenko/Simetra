import { describe, expect, it } from "vitest"
import { promoteInput } from "simetra/compiler"
import type { ApplyData } from "../tools/apply-tools"
import { uuid } from "../../../simetra/test/support"
import { inTarget, query, withCopy } from "./support/db"
import {
  apply,
  errors,
  mapping,
  member,
  promoted,
  reportAt,
  ROWS,
  scope,
  templateOf,
  triggersOf,
  usePromotionCleanup,
} from "./promotion-commit.support"

/**
 * Кейс промоції, прив'язаний до Supabase: розширення `moddatetime` не
 * довірене, а перелік розширень, які профіль `postgres` ставить власнику
 * (`PROVIDER_INSTALLABLE_EXTENSIONS`), порожній — власник тінь із цим
 * розширенням не завантажить (спека профілю §3.5). Прийнятий тригер
 * `moddatetime` там проектом не описати, тож напарника на `postgres` немає.
 */

usePromotionCleanup()

/** Розширення `moddatetime`: у цілі — до плану, у проєкті — та сама одиниця. */
const MODDATETIME =
  "CREATE EXTENSION IF NOT EXISTS moddatetime WITH SCHEMA extensions;\n"

/** Прийнятий тригер службової дати на `app.members`. */
const STAMP = "members_stamp"

/** `app.members` з колонкою службової дати й тригером `moddatetime`. */
const stamped = {
  member: {
    ...member(),
    columns: [
      ...member().columns,
      {
        id: uuid(9505),
        name: "updatedAt",
        physicalName: "updated_at",
        type: "DateTime",
        notNull: true,
      },
    ],
  },
  files: {
    "sql/app/extensions.sql": MODDATETIME,
    "custom-tables/Member/Member.sql": `CREATE TRIGGER ${STAMP} BEFORE UPDATE ON app.members FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);\n`,
  },
  seed: `
  insert into app.members (id, name, inactive, updated_at)
  select ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
         'member ' || i,
         case when i % 3 = 0 then true when i % 5 = 0 then null else false end,
         '2000-01-01T00:00:00Z'
  from generate_series(1, ${ROWS}) as i;`,
  // Службова дата стає стандартною `updatedAt`, тригер — класом `platform`:
  // його замінює механіка рядка (спека промоції §8)
  mapping: () => {
    const m = mapping()
    return promoteInput.parse({
      ...m,
      columns: {
        ...m.columns,
        updatedAt: { to: "standard", name: "updatedAt" },
      },
      conversions: {
        ...m.conversions,
        [`trigger:app.members.${STAMP}`]: "platform",
      },
    })
  },
}

describe("promotion commit", () => {
  it("replaces an adopted moddatetime trigger by the row mechanics", async () => {
    await inTarget(MODDATETIME, scope, async (url) => {
      const { dir, data } = await promoted(url, {
        ...stamped,
        mapping: stamped.mapping(),
      })
      expect(await triggersOf(url, "app.members")).toEqual([
        { name: STAMP, enabled: "O" },
      ])
      expect(data.promotion!.data).toHaveLength(1)
      let file = ""
      await withCopy(templateOf(url), async (copy) => {
        const r = await apply(dir, copy, data, { rehearse: true })
        expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
        file = (r.data as ApplyData).report!
      })
      expect((await reportAt(dir, file)).rows).toEqual([
        { schema: "app", table: "members", rows: ROWS },
      ])

      const r = await apply(dir, url, data)
      expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
      expect((r.data as ApplyData).status).toBe("committed")
      // Прийнятого тригера немає, механіка й тригери незмінності ключа є, і
      // всі — увімкнені, як до плану: крок даних повертає стан тригерів
      expect(await triggersOf(url, "app.member")).toEqual([
        { name: "member_simetra_key", enabled: "O" },
        { name: "member_simetra_key_after", enabled: "O" },
        { name: "member_simetra_touch", enabled: "O" },
      ])
      // Колонку версії й механіку створює фаза двигуна після запису значень,
      // тож переписані кроком рядки — з першою версією
      expect(
        await query(
          url,
          "select count(*)::int as rows, count(*) filter (where version = 1)::int as first from app.member"
        )
      ).toEqual([{ rows: ROWS, first: ROWS }])
      await query(
        url,
        "update app.member set description = 'renamed' where id = '00000000-0000-4000-8000-000000000001'"
      )
      expect(
        await query(
          url,
          "select version::int as version, updated_at > '2000-01-01T00:00:00Z' as touched from app.member where id = '00000000-0000-4000-8000-000000000001'"
        )
      ).toEqual([{ version: 2, touched: true }])
    })
  })
})
