import { describe, expect, it } from "vitest"
import { canonicalSnapshot } from "simetra/compiler"
import { executePlan, type PlanArtifact } from "simetra/schema"
import {
  ANON,
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

/**
 * Крок, що знімає чи перевизначає об'єкт за шаблоном, має клас з дозволом;
 * `subject` — ціль дії на місці: двигун ставить її першою серед вжитих.
 */
async function expectPermitted(
  url: string,
  model: Awaited<ReturnType<typeof compiled>>,
  drop: RegExp,
  subject?: Json
) {
  const artifact = planned(await plan(url, model))
  const [step] = stepMatching(artifact, drop)
  if (subject !== undefined) expect(step?.consumed[0]).toEqual(subject)
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

  it("asks permission to drop a foreign domain", async () => {
    // Вид поза вісімкою заміни: правило — для кожного виду без даних.
    // Домен без обмежень: інакше крок зняв би й обмеження, яке ловить і
    // правило заміни
    const model = await compiled({ [NOTES]: notes() })
    await inTarget(`${FOREIGN_NOTES}\ncreate domain app.d as text;`, (url) =>
      expectPermitted(url, model, /DROP DOMAIN/)
    )
  })

  it("asks permission to drop a foreign aggregate", async () => {
    const model = await compiled({ [NOTES]: notes() })
    await inTarget(
      `${FOREIGN_NOTES}\ncreate aggregate app.total(integer) (sfunc = int4pl, stype = integer);`,
      (url) => expectPermitted(url, model, /DROP AGGREGATE/)
    )
  })

  it("asks permission to redefine a foreign function in place", async () => {
    // Та сама сигнатура, інше тіло: двигун дає `CREATE OR REPLACE` без
    // зняття, і ціль дії — сама функція, перша серед вжитих
    const model = await compiled(
      withSql(
        "CREATE FUNCTION app.f() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT 1 $$;"
      )
    )
    await inTarget(
      `${FOREIGN_NOTES}\ncreate function app.f() returns integer language sql stable as $$ select 2 $$;`,
      (url) =>
        expectPermitted(url, model, /CREATE OR REPLACE FUNCTION/, {
          kind: "function",
          schema: "app",
          name: "f",
        })
    )
  })

  it("asks permission to redefine a foreign procedure in place", async () => {
    const model = await compiled(
      withSql("CREATE PROCEDURE app.p() LANGUAGE sql AS $$ SELECT 1 $$;")
    )
    await inTarget(
      `${FOREIGN_NOTES}\ncreate procedure app.p() language sql as $$ select 2 $$;`,
      (url) =>
        expectPermitted(url, model, /CREATE OR REPLACE PROCEDURE/, {
          kind: "procedure",
          schema: "app",
          name: "p",
        })
    )
  })

  it("asks permission to change the roles of a foreign policy", async () => {
    const model = await compiled(
      withSql(`CREATE POLICY p ON app.notes TO ${ANON} USING (true);`)
    )
    await inTarget(
      `${FOREIGN_NOTES}\ncreate policy p on app.notes using (true);`,
      (url) =>
        expectPermitted(url, model, /ALTER POLICY/, {
          kind: "policy",
          schema: "app",
          table: "notes",
          name: "p",
        })
    )
  })

  it("keeps the in-place redefinition of its own function and policy catalogOnly", async () => {
    // Тіло власної функції читає таблицю: залежність — серед вжитих після
    // цілі, а не ціль (чужу залежність тіні не поставити: її двигун
    // перевіряє на копії; правило для чужої залежності — unit-кейс
    // `foreignChanges`); власна політика міняє ролі
    const own = (value: string, roles: string) =>
      withSql(
        `CREATE FUNCTION app.f() RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT count(*) + ${value} FROM app.notes $$;
CREATE POLICY p ON app.notes TO ${roles} USING (true);`
      )
    const before = await compiled(own("1", "PUBLIC"))
    const after = await compiled(own("2", ANON))
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      const artifact = planned(await plan(url, after))
      const [fn] = stepMatching(artifact, /CREATE OR REPLACE FUNCTION/)
      const [policy] = stepMatching(artifact, /ALTER POLICY/)
      expect(fn?.consumed[0]).toMatchObject({ kind: "function", name: "f" })
      expect([fn?.class, policy?.class]).toEqual(["catalogOnly", "catalogOnly"])
      expect(artifact.requiredPermissions).toEqual([])
    })
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
