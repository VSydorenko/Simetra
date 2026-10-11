import pg from "pg"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import {
  canonicalSnapshot,
  compile,
  type CompiledModel,
} from "simetra/compiler"
import {
  buildPlan,
  executePlan,
  serializePlan,
  type EngineScope,
  type PlanArtifact,
  type PlanOutcome,
  type SchemaEngine,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  acceptDebt,
  attribute,
  catalog,
  customTable,
  metaFiles,
  project,
  shadowDatabaseCount,
  testDatabaseUrl,
  testSuperuserUrl,
  uuid,
} from "../../../../simetra/test/support"

/**
 * Конвеєр плану `buildPlan` на справжній базі (план П3-1, задача 9): гейт
 * дрейфу, план від живої цілі, класи й лінт, доказ на копії тим самим
 * раннером і детермінований артефакт. Ціль кожного тесту — окрема база від
 * `withDesiredShadow`; база стеку лише читається.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }
const dbs = {
  reader: createApplyDatabase({ readOnly: true }),
  scratch: createApplyDatabase({ readOnly: false }),
}
const writer = createApplyDatabase({ readOnly: false })
const targetScope: EngineScope = { schemas: ["app"], provider: "supabase" }

/** Роль, якій за спиною платформи передають таблицю цілі. */
const OWNER = "simetra_build_plan_owner"
/** Роль, членом якої роль сесії не є: об'єкт такого власника план не зніме. */
const STRANGER = "simetra_build_plan_stranger"

/** Службова роль провайдера, членом якої роль сесії застосування не є. */
const SERVICE_ROLE = "supabase_auth_admin"

/** Один запит (чи кілька операторів) з окремого з'єднання. */
async function other<R extends Record<string, unknown>>(
  url: string,
  sql: string
): Promise<R[]> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return (await client.query<R>(sql)).rows
  } finally {
    await client.end()
  }
}

const dropRole = () =>
  other(
    testSuperuserUrl(),
    `drop role if exists ${OWNER}; drop role if exists ${STRANGER};`
  )

/** Та сама база цілі, але сесією суперкористувача стеку. */
function asSuperuser(url: string): string {
  const su = new URL(testSuperuserUrl())
  su.pathname = new URL(url).pathname
  return su.toString()
}

beforeAll(async () => {
  // Роль могла лишитися від убитого прогону
  await dropRole()
  await other(
    testSuperuserUrl(),
    `create role ${OWNER} nologin; grant ${OWNER} to postgres;
     create role ${STRANGER} nologin;`
  )
})
afterAll(dropRole)

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

/** Ціль із `setup`; базу прибирає порт. */
async function inTarget<T>(
  setup: string,
  fn: (url: string) => Promise<T>
): Promise<T> {
  const outcome = await engine.withDesiredShadow(
    { target: stack },
    setup,
    targetScope,
    (target) => fn(target.url)
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `target did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
  return outcome.value
}

/** Порожня ціль: лише базовий стан провайдера. */
const EMPTY = "select 1;"

async function compiled(
  entries: Record<string, unknown>
): Promise<CompiledModel> {
  // Дослівні одиниці фікстур — не предмет цих тестів, тож борг прийнято
  const result = await compile(
    await acceptDebt(
      metaFiles({
        "project.meta.json": project({ defaultSchema: "app" }),
        ...entries,
      })
    )
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

const PARTY = "catalogs/Party/Party.meta.json"
const party = (attributes: unknown[] = []) =>
  catalog("Party", { id: uuid(9001), attributes })

const plan = (
  url: string,
  model: CompiledModel,
  over: SchemaEngine = engine
): Promise<PlanOutcome> => buildPlan(over, dbs, model, { target: { url } })

function planned(outcome: PlanOutcome): PlanArtifact {
  if (outcome.status !== "planned")
    throw new Error(
      `expected planned, got ${outcome.status}: ${outcome.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ")}`
    )
  return outcome.artifact
}

const codes = (outcome: PlanOutcome): string[] =>
  outcome.diagnostics.map((d) => d.code)

const errors = (outcome: PlanOutcome): string[] =>
  outcome.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)

/** Застосовує артефакт так само, як інструмент `apply`. */
async function applyArtifact(
  url: string,
  artifact: PlanArtifact,
  model: CompiledModel
): Promise<void> {
  const outcome = await executePlan(writer, { url }, artifact, {
    mode: "apply",
    planHash: artifact.planHash,
    allow: artifact.requiredPermissions,
    snapshot: canonicalSnapshot(model),
  })
  expect(outcome.diagnostics).toEqual([])
  expect(outcome.status).toBe("committed")
}

/** План і застосування моделі на цілі. */
async function establish(url: string, model: CompiledModel): Promise<void> {
  await applyArtifact(url, planned(await plan(url, model)), model)
}

const stepMatching = (artifact: PlanArtifact, pattern: RegExp) =>
  artifact.steps.filter((s) => pattern.test(s.sql))

describe("buildPlan", () => {
  it("plans a first apply", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      const outcome = await plan(url, model)
      const artifact = planned(outcome)
      expect(artifact.fromHash).toBeNull()
      expect(artifact.toHash).toBe(model.hash)
      expect(artifact.drift).toBeNull()
      expect(codes(outcome)).toContain("apply.first-apply")
      expect(codes(outcome)).toContain("plan.schema-only-proof")
      expect(errors(outcome)).toEqual([])
      expect(
        artifact.steps.some((s) =>
          /CREATE TABLE "simetra"\."marker"/.test(s.sql)
        )
      ).toBe(true)
      expect(artifact.requiredPermissions).toEqual([])
      // Унікальний індекс на таблиці, яку створює сам план, нічого не сканує
      expect(
        stepMatching(artifact, /CREATE UNIQUE INDEX party_predefined/).map(
          (s) => s.class
        )
      ).toEqual(["catalogOnly"])
      expect(artifact.scope.schemas).toEqual(["app", "simetra"])
    })
  })

  it("is deterministic", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      const first = serializePlan(planned(await plan(url, model)))
      const second = serializePlan(planned(await plan(url, model)))
      expect(second).toBe(first)
    })
  })

  it("reports unchanged", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      const outcome = await plan(url, model)
      expect(outcome.status).toBe("unchanged")
      expect(errors(outcome)).toEqual([])
      expect(codes(outcome)).not.toContain("apply.drift")
    })
  })

  it("plans over drift by model", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      await other(url, "alter table app.party add column extra int")
      const outcome = await plan(url, model)
      const artifact = planned(outcome)
      expect(codes(outcome)).toContain("apply.drift")
      expect(artifact.drift?.reason).toBe("drift")
      expect(artifact.drift?.paths.some((p) => p.includes("extra"))).toBe(true)
      // Кроки — від живої цілі: колонку, якої бажаний стан не має, план знімає
      const [drop] = stepMatching(artifact, /DROP COLUMN/i)
      expect(drop?.class).toBe("destructive")
      expect(artifact.requiredPermissions[0]).toBe("drift")
      expect(artifact.requiredPermissions).toContain(drop!.id)
      expect(artifact.fromHash).toBe(model.hash)
    })
  })

  it("sees an owner swap as drift", async () => {
    // Новому власникові потрібен CREATE на схемі, щоб `OWNER TO` пройшов на
    // цілі; грант — у бажаному стані, тож розходиться лише власник
    const model = await compiled({
      [PARTY]: party(),
      "sql/app/owner.sql": `GRANT CREATE ON SCHEMA app TO ${OWNER};`,
    })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      await other(url, `alter table app.party owner to ${OWNER}`)
      const outcome = await plan(url, model)
      // Гейт бачить дрейф власника, а план відмовляє з порадою: власник —
      // керована властивість, і прийняти підміну базою не можна
      expect(outcome.status).toBe("refused")
      expect(
        outcome.diagnostics.find((d) => d.code === "apply.drift")?.params
      ).toMatchObject({ sections: "owner" })
      expect(errors(outcome)).toEqual(["plan.owner-mismatch"])
      const [mismatch] = outcome.diagnostics.filter(
        (d) => d.code === "plan.owner-mismatch"
      )
      // Лише сама таблиця: індекс ключа, рядковий тип і тип масиву ідуть
      // за нею, і `OWNER TO` на них Postgres відхиляє
      expect(mismatch?.params).toEqual({
        count: 1,
        objects: `relation app.party (owner ${OWNER}, expected postgres)`,
      })
      // Власника повернуто вручну — дрейфу більше немає
      await other(url, "alter table app.party owner to postgres")
      expect((await plan(url, model)).status).toBe("unchanged")
    })
  })

  it("refuses a first apply over a foreign owner", async () => {
    // Прийнята база: таблиця моделі вже є, але належить чужій ролі
    const model = await compiled({ [PARTY]: party() })
    await inTarget(
      `create schema app;
       grant create on schema app to ${OWNER};
       create table app.party (id uuid primary key);
       alter table app.party owner to ${OWNER};`,
      async (url) => {
        const outcome = await plan(url, model)
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.owner-mismatch"])
        expect(
          outcome.diagnostics.find((d) => d.code === "plan.owner-mismatch")
            ?.params
        ).toEqual({
          count: 1,
          objects: `relation app.party (owner ${OWNER}, expected postgres)`,
        })
      }
    )
  })

  it("refuses to drop an object of a role the session cannot act as", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      // Таблиця лише цілі, власник — роль поза членством ролі сесії: план
      // зніс би її, а `DROP` упав би на застосуванні з 42501
      await other(
        asSuperuser(url),
        `create table app.stray (id int);
         alter table app.stray owner to ${STRANGER};`
      )
      const outcome = await plan(url, model)
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.owner-mismatch"])
      expect(
        outcome.diagnostics.find((d) => d.code === "plan.owner-mismatch")
          ?.params
      ).toEqual({
        count: 1,
        objects: `relation app.stray (owner ${STRANGER}, not a role postgres is a member of)`,
      })
    })
  })

  it("checks owners only where the engine reads, not inside extensions", async () => {
    // Межа з `public` і розширенням у ній: на провайдері розширення й усі
    // його члени належать службовій ролі, членом якої роль сесії не є.
    // Двигун членів розширення не планує, тож перепис власників їх не судить
    const model = await compiled({
      "project.meta.json": project({ defaultSchema: "public" }),
      [PARTY]: party(),
    })
    await inTarget(EMPTY, async (url) => {
      await other(url, "create extension pg_trgm schema public")
      const [extension] = await other<{ owner: string; member: boolean }>(
        url,
        `select pg_get_userbyid(extowner) as owner,
           pg_has_role(current_user, extowner, 'MEMBER') as member
         from pg_extension where extname = 'pg_trgm'`
      )
      // Передумова тесту: власник розширення — чужа роль, як на провайдері
      expect(extension?.member).toBe(false)
      expect(errors(await plan(url, model))).not.toContain(
        "plan.owner-mismatch"
      )

      // Об'єкт поза розширенням, що належить службовій ролі провайдера
      await other(
        asSuperuser(url),
        `create table public.stray (id int);
         alter table public.stray owner to ${SERVICE_ROLE};`
      )
      const outcome = await plan(url, model)
      expect(errors(outcome)).toEqual(["plan.owner-mismatch"])
      expect(
        outcome.diagnostics.find((d) => d.code === "plan.owner-mismatch")
          ?.params
      ).toEqual({
        count: 1,
        objects: `relation public.stray (owner ${SERVICE_ROLE}, not a role postgres is a member of)`,
      })
    })
  })

  it("asks permission to drop a unique index the model cannot see", async () => {
    // Прийнята база з унікальним індексом з опціями зберігання: модель
    // каталогу його не несе, а знімає його план без бажаного стану
    const model = await compiled({ [PARTY]: party() })
    await inTarget(
      `create schema app;
       create table app.party (id uuid primary key);
       create unique index party_extra_u on app.party (id)
         with (fillfactor = 90);`,
      async (url) => {
        const artifact = planned(await plan(url, model))
        const [drop] = stepMatching(artifact, /DROP INDEX .*party_extra_u/)
        expect(drop?.class).toBe("relaxation")
        expect(artifact.requiredPermissions).toContain(drop!.id)
      }
    )
  })

  it("plans versions-changed drift with zero steps", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      await other(
        url,
        "update simetra.marker set engine_version = 'other', fingerprint_version = 0"
      )
      const outcome = await plan(url, model)
      const artifact = planned(outcome)
      expect(codes(outcome)).toContain("apply.versions-changed")
      expect(artifact.drift).toEqual({
        reason: "versions-changed",
        sections: [],
        paths: [],
      })
      expect(artifact.steps).toEqual([])
      expect(artifact.fromHash).toBe(artifact.toHash)
      expect(artifact.requiredPermissions).toEqual(["drift"])
    })
  })

  it("refuses an engine step the parser cannot read", async () => {
    const model = await compiled({ [PARTY]: party() })
    // Двигун із дією, якої парсер не розбирає: дефект адаптера стає
    // відмовою з id кроку, а не винятком
    const garbled: SchemaEngine = {
      ...engine,
      withDesiredShadow: (o, sql, scope, fn) =>
        engine.withDesiredShadow(o, sql, scope, (db, enginePlan) =>
          fn(db, {
            empty: false,
            actions: [
              ...enginePlan.actions,
              { ...enginePlan.actions[0]!, sql: "THIS IS NOT SQL" },
            ],
          })
        ),
    }
    await inTarget(EMPTY, async (url) => {
      const outcome = await plan(url, model, garbled)
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.unparsable-step"])
      const [unparsable] = outcome.diagnostics.filter(
        (d) => d.code === "plan.unparsable-step"
      )
      expect(unparsable?.params.step).toMatch(/^s\d+$/)
    })
  })

  it("names a proof that misses the desired fingerprint as a proof refusal", async () => {
    const withNote = await compiled({
      [PARTY]: party([attribute("note", { id: uuid(9060) })]),
    })
    const without = await compiled({ [PARTY]: party() })
    // Двигун, що «забуває» кроки: копія після прогону не досягає бажаного
    // відбитка, і перевірка раннера перед `COMMIT` звучить кодом доказу
    const forgetful: SchemaEngine = {
      ...engine,
      withDesiredShadow: (o, sql, scope, fn) =>
        engine.withDesiredShadow(o, sql, scope, (db) =>
          fn(db, { empty: true, actions: [] })
        ),
    }
    await inTarget(EMPTY, async (url) => {
      await establish(url, without)
      const outcome = await plan(url, withNote, forgetful)
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.fingerprint-disagrees"])
    })
  })

  it("converges a reloptions change", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      await other(url, "alter table app.party set (fillfactor = 70)")
      const artifact = planned(await plan(url, model))
      expect(artifact.drift?.sections).toContain("relations")
      expect(stepMatching(artifact, /RESET \(fillfactor\)/)).not.toEqual([])
      expect(artifact.requiredPermissions[0]).toBe("drift")
    })
  })

  it("converges a sequence CACHE change", async () => {
    const model = await compiled({
      "custom-tables/Counter/Counter.meta.json": customTable("Counter", {
        id: uuid(9010),
        columns: [
          {
            id: uuid(9011),
            name: "seq",
            physicalName: "seq",
            type: "BigInt",
            identity: "always",
            notNull: true,
          },
        ],
      }),
    })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      await other(url, "alter table app.counter alter column seq set cache 10")
      const artifact = planned(await plan(url, model))
      expect(artifact.drift?.sections).toContain("sequences")
      expect(stepMatching(artifact, /CACHE\s+1\b/i)).not.toEqual([])
    })
  })

  it("plans over drift by fingerprint when the engine changed", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      await other(
        url,
        `update simetra.marker set engine_version = 'other';
         grant select on app.party to anon;`
      )
      const artifact = planned(await plan(url, model))
      expect(artifact.drift?.sections).toContain("acl")
      expect(artifact.drift?.paths).toEqual([])
    })
  })

  it("scope change is not drift", async () => {
    const extra = customTable("Extra", { id: uuid(9020), schema: "extra" })
    const both = await compiled({
      [PARTY]: party(),
      "custom-tables/Extra/Extra.meta.json": extra,
    })
    const appOnly = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, both)
      const outcome = await plan(url, appOnly)
      const artifact = planned(outcome)
      expect(codes(outcome)).not.toContain("apply.drift")
      expect(artifact.drift).toBeNull()
      expect(artifact.scope.schemas).toEqual(["app", "extra", "simetra"])
      const [drop] = stepMatching(artifact, /DROP TABLE "extra"\."extra"/)
      expect(drop?.class).toBe("destructive")
      expect(artifact.requiredPermissions).toContain(drop!.id)
    })
  })

  it("refuses ledger without marker", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      await other(url, "delete from simetra.marker")
      const outcome = await plan(url, model)
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["apply.ledger-without-marker"])
    })
  })

  it("refuses a commit boundary", async () => {
    const mood = (values: string[]) => ({
      id: uuid(9030),
      kind: "PgEnum",
      name: "Mood",
      physicalName: "mood",
      values,
    })
    const diary = (column: Record<string, unknown>) =>
      customTable("Diary", {
        id: uuid(9031),
        columns: [
          {
            id: uuid(9032),
            name: "mood",
            physicalName: "mood",
            type: "PgEnum",
            enum: { kind: "PgEnum", name: "Mood" },
            ...column,
          },
        ],
      })
    const before = await compiled({
      "pg-enums/Mood/Mood.meta.json": mood(["a"]),
      "custom-tables/Diary/Diary.meta.json": diary({}),
    })
    const after = await compiled({
      "pg-enums/Mood/Mood.meta.json": mood(["a", "b"]),
      "custom-tables/Diary/Diary.meta.json": diary({ default: "'b'" }),
    })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      const outcome = await plan(url, after)
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["apply.commit-boundary"])
    })
  })

  it("refuses a mismatched clone", async () => {
    const model = await compiled({ [PARTY]: party() })
    // Двигун, чия копія має зайву таблицю: точність копії не тримається
    const ghostly: SchemaEngine = {
      ...engine,
      withTargetClone: (o, target, scope, fn) =>
        engine.withTargetClone(o, target, scope, async (clone) => {
          await other(clone.url, "create table app.ghost ()")
          return fn(clone)
        }),
    }
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      await other(url, "alter table app.party add column extra int")
      const outcome = await plan(url, model, ghostly)
      expect(outcome.status).toBe("refused")
      expect(new Set(errors(outcome))).toEqual(new Set(["plan.clone-mismatch"]))
    })
  })

  it("requires permissions for destructive steps", async () => {
    const withNote = await compiled({
      [PARTY]: party([attribute("note", { id: uuid(9040) })]),
    })
    const without = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, withNote)
      const outcome = await plan(url, without)
      const artifact = planned(outcome)
      expect(artifact.drift).toBeNull()
      const [drop] = stepMatching(artifact, /DROP COLUMN/i)
      expect(drop?.class).toBe("destructive")
      expect(artifact.requiredPermissions).toEqual([drop!.id])
    })
  })
})
