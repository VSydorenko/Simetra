import { describe, expect, it } from "vitest"
import { executePlan, readFingerprint, type EngineScope } from "simetra/schema"
import { canonicalSnapshot } from "simetra/compiler"
import { createApplyDatabase } from ".."
import { asSuperuser, query } from "../../__tests__/support/db"
import { testProvider } from "../../../../simetra/test/support"
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
  writer,
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
  provider: testProvider(),
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

/**
 * Стара форма тут без області `(description)`: рішення класифікатора залежить
 * від унікальності старого індексу, а не від його колонок. Заміну префікса
 * області `(org_id, …)` на `(org_id, …, id)` доводять юніт-тести
 * `materializeIndexes`.
 */
const ROWS = [
  { id: "00000000-0000-4000-8000-000000000001", description: "b" },
  { id: "00000000-0000-4000-8000-000000000002", description: "a" },
]

const rowsOf = (url: string) =>
  query(url, "select id, description from app.party order by id")

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
         ('${ROWS[0]!.id}', '${ROWS[0]!.description}', '1'),
         ('${ROWS[1]!.id}', '${ROWS[1]!.description}', '2');
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
      expect(await rowsOf(url)).toEqual(ROWS)
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
      expect(drop).toBeDefined()
      expect(artifact.requiredPermissions).toContain(drop!.id)
    })
  })
})

/**
 * Найменування довідника стало `NOT NULL DEFAULT ''` (рішення Р9). База,
 * застосована старою платформою, має nullable колонку без типового значення.
 * План додає крок заповнення перед `SET NOT NULL`, тож `NULL`-рядок
 * заповнюється `''`. DB-рівень потрібен: заповнення й успіх `SET NOT NULL`
 * на даних доводить лише справжній Postgres.
 */
describe.concurrent("description NOT NULL on an existing database", () => {
  const A = "00000000-0000-4000-8000-0000000000a1"
  const B = "00000000-0000-4000-8000-0000000000a2"

  async function inNullableTarget(
    withNull: boolean,
    fn: (url: string) => Promise<void>
  ): Promise<void> {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      await query(
        asSuperuser(url),
        `alter table app.party alter column description drop not null,
           alter column description drop default;
         insert into app.party (id, description, code) values
           ('${A}', 'x', '1'),
           ('${B}', ${withNull ? "null" : "'y'"}, '2');`
      )
      await recordLiveState(url)
      await fn(url)
    })
  }

  const descriptionColumn = async (url: string) =>
    (
      await query(
        url,
        `select is_nullable, column_default from information_schema.columns
         where table_schema = 'app' and table_name = 'party' and column_name = 'description'`
      )
    )[0]

  const markerOf = async (url: string) =>
    (await query(url, "select fingerprint from simetra.marker"))[0]

  const snapshotOf = (url: string) =>
    query(url, "select id, description from app.party order by id")

  it("fills the NULL row with the default and sets NOT NULL", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inNullableTarget(true, async (url) => {
      const artifact = planned(await plan(url, model))
      const [fill] = artifact.steps.filter((s) => s.origin === "backfill")
      expect(fill?.backfill?.rowsAtPlan).toBe(1)
      const [notNull] = stepMatching(artifact, /SET NOT NULL/)
      expect(notNull?.class).toBe("validationScan")

      const outcome = await executePlan(writer, { url }, artifact, {
        mode: "apply",
        planHash: artifact.planHash,
        allow: artifact.requiredPermissions,
        snapshot: canonicalSnapshot(model),
      })

      expect(outcome.diagnostics).toEqual([])
      expect(outcome.status).toBe("committed")
      // Заповнення й `SET NOT NULL` закомічено одним застосуванням: marker
      // несе відбиток бажаного стану плану
      expect(await markerOf(url)).toEqual({
        fingerprint: artifact.desiredFingerprint.sections,
      })
      expect(await descriptionColumn(url)).toMatchObject({
        is_nullable: "NO",
        column_default: "''::character varying",
      })
      expect(await snapshotOf(url)).toEqual([
        { id: A, description: "x" },
        { id: B, description: "" },
      ])
      const again = await plan(url, model)
      expect(again.status).toBe("unchanged")
      expect(again.diagnostics.map((d) => d.code)).not.toContain("apply.drift")
    })
  })

  it("applies when no row holds NULL", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inNullableTarget(false, async (url) => {
      const artifact = planned(await plan(url, model))
      const [notNull] = stepMatching(artifact, /SET NOT NULL/)
      expect(notNull?.class).toBe("validationScan")
      // `validationScan` лише перевіряє рядки: дозволу не потребує
      expect(artifact.requiredPermissions).toEqual([])
      const before = await snapshotOf(url)

      await applyArtifact(url, artifact, model)

      expect(await descriptionColumn(url)).toMatchObject({
        is_nullable: "NO",
        column_default: "''::character varying",
      })
      expect(await snapshotOf(url)).toEqual(before)
      const again = await plan(url, model)
      expect(again.status).toBe("unchanged")
      expect(again.diagnostics.map((d) => d.code)).not.toContain("apply.drift")
    })
  })
})
