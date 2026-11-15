import { describe, expect, it } from "vitest"
import { query } from "../../__tests__/support/db"
import {
  changedBy,
  defaultPrivilegesSection,
  FIXTURE,
  inTarget,
  useFingerprintRole,
} from "./fingerprint.support"

/**
 * SQL-відбиток каталогу на стеку Supabase: службова роль провайдера поза
 * межею двигуна й політики на поверхні провайдера. Спільна підготовка —
 * `fingerprint.support.ts`.
 */

useFingerprintRole()

describe("readFingerprint", () => {
  describe("default privileges", () => {
    const section = defaultPrivilegesSection

    it("ignores default privileges of a provider service role", async () => {
      // Поза межею двигуна: політика провайдера виключає ADP системних ролей
      expect(
        await section(
          "alter default privileges for role supabase_admin in schema app grant all on tables to anon"
        )
      ).toBe(await section("select 1"))
    })
  })

  // Провайдер міток на стеку — `pgsodium` у `shared_preload_libraries`; на
  // чистому Postgres мітки безпеки немає чим поставити
  it("section per mutation: security label", async () => {
    await inTarget(FIXTURE, async (url) => {
      expect(
        await changedBy(url, () =>
          query(
            url,
            "security label for pgsodium on column app.t.name is 'ENCRYPT WITH KEY ID 00000000-0000-0000-0000-000000000000'"
          )
        )
      ).toEqual(["comments"])
    })
  })

  it("sees provider surface policies", async () => {
    await inTarget(FIXTURE, async (url) => {
      expect(
        await changedBy(url, () =>
          query(
            url,
            "create policy app_read on storage.objects for select to authenticated using (true)"
          )
        )
      ).toEqual(["policies"])
      // `storage.app_extra` — на поверхні тригерів, але не політик: політика
      // на ній не входить у відбиток, хоч схема та сама, що в `objects`
      expect(
        await changedBy(url, () =>
          query(
            url,
            "create table storage.app_extra (id int); create policy app_x on storage.app_extra for select to authenticated using (true)"
          )
        )
      ).toEqual([])
    })
  })
})
