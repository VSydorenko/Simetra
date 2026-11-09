import { describe, expect, it } from "vitest"
import { readFingerprint, type EngineScope } from "simetra/schema"
import { createApplyDatabase } from ".."
import { asSuperuser, query } from "../../__tests__/support/db"
import {
  compiled,
  EMPTY,
  engine,
  establish,
  inTarget,
  party,
  PARTY,
  plan,
  planned,
  applyArtifact,
  stepMatching,
  useBuildPlanRoles,
} from "./build-plan.support"

/**
 * Індекс порядку списку змінив форму: ключ рядка тепер останній, тож база,
 * застосована старою платформою, має `(description)`, а модель хоче
 * `(description, id)`. Заміна має застосовуватись без дозволу (рішення Р7:
 * класифікатор бачить ЖИВУ модель, де старий індекс неунікальний), а не лише
 * будуватись у плані. DB-рівень потрібен, бо клас кроку й `CREATE INDEX`
 * доводить лише справжній двигун на справжній базі.
 */

useBuildPlanRoles()

const NEW_INDEX = "party_description_id_idx"
const OLD_INDEX = "party_description_idx"

const indexDefs = async (url: string): Promise<string[]> =>
  (
    await query(
      url,
      `select indexdef from pg_indexes
       where schemaname = 'app' and tablename = 'party' and indexname like 'party_description%'
       order by indexname`
    )
  ).map((r) => String(r["indexdef"]))

const markerScope: EngineScope = {
  schemas: ["app", "simetra"],
  provider: "supabase",
}

/**
 * Марker несе відбиток і модель, зняті старою платформою одразу після її
 * застосування: без цього ручний DDL виглядав би дрейфом, а не наявною базою.
 */
async function recordLiveState(url: string): Promise<void> {
  const fingerprint = await createApplyDatabase({ readOnly: true }).transaction(
    { url },
    "rollback",
    (tx) => readFingerprint(tx, markerScope)
  )
  const extracted = await engine.extract({ url }, markerScope)
  await query(
    asSuperuser(url),
    `update simetra.marker set fingerprint = $1::jsonb, catalog = $2::jsonb`,
    [JSON.stringify(fingerprint.sections), JSON.stringify(extracted.model)]
  )
}

/** Ціль у стані старої платформи: нова форма замінена старою за DDL власника. */
async function inOldFormTarget(
  unique: boolean,
  fn: (url: string) => Promise<void>
): Promise<void> {
  const model = await compiled({ [PARTY]: party() })
  await inTarget(EMPTY, async (url) => {
    await establish(url, model)
    await query(
      asSuperuser(url),
      `insert into app.party (id, description, code) values
         ('00000000-0000-4000-8000-000000000001', 'b', '1'),
         ('00000000-0000-4000-8000-000000000002', 'a', '2');
       drop index app.${NEW_INDEX};
       create ${unique ? "unique " : ""}index ${OLD_INDEX} on app.party (description);`
    )
    await recordLiveState(url)
    await fn(url)
  })
}

describe.concurrent("list-order index on an existing database", () => {
  it("replaces the old form without permission", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inOldFormTarget(false, async (url) => {
      const artifact = planned(await plan(url, model))
      const [drop] = stepMatching(
        artifact,
        new RegExp(`DROP INDEX .*${OLD_INDEX}`)
      )
      const [create] = stepMatching(
        artifact,
        new RegExp(`CREATE INDEX ${NEW_INDEX}`)
      )
      expect(drop?.class).toBe("catalogOnly")
      // Створення неунікального індексу теж `catalogOnly`: дозволу не потребує
      expect(create?.class).toBe("catalogOnly")
      expect(artifact.requiredPermissions).toEqual([])

      await applyArtifact(url, artifact, model)

      expect(
        (await indexDefs(url)).map((d) => d.replace(/^.* USING /, ""))
      ).toEqual(["btree (description, id)"])
      expect(
        (await query(url, "select count(*)::int as n from app.party"))[0]?.["n"]
      ).toBe(2)
      // Відбиток стану зелений: повторний план нічого не змінює й без дрейфу
      const again = await plan(url, model)
      expect(again.status).toBe("unchanged")
      expect(again.diagnostics.map((d) => d.code)).not.toContain("apply.drift")
    })
  })

  it("keeps asking permission when the old index is unique", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inOldFormTarget(true, async (url) => {
      const artifact = planned(await plan(url, model))
      const [drop] = stepMatching(
        artifact,
        new RegExp(`DROP INDEX .*${OLD_INDEX}`)
      )
      expect(drop?.class).toBe("relaxation")
      expect(artifact.requiredPermissions).toContain(drop!.id)
    })
  })
})
