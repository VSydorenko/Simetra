import { describe, expect, it } from "vitest"
import { canonicalSnapshot } from "simetra/compiler"
import { executePlan, type PlanArtifact } from "simetra/schema"
import {
  compiled,
  EMPTY,
  establish,
  inTarget,
  type Json,
  NOTES,
  notes,
  plan,
  planned,
  stepMatching,
  useBuildPlanRoles,
  writer,
} from "./build-plan.support"

/**
 * Зняття об'єкта без даних, якого немає в останньому застосованому стані
 * (marker; першого застосування — жодного), — послаблення з дозволом, і
 * однойменна заміна теж (платформна спека §6.6): чужий об'єкт під тим самим
 * ім'ям мовчки не перевизначається. Свій об'єкт заміна лишає `catalogOnly`.
 */

useBuildPlanRoles()

/** `app.notes`, як її створив би не платформа: без marker. */
const FOREIGN_NOTES = `create schema app;
create table app.notes (id uuid not null, note character varying(20),
  constraint notes_pkey primary key (id));`

const indexed = (column: string): Json => ({
  ...(notes() as unknown as Json),
  indexes: [{ name: "notes_x_idx", keys: [{ column }] }],
})

const withSql = (sql: string) => ({
  [NOTES]: notes(),
  "sql/app/foreign.sql": sql,
})

const apply = (
  url: string,
  artifact: PlanArtifact,
  model: Parameters<typeof canonicalSnapshot>[0],
  allow: readonly string[]
) =>
  executePlan(writer, { url }, artifact, {
    mode: "apply",
    planHash: artifact.planHash,
    allow,
    snapshot: canonicalSnapshot(model),
  })

/** Крок, що знімає об'єкт за шаблоном, має клас з дозволом. */
async function expectPermitted(
  url: string,
  model: Awaited<ReturnType<typeof compiled>>,
  drop: RegExp
) {
  const artifact = planned(await plan(url, model))
  const [step] = stepMatching(artifact, drop)
  expect(step?.class).toBe("relaxation")
  expect(artifact.requiredPermissions).toContain(step!.id)
  const without = artifact.requiredPermissions.filter((p) => p !== step!.id)
  expect(await apply(url, artifact, model, without)).toMatchObject({
    status: "refused",
    diagnostics: [
      expect.objectContaining({
        code: "apply.permission-required",
      }),
    ],
  })
  expect(
    await apply(url, artifact, model, artifact.requiredPermissions)
  ).toMatchObject({ status: "committed" })
}

describe.concurrent("buildPlan: foreign objects", () => {
  it("asks permission to replace a foreign index of the same name", async () => {
    const model = await compiled({ [NOTES]: indexed("note") })
    await inTarget(
      `${FOREIGN_NOTES}\ncreate index notes_x_idx on app.notes (id);`,
      (url) => expectPermitted(url, model, /DROP INDEX .*notes_x_idx/)
    )
  })

  it("asks permission to replace a foreign policy of the same name", async () => {
    const model = await compiled(
      withSql("CREATE POLICY p ON app.notes USING (true);")
    )
    await inTarget(
      `${FOREIGN_NOTES}\ncreate policy p on app.notes using (false);`,
      (url) => expectPermitted(url, model, /DROP POLICY/)
    )
  })

  it("asks permission to replace a foreign function of the same name", async () => {
    const model = await compiled(
      withSql(
        "CREATE FUNCTION app.f() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT 1 $$;"
      )
    )
    await inTarget(
      `${FOREIGN_NOTES}\ncreate function app.f() returns text language sql stable as $$ select 'x' $$;`,
      (url) => expectPermitted(url, model, /DROP FUNCTION/)
    )
  })

  it("asks permission to replace a foreign view of the same name", async () => {
    const model = await compiled(
      withSql("CREATE VIEW app.v AS SELECT id FROM app.notes;")
    )
    await inTarget(
      `${FOREIGN_NOTES}\ncreate view app.v as select note, id from app.notes;`,
      (url) => expectPermitted(url, model, /DROP VIEW/)
    )
  })

  it("keeps the replacement of its own index catalogOnly", async () => {
    const before = await compiled({ [NOTES]: indexed("id") })
    const after = await compiled({ [NOTES]: indexed("note") })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      const artifact = planned(await plan(url, after))
      const [drop] = stepMatching(artifact, /DROP INDEX .*notes_x_idx/)
      expect(drop?.class).toBe("catalogOnly")
      expect(artifact.requiredPermissions).toEqual([])
    })
  })

  it("keeps the replacement of its own function catalogOnly", async () => {
    const fn = (type: string, value: string) =>
      withSql(
        `CREATE FUNCTION app.f() RETURNS ${type} LANGUAGE sql STABLE AS $$ SELECT ${value} $$;`
      )
    const before = await compiled(fn("text", "'x'"))
    const after = await compiled(fn("integer", "1"))
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      const artifact = planned(await plan(url, after))
      const [drop] = stepMatching(artifact, /DROP FUNCTION/)
      expect(drop?.class).toBe("catalogOnly")
      expect(artifact.requiredPermissions).toEqual([])
    })
  })
})
