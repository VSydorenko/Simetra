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
  applyChanges,
  canonicalSnapshot,
  compile,
  promoteObject,
  promotionRecordHash,
  type CompiledModel,
  type PromoteInput,
  type PromotionRecord,
} from "simetra/compiler"
import {
  ApplyConnectionLost,
  buildPlan,
  checkGuardCasts,
  executePlan,
  serializePlan,
  type ApplyDatabase,
  type EngineAction,
  type EngineScope,
  type PlanArtifact,
  type PlanOutcome,
  type PromotionInput,
  type SchemaEngine,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  acceptDebt,
  attribute,
  catalog,
  CONTACT_FILE,
  COUNTERPARTY_FILE,
  COUNTERPARTY_ID,
  counterpartyMapping,
  customTable,
  metaFiles,
  promotionProject,
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

/** Роль-група, членом якої є роль API: її привілеї роль API успадковує. */
const WRITERS = "simetra_build_plan_writers"

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
    `drop role if exists ${OWNER}; drop role if exists ${STRANGER};
     drop role if exists ${WRITERS};`
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
     create role ${STRANGER} nologin;
     create role ${WRITERS} nologin; grant ${WRITERS} to authenticated;`
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
): Promise<PlanOutcome> => buildPlan(over, dbs, model, { target: { url } }, [])

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
            preamble: enginePlan.preamble,
            diagnostics: enginePlan.diagnostics,
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
          fn(db, { empty: true, actions: [], preamble: [], diagnostics: [] })
        ),
    }
    await inTarget(EMPTY, async (url) => {
      await establish(url, without)
      const outcome = await plan(url, withNote, forgetful)
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.fingerprint-disagrees"])
    })
  })

  it.each([
    ["the copy-to-target comparison", 1],
    ["the proof comparison after the run", 2],
  ])(
    "refuses a proof when the engine plan of %s carries an error diagnostic",
    async (_label, failingCall) => {
      const withNote = await compiled({
        [PARTY]: party([attribute("note", { id: uuid(9070 + failingCall) })]),
      })
      const without = await compiled({ [PARTY]: party() })
      // Справжній двигун, але N-й `plan` у доказі несе помилку преамбули: дій
      // немає, тож лише діагностика плану може зупинити доказ
      let calls = 0
      const badPreamble: SchemaEngine = {
        ...engine,
        plan: (source, target, scope, o) => {
          calls += 1
          const real = engine.plan(source, target, scope, o)
          if (calls !== failingCall) return real
          return {
            ...real,
            diagnostics: [
              ...real.diagnostics,
              {
                code: "engine.preamble-unknown",
                severity: "error",
                message: "unknown preamble",
                params: { name: "role", value: "postgres" },
              },
            ],
          }
        },
      }
      await inTarget(EMPTY, async (url) => {
        await establish(url, without)
        const outcome = await plan(url, withNote, badPreamble)
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toContain("engine.preamble-unknown")
      })
    }
  )

  it("refuses a proof whose clone still differs from the desired state", async () => {
    const withNote = await compiled({
      [PARTY]: party([attribute("note", { id: uuid(9061) })]),
    })
    const without = await compiled({ [PARTY]: party() })
    // Справжній двигун, але порівняння «копія → бажана» після прогону бачить
    // зайву дію: прогін і відбиток збіглися, тож відмовляє саме порожність
    // плану, а не відбиток. Перший виклик `plan` у доказі — звірка копії із
    // ціллю, вона лишається чесною
    let calls = 0
    const leftover: SchemaEngine = {
      ...engine,
      plan: (source, target, scope) => {
        calls += 1
        const real = engine.plan(source, target, scope)
        if (calls < 2) return real
        const fake: EngineAction = {
          sql: "select 1",
          verb: "alter",
          produces: [],
          consumes: [],
          destroys: [],
          produced: [],
          destroyed: [],
          consumed: [],
          transactionality: "transactional",
          newSegmentBefore: false,
          lockedTables: [],
          lockClass: "none",
          dataLoss: false,
          rewriteRisk: false,
        }
        return { ...real, empty: false, actions: [...real.actions, fake] }
      },
    }
    await inTarget(EMPTY, async (url) => {
      await establish(url, without)
      const outcome = await plan(url, withNote, leftover)
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toContain("plan.proof-not-empty")
      expect(errors(outcome)).not.toContain("plan.fingerprint-disagrees")
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

  describe("type change", () => {
    const note = (type: Record<string, unknown>) =>
      party([attribute("note", { id: uuid(9070), ...type })])

    /** Модель із `note` і дослівною одиницею, що залежить від колонки. */
    const withUnit = (type: Record<string, unknown>, sql: string) =>
      compiled({ [PARTY]: note(type), "sql/app/dependent.sql": sql })

    /** Ціль із першою моделлю й план до другої. */
    async function planChange(
      before: CompiledModel,
      after: CompiledModel
    ): Promise<PlanOutcome> {
      return inTarget(EMPTY, async (url) => {
        await establish(url, before)
        return plan(url, after)
      })
    }

    const LONG = { type: "String", length: 20 }
    const SHORT = { type: "String", length: 5 }

    it("puts a guard on a lossy type change", async () => {
      const outcome = await planChange(
        await compiled({ [PARTY]: note(LONG) }),
        await compiled({ [PARTY]: note(SHORT) })
      )
      const artifact = planned(outcome)
      const [change] = stepMatching(artifact, /ALTER COLUMN "note" TYPE/)
      expect(change?.class).toBe("destructive")
      expect(change?.guards).toEqual([
        `SELECT count(*) AS lost FROM app.party WHERE note IS NOT NULL AND (note::pg_catalog."varchar"(5))::pg_catalog."varchar"(20) IS DISTINCT FROM note`,
      ])
    })

    it("refuses a type pair without a cast back", async () => {
      // `jsonb → numeric` приводиться, а `numeric → jsonb` — ні: сторож упав
      // би вже на цілі, тож план відмовляє ще на копії
      const outcome = await planChange(
        await compiled({ [PARTY]: note({ type: "Json" }) }),
        await compiled({
          [PARTY]: note({ type: "Numeric", precision: 12, scale: 2 }),
        })
      )
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.type-guard-unsupported"])
      expect(
        outcome.diagnostics.find(
          (d) => d.code === "plan.type-guard-unsupported"
        )?.params
      ).toEqual({ step: expect.stringMatching(/^s\d+$/), reason: "cast" })
    })

    it("refuses a type change it cannot guard", async () => {
      const model = await compiled({ [PARTY]: note(LONG) })
      // Двигун із нестандартним `USING`: сторож не перевіряє довільний вираз
      const rewriting: SchemaEngine = {
        ...engine,
        withDesiredShadow: (o, sql, scope, fn) =>
          engine.withDesiredShadow(o, sql, scope, (db, enginePlan) =>
            fn(db, {
              ...enginePlan,
              empty: false,
              actions: [
                {
                  ...enginePlan.actions[0]!,
                  sql: "ALTER TABLE app.party ALTER COLUMN note TYPE varchar(5) USING upper(note)::varchar(5)",
                },
              ],
            })
          ),
      }
      const outcome = await inTarget(EMPTY, async (url) => {
        await establish(url, model)
        await other(url, "alter table app.party add column extra int")
        return plan(url, model, rewriting)
      })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.type-guard-unsupported"])
      expect(
        outcome.diagnostics.find(
          (d) => d.code === "plan.type-guard-unsupported"
        )?.params
      ).toEqual({ step: "s1", reason: "using" })
    })

    const TRIGGER_FN = `CREATE FUNCTION app.party_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`

    it("refuses a type change under a trigger WHEN condition", async () => {
      const sql = `${TRIGGER_FN}
CREATE TRIGGER party_note BEFORE UPDATE ON app.party FOR EACH ROW WHEN (NEW.note IS DISTINCT FROM OLD.note) EXECUTE FUNCTION app.party_touch();`
      const outcome = await planChange(
        await withUnit(LONG, sql),
        await withUnit(SHORT, sql)
      )
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.type-change-dependent"])
      expect(
        outcome.diagnostics.find((d) => d.code === "plan.type-change-dependent")
          ?.params
      ).toEqual({ objects: "trigger app.party.party_note" })
    })

    it("refuses a type change under a trigger UPDATE OF list", async () => {
      // Зміна без втрат: детектор дивиться на кожну зміну типу, бо `ALTER …
      // TYPE` падає однаково
      const sql = `${TRIGGER_FN}
CREATE TRIGGER party_note_of BEFORE UPDATE OF note ON app.party FOR EACH ROW EXECUTE FUNCTION app.party_touch();`
      const outcome = await planChange(
        await withUnit(SHORT, sql),
        await withUnit(LONG, sql)
      )
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.type-change-dependent"])
      expect(
        outcome.diagnostics.find((d) => d.code === "plan.type-change-dependent")
          ?.params
      ).toEqual({ objects: "trigger app.party.party_note_of" })
    })

    it("refuses a type change under a BEGIN ATOMIC function", async () => {
      const sql =
        "CREATE FUNCTION app.party_notes(lim integer) RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT count(note) FROM app.party LIMIT lim; END;"
      const outcome = await planChange(
        await withUnit(LONG, sql),
        await withUnit(SHORT, sql)
      )
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.type-change-dependent"])
      expect(
        outcome.diagnostics.find((d) => d.code === "plan.type-change-dependent")
          ?.params
      ).toEqual({ objects: "function app.party_notes(lim integer)" })
    })

    const WHEN_TRIGGER = `${TRIGGER_FN}
CREATE TRIGGER party_note BEFORE UPDATE ON app.party FOR EACH ROW WHEN (NEW.note IS DISTINCT FROM OLD.note) EXECUTE FUNCTION app.party_touch();`

    it("lets a type change through when an earlier step drops the dependent trigger", async () => {
      const artifact = planned(
        await planChange(
          await withUnit(LONG, WHEN_TRIGGER),
          await withUnit(SHORT, TRIGGER_FN)
        )
      )
      const ids = artifact.steps.map((s) => s.id)
      const [drop] = stepMatching(artifact, /DROP TRIGGER/)
      const [change] = stepMatching(artifact, /ALTER COLUMN "note" TYPE/)
      expect(ids.indexOf(drop!.id)).toBeLessThan(ids.indexOf(change!.id))
    })

    it("refuses a type change when the dependent trigger is dropped only after it", async () => {
      const before = await withUnit(LONG, WHEN_TRIGGER)
      const after = await withUnit(SHORT, TRIGGER_FN)
      // Двигун, що знімає тригер лише після зміни типу: на момент ALTER він
      // ще стоїть, тож відмова лишається
      const dropsLast: SchemaEngine = {
        ...engine,
        withDesiredShadow: (o, sql, scope, fn) =>
          engine.withDesiredShadow(o, sql, scope, (db, enginePlan) => {
            const late = (a: EngineAction) => /DROP TRIGGER/.test(a.sql)
            return fn(db, {
              ...enginePlan,
              actions: [
                ...enginePlan.actions.filter((a) => !late(a)),
                ...enginePlan.actions.filter(late),
              ],
            })
          }),
      }
      const outcome = await inTarget(EMPTY, async (url) => {
        await establish(url, before)
        return plan(url, after, dropsLast)
      })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.type-change-dependent"])
      expect(
        outcome.diagnostics.find((d) => d.code === "plan.type-change-dependent")
          ?.params
      ).toEqual({ objects: "trigger app.party.party_note" })
    })

    it("keeps refusing a dropped overloaded function it cannot tell apart", async () => {
      // Ідентичність функції двигуна не несе сигнатури: знята перевантажена
      // функція могла бути й іншою, тож детектор її не віднімає
      const spare = `CREATE FUNCTION app.party_notes(lim text) RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT count(*) FROM app.party; END;`
      const dependent = `CREATE FUNCTION app.party_notes(lim integer) RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT count(note) FROM app.party LIMIT lim; END;`
      const outcome = await planChange(
        await withUnit(LONG, `${dependent}\n${spare}`),
        await withUnit(SHORT, spare)
      )
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.type-change-dependent"])
      expect(
        outcome.diagnostics.find((d) => d.code === "plan.type-change-dependent")
          ?.params
      ).toEqual({ objects: "function app.party_notes(lim integer)" })
    })

    it("names a lost connection during the type-change checks as a failed copy", async () => {
      const before = await compiled({ [PARTY]: note(LONG) })
      const after = await compiled({ [PARTY]: note(SHORT) })
      // Порт копії, що губить з'єднання на першому ж запиті транзакції
      const losing: ApplyDatabase = {
        transaction: (db, end, fn) =>
          dbs.scratch.transaction(db, end, () =>
            fn({
              query: () =>
                Promise.reject(new ApplyConnectionLost("connection lost")),
            })
          ),
      }
      const outcome = await inTarget(EMPTY, async (url) => {
        await establish(url, before)
        return buildPlan(
          engine,
          { ...dbs, scratch: losing },
          after,
          { target: { url } },
          []
        )
      })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["engine.clone-failed"])
      expect(codes(outcome)).not.toContain("apply.connection-lost")
    })

    describe("guard probe", () => {
      /** Проба приведень на цілі з `setup`; скільки підготовлених операторів лишилось у сесії. */
      async function probe(
        setup: string,
        casts: { from: string; to: string }[]
      ): Promise<{ reasons: unknown[]; prepared: number }> {
        return inTarget(setup, (url) =>
          writer.transaction({ url }, "rollback", async (tx) => {
            const out = await checkGuardCasts(
              tx,
              casts.map((c) => ({ step: "s1", ...c }))
            )
            const [left] = await tx.query<{ n: number }>(
              "select count(*)::int as n from pg_catalog.pg_prepared_statements"
            )
            return {
              reasons: out.map((d) => [d.code, d.params.reason]),
              prepared: left!.n,
            }
          })
        )
      }

      const DOMAIN =
        "create schema if not exists app; create domain app.code as varchar(5) not null;"

      it("accepts a NOT NULL domain as the old type", async () => {
        expect(
          await probe(DOMAIN, [{ from: "app.code", to: "pg_catalog.text" }])
        ).toEqual({ reasons: [], prepared: 0 })
      })

      it("accepts a NOT NULL domain as the new type", async () => {
        expect(
          await probe(DOMAIN, [{ from: "pg_catalog.text", to: "app.code" }])
        ).toEqual({ reasons: [], prepared: 0 })
      })

      it("names a type without equality and a pair without a cast back", async () => {
        expect(
          await probe(EMPTY, [
            { from: "pg_catalog.json", to: "pg_catalog.text" },
            { from: "pg_catalog.jsonb", to: "pg_catalog.numeric" },
            { from: "pg_catalog.text", to: "pg_catalog.json" },
          ])
        ).toEqual({
          reasons: [
            ["plan.type-guard-unsupported", "equality"],
            ["plan.type-guard-unsupported", "cast"],
          ],
          prepared: 0,
        })
      })
    })

    it("refuses a type change of a column without equality at plan", async () => {
      const model = await compiled({ [PARTY]: party() })
      // Двигун, що міняє `json` на `text`: порівняти старі значення сторож
      // не зможе, тож план відмовляє ще на копії, а не раннер на цілі
      const rewriting: SchemaEngine = {
        ...engine,
        withDesiredShadow: (o, sql, scope, fn) =>
          engine.withDesiredShadow(o, sql, scope, (db, enginePlan) =>
            fn(db, {
              ...enginePlan,
              empty: false,
              actions: [
                {
                  ...enginePlan.actions[0]!,
                  sql: "ALTER TABLE app.v ALTER COLUMN j TYPE text",
                },
              ],
            })
          ),
      }
      const outcome = await inTarget(EMPTY, async (url) => {
        await establish(url, model)
        await other(url, "create table app.v (id int primary key, j json)")
        return plan(url, model, rewriting)
      })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.type-guard-unsupported"])
      expect(
        outcome.diagnostics.find(
          (d) => d.code === "plan.type-guard-unsupported"
        )?.params
      ).toEqual({ step: "s1", reason: "equality" })
    })
  })

  /**
   * Слід кроків (спека промоції §8, R26 плану П3-2a) на плані без промоції:
   * `app.c.pc → app.p.code`. Замок кожного кроку FK береться наперед у
   * найсильнішому режимі, і звірка сліду на доказі не бачить зайвих замків.
   */
  describe("lock footprint", () => {
    const text = (n: number, name: string, length: number) => ({
      id: uuid(n),
      name,
      physicalName: name,
      type: "String",
      length,
    })
    const key = (n: number) => ({
      id: uuid(n),
      name: "id",
      physicalName: "id",
      type: "Integer",
      notNull: true,
    })
    const tables = async (o: {
      fk: boolean
      code?: number
      pc?: number
    }): Promise<CompiledModel> =>
      compiled({
        "custom-tables/P/P.meta.json": customTable("P", {
          id: uuid(9101),
          columns: [key(9102), text(9103, "code", o.code ?? 10)],
          primaryKey: { name: "p_pkey", columns: ["id"] },
          uniques: [{ name: "p_code_key", columns: ["code"] }],
        }),
        "custom-tables/C/C.meta.json": customTable("C", {
          id: uuid(9111),
          columns: [key(9112), text(9113, "pc", o.pc ?? 10)],
          primaryKey: { name: "c_pkey", columns: ["id"] },
          foreignKeys: o.fk
            ? [
                {
                  name: "c_pc_fk",
                  columns: ["pc"],
                  references: {
                    object: { kind: "CustomTable", name: "P" },
                    columns: ["code"],
                  },
                },
              ]
            : [],
        }),
      })
    const table = (name: string, mode: string) => ({
      schema: "app",
      name,
      mode,
    })

    it.each([
      [
        "drops an FK",
        { fk: true },
        { fk: false },
        table("p", "accessExclusive"),
      ],
      [
        "adds an FK",
        { fk: false },
        { fk: true },
        table("p", "shareRowExclusive"),
      ],
      [
        "changes the type of an FK column",
        { fk: true },
        { fk: true, pc: 20 },
        table("p", "accessExclusive"),
      ],
      [
        "changes the type of a referenced column",
        { fk: true },
        { fk: true, code: 20 },
        table("c", "accessExclusive"),
      ],
    ])(
      "locks the other side up front when the plan %s",
      async (_, before, after, expected) => {
        const from = await tables(before)
        const to = await tables(after)
        await inTarget(EMPTY, async (url) => {
          await establish(url, from)
          const outcome = await plan(url, to)
          const artifact = planned(outcome)
          expect(artifact.locks).toContainEqual(expected)
          expect(artifact.implicitLocks).toEqual([])
          // Доказ звірив замки сесії зі слідом: зайвого немає
          expect(codes(outcome)).not.toContain("apply.lock-footprint-exceeded")
          // І на цілі: репетиція бере ті самі замки наперед
          const rehearsal = await executePlan(writer, { url }, artifact, {
            mode: "rehearse",
            planHash: artifact.planHash,
            allow: artifact.requiredPermissions,
            snapshot: canonicalSnapshot(to),
          })
          expect(rehearsal).toMatchObject({
            status: "rolledBack",
            diagnostics: [],
          })
        })
      }
    )
  })

  describe("promotion", () => {
    type Json = Record<string, unknown>

    /**
     * Тека фікстури без модуля й рахунку, з таблицею контактів як ТЧ. Коментар
     * таблиці фікстури й коментар колонки `inn` `promote` переносить в описи
     * дослівно й сам дає їм клас `metadata` (R24).
     */
    function contactsProject(): Map<string, string> {
      const files = promotionProject({
        module: false,
        contacts: true,
        invoice: false,
      })
      const party = JSON.parse(files.get(COUNTERPARTY_FILE)!) as Json
      ;(party.columns as Json[])[2]!.comment = "Taxpayer number"
      files.set(COUNTERPARTY_FILE, JSON.stringify(party))
      const raw = JSON.parse(files.get(CONTACT_FILE)!) as Json
      ;(raw.columns as Json[]).push({
        id: uuid(7105),
        name: "lineNumber",
        physicalName: "line_number",
        type: "Integer",
        notNull: true,
      })
      files.set(CONTACT_FILE, JSON.stringify(raw))
      return files
    }

    /** Мапінг без кроку `fill` і з ТЧ `contacts`. */
    function contactsMapping(): PromoteInput {
      const mapping = structuredClone(
        counterpartyMapping({ module: false, fill: false })
      )
      mapping.tabularSections = [
        {
          table: "CounterpartyContact",
          name: "contacts",
          columns: {
            id: { to: "standard", name: "ref" },
            counterpartyId: { to: "standard", name: "parent" },
            lineNumber: { to: "standard", name: "lineNumber" },
            phone: {
              to: "attribute",
              collection: "attributes",
              element: { name: "phone" },
            },
          },
        },
      ]
      return mapping
    }

    interface Promoted {
      before: CompiledModel
      after: CompiledModel
      afterFiles: Map<string, string>
      record: PromotionRecord
      input: PromotionInput
    }

    async function promoted(
      files: Map<string, string> = contactsProject(),
      mapping: PromoteInput = contactsMapping()
    ): Promise<Promoted> {
      const compiledFiles = async (f: ReadonlyMap<string, string>) => {
        const result = await compile(f)
        expect(
          result.diagnostics.filter((d) => d.severity === "error")
        ).toEqual([])
        return result.model!
      }
      const before = await compiledFiles(files)
      let n = 900_000
      const result = await promoteObject(files, mapping, {
        schemaPath: (file, schemaFile) => `schemas-of/${file}/${schemaFile}`,
        newId: () => uuid(++n),
      })
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual(
        []
      )
      const record = result.record!
      const after = applyChanges(files, result.changes)
      return {
        before,
        after: await compiledFiles(after),
        afterFiles: after,
        record,
        input: { record, file: `plans/${COUNTERPARTY_ID}.promotion.json` },
      }
    }

    /** Ціль у стані до промоції, `drift` поверх неї, і план стану після. */
    async function planPromotion(
      p: Promoted,
      o: {
        drift?: string
        superuser?: boolean
        records?: PromotionInput[]
      } = {}
    ): Promise<PlanOutcome> {
      return inTarget(EMPTY, async (url) => {
        await establish(url, p.before)
        if (o.drift !== undefined)
          await other(o.superuser === true ? asSuperuser(url) : url, o.drift)
        return buildPlan(
          engine,
          dbs,
          p.after,
          { target: { url } },
          o.records ?? [p.input]
        )
      })
    }

    /** Стара таблиця фікстури, як її бачить ціль до промоції. */
    const OLD = "app.counterparties"

    const params = (outcome: PlanOutcome, code: string) =>
      outcome.diagnostics.filter((d) => d.code === code).map((d) => d.params)

    it("plans a promotion with intent steps first and proves it on a copy", async () => {
      const p = await promoted()
      const outcome = await planPromotion(p)
      const artifact = planned(outcome)

      // Кроки наміру — першими: таблиця, колонки, потім канонічні імена
      const intent = artifact.steps.filter((s) => s.origin === "intent")
      expect(artifact.steps.slice(0, intent.length)).toEqual(intent)
      expect(intent.map((s) => s.sql)).toEqual([
        "ALTER TABLE app.counterparties RENAME TO counterparty",
        "ALTER TABLE app.counterparty RENAME COLUMN created_at TO simetra_retired_1",
        "ALTER TABLE app.counterparty RENAME COLUMN name TO description",
        "ALTER TABLE app.counterparty RENAME COLUMN inn TO tax_id",
        "ALTER TABLE app.counterparty RENAME COLUMN is_deleted TO archived",
        "ALTER TABLE app.counterparty_contacts RENAME COLUMN counterparty_id TO parent_id",
        "ALTER TABLE app.counterparty RENAME CONSTRAINT counterparties_pkey TO counterparty_pkey",
        "ALTER TABLE app.counterparty_contacts RENAME CONSTRAINT counterparty_contacts_counterparty_id_fkey TO counterparty_contacts_parent_id_fkey",
      ])
      // Нумерація наскрізна: кроки двигуна йдуть за кроками наміру
      expect(artifact.steps.map((s) => s.id)).toEqual(
        artifact.steps.map((_, i) => `s${i + 1}`)
      )
      // PK і FK ТЧ — перейменування, а не DROP/ADD; таблиці не перестворено
      const engine = artifact.steps.filter((s) => s.origin === "engine")
      expect(
        engine.filter((s) =>
          /pkey|parent_id_fkey|DROP TABLE|CREATE TABLE/.test(s.sql)
        )
      ).toEqual([])
      expect(stepMatching(artifact, /DROP COLUMN/).map((s) => s.sql)).toEqual([
        'ALTER TABLE "app"."counterparty" DROP COLUMN "simetra_retired_1"',
      ])

      // Дослівно перенесені коментарі знімаються з бази з класом `metadata`
      // від `promote` (R24), а не відмовою
      expect(
        p.record.conversions
          .filter((c) => c.subject.includes("#comment"))
          .map((c) => [c.subject, c.class])
      ).toEqual([
        ["Counterparty#comment", "metadata"],
        ["Counterparty#comment/inn", "metadata"],
      ])
      const comments = stepMatching(artifact, /^COMMENT ON/)
      expect(comments.map((s) => s.sql)).toEqual([
        'COMMENT ON COLUMN "app"."counterparty"."tax_id" IS NULL',
        'COMMENT ON TABLE "app"."counterparty" IS NULL',
      ])

      const section = artifact.promotion!
      expect(section.conversions).toEqual(
        expect.arrayContaining(
          comments.map((s) => ({ step: s.id, class: "metadata" }))
        )
      )
      expect(section.recordHash).toBe(await promotionRecordHash(p.record))
      expect(section.record).toEqual(p.record)
      const counterparty = { schema: "app", name: "counterparty" }
      const contacts = { schema: "app", name: "counterparty_contacts" }
      expect(section.columns).toEqual([
        { table: counterparty, from: "created_at", to: "simetra_retired_1" },
        { table: counterparty, from: "name", to: "description" },
        { table: counterparty, from: "inn", to: "tax_id" },
        { table: counterparty, from: "is_deleted", to: "archived" },
        { table: contacts, from: "counterparty_id", to: "parent_id" },
      ])
      expect(section.canonicalNames).toEqual([
        {
          kind: "constraint",
          table: counterparty,
          from: "counterparties_pkey",
          to: "counterparty_pkey",
        },
        {
          kind: "constraint",
          table: contacts,
          from: "counterparty_contacts_counterparty_id_fkey",
          to: "counterparty_contacts_parent_id_fkey",
        },
      ])
      // Кожна таблиця запису — один замір; колонка зі зміною типу несе крок
      expect(
        section.preservation.map((t) => [t.before.table, t.after.table])
      ).toEqual(p.record.tables.map((t) => [t.from, t.to]))
      const retype = stepMatching(artifact, /ALTER COLUMN "description" TYPE/)
      expect(retype).toHaveLength(1)
      expect(p.record.typeChanges.map((t) => t.column)).toEqual(["description"])
      expect(
        section.preservation
          .flatMap((t) => t.columns)
          .filter((c) => c.typeChangeStep !== undefined)
      ).toEqual([
        {
          before: "(name::character varying(150))",
          after: "description",
          typeChangeStep: retype[0]!.id,
        },
      ])
      expect(section.permissionItems.map((i) => i.token)).toEqual([
        "access:app.counterparty_contacts",
        "remove:app.counterparty",
      ])
      expect(artifact.requiredPermissions.slice(0, 2)).toEqual([
        "access:app.counterparty_contacts",
        "remove:app.counterparty",
      ])
      // Блокування — у старих іменах, до кроку наміру
      expect(artifact.locks).toEqual([
        { schema: "app", name: "counterparties", mode: "accessExclusive" },
        {
          schema: "app",
          name: "counterparty_contacts",
          mode: "accessExclusive",
        },
      ])
      expect(
        outcome.diagnostics.find(
          (d) => d.code === "plan.promotion-commit-pending"
        )?.severity
      ).toBe("warning")
      expect(errors(outcome)).toEqual([])
    })

    it("does not lock a foreign key target when the promotion only renames the FK column", async () => {
      const files = contactsProject()
      files.set(
        "catalogs/Region/Region.meta.json",
        JSON.stringify(catalog("Region", { id: uuid(7301) }))
      )
      const party = JSON.parse(files.get(COUNTERPARTY_FILE)!) as Json
      ;(party.columns as Json[]).push({
        id: uuid(7007),
        name: "regionId",
        physicalName: "region_id",
        type: "UUID",
      })
      party.foreignKeys = [
        {
          name: "counterparties_region_id_fkey",
          columns: ["regionId"],
          references: {
            object: { kind: "Catalog", name: "Region" },
            columns: ["ref"],
          },
        },
      ]
      files.set(COUNTERPARTY_FILE, JSON.stringify(party))
      const mapping = contactsMapping()
      mapping.columns.regionId = {
        to: "attribute",
        collection: "attributes",
        element: { name: "area" },
      }
      const p = await promoted(files, mapping)
      const outcome = await planPromotion(p)
      const artifact = planned(outcome)
      const region = p.after.physical.tables.find(
        (t) => t.origin.objectId === uuid(7301)
      )!
      // Перейменування колонки FK і самого FK займає лише власну таблицю
      // (R26): ціль FK не блокується ні явно, ні неявно
      expect(
        stepMatching(artifact, /RENAME COLUMN region_id TO area_id$/)
      ).toHaveLength(1)
      expect(
        stepMatching(
          artifact,
          /RENAME CONSTRAINT counterparties_region_id_fkey/
        )
      ).toHaveLength(1)
      expect(
        [...artifact.locks, ...artifact.implicitLocks].filter(
          (l) => l.name === region.name
        )
      ).toEqual([])
      // Звірка сліду на доказі: зайвого замка немає
      expect(outcome.diagnostics.map((d) => d.code)).not.toContain(
        "apply.lock-footprint-exceeded"
      )
    })

    it("refuses a dropped comment that the record does not classify", async () => {
      // Запис без класу перенесеного коментаря (зіпсований чи старший за
      // R24): зникнення коментаря нічим не покрите — відмова, а не мовчки
      const p = await promoted()
      const record = {
        ...p.record,
        conversions: p.record.conversions.filter(
          (c) => !c.subject.includes("#comment")
        ),
      }
      const outcome = await planPromotion(p, {
        records: [{ ...p.input, record }],
      })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.removal-unclassified"])
      expect(params(outcome, "plan.removal-unclassified")).toEqual([
        {
          paths:
            "tables.app.counterparties.comment, tables.app.counterparties.columns.inn.comment",
        },
      ])
    })

    it.each([
      ["with", "", "lockable"],
      [
        "without",
        `ALTER TABLE storage.objects OWNER TO ${STRANGER}`,
        "implicit",
      ],
    ])(
      "plans a foreign key target outside the scope %s a lock privilege",
      async (_, drift, expected) => {
        // Вилучена колонка з FK на `storage.objects`: зняття FK бере ACCESS
        // EXCLUSIVE на ціль, а явний замок — лише з правом на LOCK (R26)
        const files = contactsProject()
        const party = JSON.parse(files.get(COUNTERPARTY_FILE)!) as Json
        ;(party.columns as Json[]).push({
          id: uuid(7008),
          name: "objectId",
          physicalName: "object_id",
          type: "UUID",
        })
        party.foreignKeys = [
          {
            name: "counterparties_object_id_fkey",
            columns: ["objectId"],
            references: {
              external: {
                schema: "storage",
                table: "objects",
                columns: ["id"],
              },
            },
          },
        ]
        files.set(COUNTERPARTY_FILE, JSON.stringify(party))
        const mapping = contactsMapping()
        mapping.columns.objectId = { to: "retire" }
        const p = await promoted(files, mapping)
        const outcome = await planPromotion(p, {
          ...(drift === "" ? {} : { drift, superuser: true }),
        })
        const artifact = planned(outcome)
        const objects = {
          schema: "storage",
          name: "objects",
          mode: "accessExclusive",
        }
        const locked = artifact.locks.filter((l) => l.schema === "storage")
        const dropFk = stepMatching(
          artifact,
          /DROP CONSTRAINT "counterparties_object_id_fkey"/
        )[0]!
        if (expected === "lockable") {
          expect(locked).toEqual([objects])
          expect(artifact.implicitLocks).toEqual([])
        } else {
          expect(locked).toEqual([])
          expect(artifact.implicitLocks).toEqual([
            { ...objects, step: dropFk.id },
          ])
        }
        // Читання таблиці провайдера блоковані на всю транзакцію
        expect(params(outcome, "plan.foreign-exclusive-lock")).toEqual([
          { table: "storage.objects", step: dropFk.id },
        ])
        expect(outcome.diagnostics.map((d) => d.code)).not.toContain(
          "apply.lock-footprint-exceeded"
        )
      }
    )

    it("refuses a plan whose SQL function body is broken", async () => {
      // Тінь вантажить тіла без перевірки, а раннер перевіряє: тіло читає
      // колонку за старим ім'ям, і доказ на копії падає на кроці функції
      const p = await promoted()
      const files = await acceptDebt(
        new Map([
          ...p.afterFiles,
          [
            "sql/app/broken.sql",
            "CREATE FUNCTION app.party_inns() RETURNS bigint LANGUAGE sql STABLE AS $fn$ SELECT count(inn) FROM app.counterparty $fn$;\n",
          ],
        ])
      )
      const result = await compile(files)
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual(
        []
      )
      const outcome = await planPromotion({ ...p, after: result.model! })
      expect(outcome.status).toBe("refused")
      expect(params(outcome, "apply.step-failed")).toEqual([
        expect.objectContaining({ sqlstate: "42703" }),
      ])
    })

    it("compares owners of the renamed tables through the intent", async () => {
      // Тінь називає таблицю новим іменем, ціль — старим: без перекладу
      // через намір чужий власник прийнятої таблиці пройшов би непоміченим
      const outcome = await planPromotion(await promoted(), {
        drift: `GRANT CREATE ON SCHEMA app TO ${OWNER};
          ALTER TABLE ${OLD} OWNER TO ${OWNER}`,
      })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.owner-mismatch"])
      expect(params(outcome, "plan.owner-mismatch")[0]?.objects).toMatch(
        new RegExp(
          `^relation app\\.counterparties \\(owner ${OWNER}, expected `
        )
      )
    })

    it("refuses a transition when no record is passed", async () => {
      const p = await promoted()
      const outcome = await planPromotion(p, { records: [] })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.promotion-record-missing"])
    })

    it("refuses a promotion when an API role can write the adopted table", async () => {
      const outcome = await planPromotion(await promoted(), {
        drift: `GRANT INSERT ON ${OLD} TO authenticated`,
      })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.write-path"])
      expect(params(outcome, "plan.write-path")).toEqual([
        {
          // Лише таблиця зі знахідкою: контакти на запис закриті
          table: "app.counterparties",
          detail: "grant INSERT to authenticated on app.counterparties",
        },
      ])
    })

    it("refuses default privileges granted to a role an API role is a member of", async () => {
      const outcome = await planPromotion(await promoted(), {
        drift: `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT INSERT ON TABLES TO ${WRITERS}`,
      })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.write-path"])
      expect(params(outcome, "plan.write-path")).toEqual([
        {
          // Схемні типові привілеї стосуються всіх таблиць одиниці схеми
          table: "app.counterparties, app.counterparty_contacts",
          detail: expect.stringMatching(
            new RegExp(`in schema app grant INSERT to ${WRITERS}$`)
          ),
        },
      ])
    })

    it.each([
      [
        "a column-level write grant",
        `GRANT UPDATE (name) ON ${OLD} TO authenticated`,
        "column grant UPDATE to authenticated on app.counterparties",
      ],
      [
        "schema default privileges",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT INSERT ON TABLES TO anon",
        "in schema app grant INSERT to anon",
      ],
      [
        "global default privileges of the applying role",
        "ALTER DEFAULT PRIVILEGES GRANT INSERT ON TABLES TO authenticated",
        "grant INSERT to authenticated",
      ],
      [
        "an insert policy",
        `CREATE POLICY p ON ${OLD} FOR INSERT TO authenticated WITH CHECK (true)`,
        "policy app.counterparties.p (INSERT)",
      ],
      [
        "a grant to PUBLIC",
        `GRANT DELETE ON ${OLD} TO PUBLIC`,
        "grant DELETE to anon on app.counterparties",
      ],
      [
        "TRUNCATE",
        `GRANT TRUNCATE ON ${OLD} TO service_role`,
        "grant TRUNCATE to service_role on app.counterparties",
      ],
    ])("refuses through %s", async (_, drift, detail) => {
      const outcome = await planPromotion(await promoted(), { drift })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.write-path"])
      expect(params(outcome, "plan.write-path")[0]?.detail).toContain(detail)
    })

    it.each([
      [
        // `OWNED BY` і `SET SCHEMA` таку пару не дають (послідовність мусить
        // бути в схемі таблиці), але каталог її не забороняє: залежність
        // вписано прямо, як її лишив би інший шлях
        "OWNED BY",
        `CREATE SCHEMA seq; CREATE SEQUENCE seq.party_numbers;
         INSERT INTO pg_catalog.pg_depend
           (classid, objid, objsubid, refclassid, refobjid, refobjsubid, deptype)
         SELECT 'pg_class'::regclass, 'seq.party_numbers'::regclass, 0,
           'pg_class'::regclass, a.attrelid, a.attnum, 'a'
         FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = '${OLD}'::regclass AND a.attname = 'inn'`,
        true,
      ],
      [
        "DEFAULT nextval",
        `CREATE SCHEMA seq; CREATE SEQUENCE seq.party_numbers;
         ALTER TABLE ${OLD} ALTER COLUMN inn SET DEFAULT nextval('seq.party_numbers')::text`,
        false,
      ],
    ])(
      "refuses a sequence outside the unit schema through %s",
      async (_, drift, superuser) => {
        const outcome = await planPromotion(await promoted(), {
          drift,
          superuser,
        })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.promotion-unsupported"])
        expect(params(outcome, "plan.promotion-unsupported")).toEqual([
          {
            objectId: COUNTERPARTY_ID,
            file: `plans/${COUNTERPARTY_ID}.promotion.json`,
            reason: "sequenceSchema",
            table: "app.counterparties",
            column: "inn",
            sequence: "seq.party_numbers",
          },
        ])
      }
    )

    it("plans a sequence in the unit schema without the refusal", async () => {
      // Та сама послідовність у схемі таблиці — справа канонічних імен і
      // класів видалень, а не відмови виявлення
      const outcome = await planPromotion(await promoted(), {
        drift:
          "CREATE SEQUENCE app.party_numbers OWNED BY app.counterparties.inn",
      })
      expect(
        params(outcome, "plan.promotion-unsupported").map((d) => d.reason)
      ).not.toContain("sequenceSchema")
      expect(outcome.status).toBe("planned")
    })

    it("plans unchanged files without a promotion as P3-1 did", async () => {
      const p = await promoted()
      // Свіжа ціль: перехід не виявлено, запис — не для неї (рядок 9)
      const [without, withRecord] = await inTarget(EMPTY, async (url) => [
        await buildPlan(engine, dbs, p.before, { target: { url } }, []),
        await buildPlan(engine, dbs, p.before, { target: { url } }, [p.input]),
      ])
      const a = planned(without!)
      const b = planned(withRecord!)
      expect(a.promotion).toBeNull()
      expect(b.promotion).toBeNull()
      expect(b.steps).toEqual(a.steps)
      expect(b.planHash).toBe(a.planHash)
      expect(codes(withRecord!)).toContain("plan.promotion-not-applicable")
      expect(codes(without!)).not.toContain("plan.promotion-commit-pending")
    })
  })
})
