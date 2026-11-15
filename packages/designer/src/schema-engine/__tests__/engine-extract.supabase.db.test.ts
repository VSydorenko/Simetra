import { describe, it } from "vitest"
import {
  expectExtractMatchesModel,
  unitClasses,
} from "./engine-extract.support"

/**
 * Extract на стеку Supabase: класи одиниць, яким потрібні об'єкти провайдера
 * (членство таблиці в публікації `supabase_realtime`, сервісна роль
 * `service_role`). Решта корпусу — `engine-extract.db.test.ts`; спільна
 * підготовка — `engine-extract.support.ts`.
 */

describe("extract maps provider-bound unit classes", () => {
  it("realtime publication and service role grants map to the compiler identity", async () => {
    await expectExtractMatchesModel(
      unitClasses([
        "GRANT ALL ON app.note_view TO service_role;",
        "ALTER PUBLICATION supabase_realtime ADD TABLE app.note;",
      ])
    )
  })
})
