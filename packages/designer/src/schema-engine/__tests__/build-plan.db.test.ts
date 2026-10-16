import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  applyChanges,
  canonicalSnapshot,
  compile,
  derivePromotionFacts,
  loadSqlParser,
  promoteInput,
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
  desiredForApply,
  executePlan,
  readDataFacts,
  reverseGenerate,
  serializePlan,
  SUPABASE_EXPECTED_BLIND_FUNCTIONS,
  tableKey,
  type ApplyDatabase,
  type EngineAction,
  type EngineScope,
  type PlanArtifact,
  type PlanOutcome,
  type PlannedDataTable,
  type PromotionInput,
  type RehearsalProof,
  type SchemaEngine,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  acceptDebt,
  attribute,
  catalog,
  CATALOG_FILE,
  CONTACT_FILE,
  COUNTERPARTY_FILE,
  COUNTERPARTY_ID,
  counterpartyMapping,
  customTable,
  metaFiles,
  promotionProject,
  project,
  testDatabaseUrl,
  testRoleName,
  testSuperuserUrl,
  uuid,
} from "../../../../simetra/test/support"
import {
  asSuperuser,
  dropRoles,
  inTarget as loadTarget,
  query,
} from "../../__tests__/support/db"

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
const OWNER = testRoleName("build_plan_owner")
/** Роль, членом якої роль сесії не є: об'єкт такого власника план не зніме. */
const STRANGER = testRoleName("build_plan_stranger")

/** Роль-група, членом якої є роль API: її привілеї роль API успадковує. */
const WRITERS = testRoleName("build_plan_writers")

/** Роль адміністрування копії, інша за роль плану (R7 плану П3-2b-0). */
const COPIER = testRoleName("build_plan_copier")
const COPIER_PASSWORD = "simetra_build_plan_copier"

/** Службова роль провайдера, членом якої роль сесії застосування не є. */
const SERVICE_ROLE = "supabase_auth_admin"

beforeAll(() =>
  query(
    testSuperuserUrl(),
    `create role ${OWNER} nologin; grant ${OWNER} to postgres;
     create role ${STRANGER} nologin;
     create role ${WRITERS} nologin; grant ${WRITERS} to authenticated;
     create role ${COPIER} login password '${COPIER_PASSWORD}';`
  )
)
afterAll(() => dropRoles(OWNER, STRANGER, WRITERS, COPIER))

/**
 * Ціль із `setup`; базу прибирає порт. Спільний `inTarget` із межею цілі
 * цього файлу.
 */
const inTarget = <T>(
  setup: string,
  fn: (url: string) => Promise<T>
): Promise<T> => loadTarget(setup, targetScope, fn)

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

/**
 * Доказ репетиції: бажаний каталог із бажаної тіні моделі, як його будує
 * `applyTool`.
 */
async function rehearsalOf(
  model: CompiledModel,
  artifact: PlanArtifact
): Promise<RehearsalProof> {
  const desired = await desiredForApply(model)
  const shadow = await engine.withDesiredShadow(
    { target: stack },
    desired.sql,
    artifact.scope,
    (db) => engine.extract(db, artifact.scope)
  )
  if (shadow.status !== "loaded")
    throw new Error(
      `desired shadow did not load: ${shadow.diagnostics.map((d) => d.message).join("; ")}`
    )
  return { engine, desired: shadow.value.catalog }
}

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

/**
 * Попередження про сліпі функції, яке дає застосування чи репетиція: тригерна
 * plpgsql-функція без тригера сліпа для `plpgsql_check` (рішення 5 плану
 * П3-2b-1). Немає — порожньо.
 */
const blindDiagnostics = (functions: readonly string[]) =>
  functions.length === 0
    ? []
    : [
        expect.objectContaining({
          code: "apply.function-check-blind",
          severity: "warning",
          params: { count: functions.length, functions: functions.join(", ") },
        }),
      ]

/** Застосовує артефакт так само, як інструмент `apply`. */
async function applyArtifact(
  url: string,
  artifact: PlanArtifact,
  model: CompiledModel,
  blind: readonly string[] = []
): Promise<void> {
  const outcome = await executePlan(writer, { url }, artifact, {
    mode: "apply",
    planHash: artifact.planHash,
    allow: artifact.requiredPermissions,
    snapshot: canonicalSnapshot(model),
  })
  expect(outcome.diagnostics).toEqual(blindDiagnostics(blind))
  expect(outcome.status).toBe("committed")
}

/**
 * План і застосування моделі на цілі; `blind` — сліпі функції, про які
 * застосування попереджає.
 */
async function establish(
  url: string,
  model: CompiledModel,
  blind: readonly string[] = []
): Promise<void> {
  await applyArtifact(url, planned(await plan(url, model)), model, blind)
}

const stepMatching = (artifact: PlanArtifact, pattern: RegExp) =>
  artifact.steps.filter((s) => pattern.test(s.sql))

/**
 * Читач цілі, на якій `plpgsql_check` немає й поставити його не можна: на
 * запиті фактів розширення справжній читач підмінено, решта — як є.
 */
const readerWithoutPlpgsqlCheck: ApplyDatabase = {
  transaction: (target, end, fn) =>
    dbs.reader.transaction(target, end, (tx) =>
      fn({
        ...tx,
        query: async <R extends Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[]
        ): Promise<R[]> =>
          sql.includes("pg_available_extension_versions")
            ? ([
                {
                  installed: false,
                  schema: null,
                  schemaUsage: false,
                  functionExecute: false,
                  available: false,
                  trusted: false,
                  superuser: false,
                  createOnDatabase: true,
                  checkSchemaTaken: false,
                },
              ] as unknown as R[])
            : tx.query<R>(sql, params),
      })
    ),
}

/**
 * Сліпі функції поза межею (сесією суперкористувача): застосунку
 * (`other.fh()`), провайдера з переліку пресету (`pgbouncer.get_auth(text)`:
 * її вже має засів тіні, але з власником `postgres`) і провайдера поза ним.
 * Власник — роль, членом якої сесія не є, без `EXECUTE` для всіх, як у
 * `pgbouncer.get_auth` справжнього стеку.
 */
const BLIND_SETUP = `create schema other;
  create function other.fh() returns int language sql as $$ select 1 $$;
  create function pgbouncer.other_auth(p_usename text) returns text language plpgsql as $$ begin return p_usename; end $$;
  alter function other.fh() owner to ${STRANGER};
  revoke execute on function other.fh() from public;
  alter function pgbouncer.get_auth(text) owner to ${STRANGER};
  revoke execute on function pgbouncer.get_auth(text) from public;
  alter function pgbouncer.other_auth(text) owner to ${STRANGER};
  revoke execute on function pgbouncer.other_auth(text) from public;`

// Конкурентно: ціль і копії кожного тесту — власні бази, ролі створює лише
// `beforeAll`, а лічильники двигунів-шпигунів — локальні для тесту
describe.concurrent("buildPlan", () => {
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

  it("carries the plpgsql_check mode of the target", async () => {
    // Розширення на стеку доступне, а supautils дає ролі його поставити
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      const outcome = await plan(url, model)
      expect(planned(outcome).plpgsqlCheck).toBe("transient")
      expect(codes(outcome)).not.toContain("plan.plpgsql-check-unavailable")
    })
  })

  it("carries no foreign keys of the target when no step needs them", async () => {
    // Створення таблиць з ключами слідові FK цілі не потрібні (рішення 9
    // плану П3-2b-1): раннерові звіряти нічого
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      expect(planned(await plan(url, model)).foreignKeys).toEqual({
        subjects: [],
        live: [],
      })
    })
  })

  it("carries no invalid objects when the desired state has none", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      expect(planned(await plan(url, model)).desiredInvalid).toEqual([])
    })
  })

  it("reads the invalid objects from the desired shadow, not from the target", async () => {
    // Читач підмінює лише запит недійсних об'єктів і лише на базі, що не є
    // ціллю, — тобто на бажаній тіні: рядок в артефакті доводить джерело
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      const reader: ApplyDatabase = {
        transaction: (target, end, fn) =>
          dbs.reader.transaction(target, end, (tx) =>
            fn({
              ...tx,
              query: async <R extends Record<string, unknown>>(
                sql: string,
                params?: readonly unknown[]
              ): Promise<R[]> =>
                target.url !== url && sql.includes("convalidated")
                  ? ([{ object: "constraint app.x x_a" }] as unknown as R[])
                  : tx.query<R>(sql, params),
            })
          ),
      }
      const outcome = await buildPlan(
        engine,
        { ...dbs, reader },
        model,
        { target: { url } },
        []
      )
      expect(planned(outcome).desiredInvalid).toEqual(["constraint app.x x_a"])
    })
  })

  it("carries a real NOT VALID constraint of the desired shadow", async () => {
    // Метадані NOT VALID не несуть, тож обмеження дописано до SQL бажаного
    // стану, який вантажить тінь: справжній `convalidated = false` у тіні
    // доходить до артефакту, а прогін-доказ приймає його як бажане
    const model = await compiled({ [PARTY]: party() })
    const notValid =
      "\nALTER TABLE app.party ADD CONSTRAINT party_mark CHECK (deletion_mark IS NOT NULL) NOT VALID;\n"
    const withNotValid: SchemaEngine = {
      ...engine,
      withDesiredShadow: (o, sql, scope, fn) =>
        engine.withDesiredShadow(o, sql + notValid, scope, fn),
    }
    await inTarget(EMPTY, async (url) => {
      const outcome = await plan(url, model, withNotValid)
      expect(planned(outcome).desiredInvalid).toEqual([
        "constraint app.party party_mark",
      ])
    })
  })

  it("warns about a plan on a target without plpgsql_check", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      const outcome = await buildPlan(
        engine,
        { ...dbs, reader: readerWithoutPlpgsqlCheck },
        model,
        { target: { url } },
        []
      )
      expect(planned(outcome).plpgsqlCheck).toBe("unavailable")
      expect(
        outcome.diagnostics.filter(
          (d) => d.code === "plan.plpgsql-check-unavailable"
        )
      ).toMatchObject([{ severity: "warning", params: { on: "target" } }])
    })
  })

  // Рішення 5 плану П3-2b-1 і вердикт «(г)»: сліпа функція з переліку
  // пресету провайдера — рядок виводу, а не попередження; сліпа функція
  // провайдера поза переліком і функція застосування — попередження
  it("warns about blind functions in the plan except the provider's expected ones", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await query(asSuperuser(url), BLIND_SETUP)
      const outcome = await plan(url, model)
      // Засів тіні несе базовий стан провайдера, тож сліпі там усі функції
      // переліку: ідентичності пресету збігаються з каталогом поіменно
      expect(outcome).toMatchObject({
        status: "planned",
        expectedBlindFunctions: SUPABASE_EXPECTED_BLIND_FUNCTIONS.length,
      })
      expect(
        outcome.diagnostics.filter(
          (d) => d.code === "apply.function-check-blind"
        )
      ).toMatchObject([
        {
          severity: "warning",
          params: {
            count: 2,
            functions: "other.fh(), pgbouncer.other_auth(text)",
          },
        },
      ])
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
      await query(url, "alter table app.party add column extra int")
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
      await query(url, `alter table app.party owner to ${OWNER}`)
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
      await query(url, "alter table app.party owner to postgres")
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
      await query(
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
      await query(url, "create extension pg_trgm schema public")
      const [extension] = await query<{ owner: string; member: boolean }>(
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
      await query(
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
      await query(
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
      await query(url, "alter table app.party set (fillfactor = 70)")
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
      await query(url, "alter table app.counter alter column seq set cache 10")
      const artifact = planned(await plan(url, model))
      expect(artifact.drift?.sections).toContain("sequences")
      expect(stepMatching(artifact, /CACHE\s+1\b/i)).not.toEqual([])
    })
  })

  it("plans over drift by fingerprint when the engine changed", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      await query(
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
      await query(url, "delete from simetra.marker")
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
          await query(clone.url, "create table app.ghost ()")
          return fn(clone)
        }),
    }
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      await query(url, "alter table app.party add column extra int")
      const outcome = await plan(url, model, ghostly)
      expect(outcome.status).toBe("refused")
      expect(new Set(errors(outcome))).toEqual(new Set(["plan.clone-mismatch"]))
    })
  })

  it("refuses a clone whose column order differs from the target", async () => {
    // Порядок колонок копії ↔ ціль звіряється точно (R4): marker бере модель
    // копії, тож копія мусить відтворювати порядок цілі
    const attributes = [
      attribute("first", { id: uuid(9050) }),
      attribute("last", { id: uuid(9051) }),
    ]
    const before = await compiled({ [PARTY]: party(attributes) })
    // Доказ біжить лише для непорожнього плану
    const after = await compiled({
      [PARTY]: party([...attributes, attribute("extra", { id: uuid(9052) })]),
    })
    const reordering: SchemaEngine = {
      ...engine,
      withTargetClone: (o, target, scope, fn) =>
        engine.withTargetClone(o, target, scope, async (clone) => {
          await query(
            clone.url,
            "alter table app.party drop column first; alter table app.party add column first boolean"
          )
          return fn(clone)
        }),
    }
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      const outcome = await plan(url, after, reordering)
      expect(outcome.status).toBe("refused")
      expect(
        outcome.diagnostics
          .filter((d) => d.code === "plan.clone-mismatch")
          .map((d) => d.params)
      ).toEqual([{ how: "model", detail: "tables.app.party.columns" }])
    })
  })

  it("proves an adopted table whose column type the same database defines", async () => {
    // Відтворення В-1: копія в одну фазу ставила колонку енаму в кінець
    // таблиці, бо двигун створює таблицю раніше за тип
    await inTarget(
      `create schema app;
       create type app.color as enum ('red', 'green');
       create table app.t (id uuid primary key, c app.color, name text);`,
      async (url) => {
        const extracted = await engine.extract({ url }, targetScope)
        const reversed = await reverseGenerate(extracted.model, {
          project: {
            name: "Adopted",
            defaultSchema: "app",
            attributeCase: "camelCase",
            databaseProvider: "supabase",
          },
          existing: new Map(),
          newId: () => randomUUID(),
          schemaPath: (_file, schemaFile) => `schemas/${schemaFile}`,
          parse: await loadSqlParser(),
        })
        expect(
          reversed.diagnostics.filter((d) => d.severity === "error")
        ).toEqual([])
        const result = await compile(await acceptDebt(reversed.files))
        expect(
          result.diagnostics.filter((d) => d.severity === "error")
        ).toEqual([])
        const outcome = await plan(url, result.model!)
        expect(codes(outcome)).not.toContain("plan.clone-mismatch")
        planned(outcome)
      }
    )
  })

  it("proves a schema whose own default privileges equal the built-in ones", async () => {
    // Відтворення В-2: «роль собі ALL» двигун не бачить, а відбиток бачив
    const model = await compiled({ [PARTY]: party() })
    await inTarget(
      `create schema app;
       alter default privileges for role postgres in schema app
         grant all on tables to postgres, anon;
       create table app.party (id uuid primary key);`,
      async (url) => {
        const outcome = await plan(url, model)
        expect(errors(outcome)).not.toContain("plan.clone-mismatch")
      }
    )
  })

  it("proves a scope with public on the provider base state", async () => {
    // Відтворення В-3: типові привілеї базового стану провайдера в `public`
    // (власні та службових ролей) копія не відтворює, а двигун їх не бачить
    const model = await compiled({
      "project.meta.json": project({ defaultSchema: "public" }),
      [PARTY]: party(),
    })
    await inTarget(EMPTY, async (url) => {
      await query(
        asSuperuser(url),
        `alter default privileges for role postgres in schema public
           grant all on tables to postgres, anon, authenticated, service_role;
         alter default privileges for role postgres in schema public
           grant all on sequences to postgres, anon, authenticated, service_role;
         alter default privileges for role postgres in schema public
           grant all on functions to postgres, anon, authenticated, service_role;
         alter default privileges for role supabase_admin in schema public
           grant all on tables to postgres, anon, authenticated, service_role;
         alter default privileges for role supabase_admin in schema public
           grant all on sequences to postgres, anon, authenticated, service_role;
         alter default privileges for role supabase_admin in schema public
           grant all on functions to postgres, anon, authenticated, service_role;
         alter default privileges for role supabase_auth_admin in schema public
           grant all on tables to postgres, anon;`
      )
      const outcome = await plan(url, model)
      expect(errors(outcome)).not.toContain("plan.clone-mismatch")
    })
  })

  describe("environment", () => {
    /** Двигун, що рахує копії: збір кроків середовища — окрема копія. */
    function counting(): { engine: SchemaEngine; clones: () => number } {
      let clones = 0
      return {
        engine: {
          ...engine,
          withTargetClone: (o, target, scope, fn) => {
            clones++
            return engine.withTargetClone(o, target, scope, fn)
          },
        },
        clones: () => clones,
      }
    }

    it("carries no environment and runs one proof without global default privileges", async () => {
      const model = await compiled({ [PARTY]: party() })
      await inTarget(EMPTY, async (url) => {
        const { engine: over, clones } = counting()
        const artifact = planned(await plan(url, model, over))
        expect(artifact.environment).toEqual({ defaultPrivileges: [] })
        expect(
          artifact.steps.filter((s) => s.origin === "environment")
        ).toEqual([])
        expect(clones()).toBe(1)
      })
    })

    it("records the role's global default privileges and proves the plan with environment steps", async () => {
      const model = await compiled({ [PARTY]: party() })
      await inTarget(EMPTY, async (url) => {
        await query(
          url,
          `alter default privileges for role postgres grant select on tables to anon with grant option;
           alter default privileges for role postgres revoke all on functions from public`
        )
        const { engine: over, clones } = counting()
        const outcome = await plan(url, model, over)
        const artifact = planned(outcome)
        expect(artifact.environment.defaultPrivileges).toEqual([
          {
            objtype: "f",
            grantee: "postgres",
            privilege: "EXECUTE",
            grantable: false,
          },
          {
            objtype: "r",
            grantee: "anon",
            privilege: "SELECT",
            grantable: true,
          },
          ...[
            "DELETE",
            "INSERT",
            "MAINTAIN",
            "REFERENCES",
            "SELECT",
            "TRIGGER",
            "TRUNCATE",
            "UPDATE",
          ].map((privilege) => ({
            objtype: "r",
            grantee: "postgres",
            privilege,
            grantable: false,
          })),
        ])
        // Збір і доказ — дві копії
        expect(clones()).toBe(2)
        // Кроки середовища — наприкінці, `catalogOnly`, без дозволу й сліду
        const environment = artifact.steps.filter(
          (s) => s.origin === "environment"
        )
        expect(environment.length).toBeGreaterThan(0)
        expect(artifact.steps.slice(-environment.length)).toEqual(environment)
        expect(new Set(environment.map((s) => s.class))).toEqual(
          new Set(["catalogOnly"])
        )
        expect(environment.map((s) => s.sql)).toContain(
          'REVOKE ALL ON TABLE "simetra"."marker" FROM "anon"'
        )
        expect(artifact.requiredPermissions).toEqual([])
        expect(codes(outcome)).not.toContain("apply.lock-footprint-exceeded")
      })
    })

    it("refuses when the copy cannot reproduce the global default privileges", async () => {
      const model = await compiled({ [PARTY]: party() })
      // Копія, у якій уже є чужий глобальний ADP: засів його не знімає, бо
      // торкається лише видів із переліку цілі
      const polluted: SchemaEngine = {
        ...engine,
        withTargetClone: (o, target, scope, fn) =>
          engine.withTargetClone(o, target, scope, async (clone) => {
            await query(
              clone.url,
              "alter default privileges for role postgres grant usage on types to anon"
            )
            return fn(clone)
          }),
      }
      await inTarget(EMPTY, async (url) => {
        await query(
          url,
          "alter default privileges for role postgres revoke all on functions from public"
        )
        const outcome = await plan(url, model, polluted)
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["engine.clone-failed"])
        expect(
          String(
            outcome.diagnostics.find((d) => d.code === "engine.clone-failed")
              ?.params.detail
          )
        ).toMatch(/global default privileges/)
      })
    })

    /**
     * Двигун, чия копія працює від іншої ролі (`COPIER`), як копія на
     * `shadowBase` з іншою роллю адміністрування (R7 плану П3-2b-0). Не
     * суперкористувач стеку: об'єкти системної ролі провайдера межа двигуна не
     * бачить, і доказ відмовив би з іншої причини. `setup` виконується на
     * копії від `COPIER`.
     */
    const otherCopyRole = (setup?: string): SchemaEngine => ({
      ...engine,
      withTargetClone: (o, target, scope, fn) =>
        engine.withTargetClone(o, target, scope, async (clone) => {
          const database = new URL(clone.url).pathname.slice(1)
          await query(
            clone.url,
            `grant create on database "${database}" to ${COPIER}`
          )
          const as = new URL(clone.url)
          as.username = COPIER
          as.password = COPIER_PASSWORD
          const url = as.toString()
          if (setup !== undefined) await query(url, setup)
          return fn({ url })
        }),
    })

    const cloneFailure = (outcome: PlanOutcome): string =>
      String(
        outcome.diagnostics.find((d) => d.code === "engine.clone-failed")
          ?.params.detail
      )

    it("refuses a copy of another role when the target has global default privileges", async () => {
      // Засів для ролі плану не діяв би на об'єкти, які створює роль копії:
      // доказ тихо позеленів би, а на цілі `anon` читав би нові таблиці
      const model = await compiled({ [PARTY]: party() })
      await inTarget(EMPTY, async (url) => {
        await query(
          url,
          "alter default privileges for role postgres grant select on tables to anon"
        )
        const outcome = await plan(url, model, otherCopyRole())
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["engine.clone-failed"])
        expect(cloneFailure(outcome)).toContain(
          `the target's environment cannot be reproduced by another role: objects on the copy are created by ${COPIER}, on the target by postgres`
        )
        expect(cloneFailure(outcome)).toContain(
          "the target has them for postgres"
        )
      })
    })

    it("does not refuse a copy of another role when neither side has global default privileges", async () => {
      // R7 відмовляє лише за глобальних ADP хоч з одного боку. Сам доказ від
      // іншої ролі копії тут і без R7 не сходиться — права власника схем і
      // таблиць іншої ролі двигун бачить як зайві гранти, — тож тест тримає
      // лише те, що засів не додає своєї відмови. Копія під іншою роллю не
      // доводить план, що створює об'єкти: права власника цієї ролі виглядають
      // зайвими грантами (plan.proof-not-empty) — див. «Відомі обмеження» плану
      const model = await compiled({ [PARTY]: party() })
      await inTarget(EMPTY, async (url) => {
        const outcome = await plan(url, model, otherCopyRole())
        expect(errors(outcome)).not.toContain("engine.clone-failed")
      })
    })

    it("refuses a copy whose own role has global default privileges on it", async () => {
      // Власний глобальний ADP ролі копії дав би об'єктам доказу права, яких
      // на цілі не буде
      const model = await compiled({ [PARTY]: party() })
      await inTarget(EMPTY, async (url) => {
        const outcome = await plan(
          url,
          model,
          otherCopyRole(
            `alter default privileges for role ${COPIER} grant select on tables to anon`
          )
        )
        expect(errors(outcome)).toEqual(["engine.clone-failed"])
        expect(cloneFailure(outcome)).toContain(
          `the copy has them for ${COPIER}`
        )
      })
    })

    it("passes on the warnings of the collection copy", async () => {
      const model = await compiled({ [PARTY]: party() })
      const warning = {
        code: "engine.unrepresentable" as const,
        severity: "warning" as const,
        message: "a warning of the collection copy",
        params: {},
      }
      let clones = 0
      // Попередження — лише від першої копії, тобто копії збору
      const warns: SchemaEngine = {
        ...engine,
        withTargetClone: async (o, target, scope, fn) => {
          const outcome = await engine.withTargetClone(o, target, scope, fn)
          clones++
          return clones === 1 && outcome.status === "loaded"
            ? { ...outcome, diagnostics: [...outcome.diagnostics, warning] }
            : outcome
        },
      }
      await inTarget(EMPTY, async (url) => {
        await query(
          url,
          "alter default privileges for role postgres revoke all on functions from public"
        )
        const outcome = await plan(url, model, warns)
        planned(outcome)
        expect(clones).toBe(2)
        expect(outcome.diagnostics).toContainEqual(warning)
      })
    })

    it("refuses a proof copy with a global default privilege the target lacks", async () => {
      // Порожній перелік теж звіряється: копія не має привносити свого
      const model = await compiled({ [PARTY]: party() })
      const polluted: SchemaEngine = {
        ...engine,
        withTargetClone: (o, target, scope, fn) =>
          engine.withTargetClone(o, target, scope, async (clone) => {
            await query(
              clone.url,
              "alter default privileges for role postgres grant select on tables to anon"
            )
            return fn(clone)
          }),
      }
      await inTarget(EMPTY, async (url) => {
        const outcome = await plan(url, model, polluted)
        expect(errors(outcome)).toEqual(["engine.clone-failed"])
      })
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
        await query(url, "alter table app.party add column extra int")
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
              extract: () =>
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
        await query(url, "create table app.v (id int primary key, j json)")
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
   * Слід кроків (спека промоції §7.2, «З'єднання й блокування», R26 плану
   * П3-2a) на плані без промоції: `app.c.pc → app.p.code`. Замок кожного кроку FK береться наперед у
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
            rehearsal: await rehearsalOf(to, artifact),
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

    it("warns when the proof takes a lock outside the footprint", async () => {
      // Двигун, що не називає таблиці кроків: слід порожній, а доказ бере
      // замок посеред кроків — звірка сліду каже це попередженням плану
      const unnamed: SchemaEngine = {
        ...engine,
        withDesiredShadow: (o, sql, scope, fn) =>
          engine.withDesiredShadow(o, sql, scope, (db, enginePlan) =>
            fn(db, {
              ...enginePlan,
              actions: enginePlan.actions.map((a) => ({
                ...a,
                lockedTables: [],
              })),
            })
          ),
      }
      const from = await tables({ fk: false })
      const to = await tables({ fk: false, code: 20 })
      const outcome = await inTarget(EMPTY, async (url) => {
        await establish(url, from)
        return plan(url, to, unnamed)
      })
      const artifact = planned(outcome)
      expect(artifact.locks).toEqual([])
      expect(
        outcome.diagnostics
          .filter((d) => d.code === "apply.lock-footprint-exceeded")
          .map((d) => d.severity)
      ).toEqual(["warning"])
    })

    it.each([
      ["with", "", "lockable"],
      ["without", `ALTER TABLE ext.r OWNER TO ${STRANGER}`, "implicit"],
    ])(
      "locks a referencing table outside the managed schemas %s a lock right on a type change",
      async (_, owner, expected) => {
        // `ext.r` поза межею двигуна посилається на `app.p.code`: моделі
        // каталогу її не бачать, а зміна типу колонки перебудовує її FK
        const from = await tables({ fk: false })
        const to = await tables({ fk: false, code: 20 })
        await inTarget(EMPTY, async (url) => {
          await establish(url, from)
          await query(
            url,
            `create schema ext;
             create table ext.r (id int primary key,
               p_code varchar(10) references app.p (code));`
          )
          if (owner !== "") await query(asSuperuser(url), owner)
          const outcome = await plan(url, to)
          const artifact = planned(outcome)
          const [retype] = stepMatching(artifact, /ALTER COLUMN "code" TYPE/)
          // FK поза межею — в артефакті: раннер звіряє його до блокувань
          expect(artifact.foreignKeys).toEqual({
            subjects: [{ schema: "app", name: "p" }],
            live: [
              {
                schema: "ext",
                table: "r",
                columns: ["p_code"],
                references: { schema: "app", table: "p", columns: ["code"] },
              },
            ],
          })
          const r = { schema: "ext", name: "r", mode: "accessExclusive" }
          if (expected === "lockable") {
            expect(artifact.locks).toContainEqual(r)
            expect(artifact.implicitLocks).toEqual([])
          } else {
            expect(artifact.locks.filter((l) => l.schema === "ext")).toEqual([])
            expect(artifact.implicitLocks).toEqual([{ ...r, step: retype!.id }])
          }
          expect(
            outcome.diagnostics
              .filter((d) => d.code === "plan.foreign-exclusive-lock")
              .map((d) => d.params)
          ).toEqual([{ table: "ext.r", step: retype!.id }])
          // Репетиція на цілі, де `ext.r` справді є: замок не поза слідом
          const rehearsal = await executePlan(writer, { url }, artifact, {
            mode: "rehearse",
            rehearsal: await rehearsalOf(to, artifact),
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

  describe("provider locks", () => {
    // Провайдер (supautils) бере ACCESS EXCLUSIVE на таблицях свого переліку
    // для операторів політик і зняття тригера ролі з переліку (R27)
    const POLICY =
      "CREATE POLICY party_read ON app.party FOR SELECT TO authenticated USING (true);"
    const TOUCH = `CREATE FUNCTION app.party_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`
    const TRIGGER = `${TOUCH}
CREATE TRIGGER party_touch BEFORE UPDATE ON app.party FOR EACH ROW EXECUTE FUNCTION app.party_touch();`
    const SERVICES = "Auth, Storage, Realtime"

    const withSql = (sql: string | undefined) =>
      compiled({
        [PARTY]: party(),
        ...(sql === undefined ? {} : { "sql/app/unit.sql": sql }),
      })

    /** Наявні таблиці переліку налаштування для ролі сесії на цілі. */
    const listed = (url: string, setting: string) =>
      query<{ schema: string; name: string }>(
        url,
        `select n.nspname as schema, c.relname as name
           from pg_catalog.json_array_elements_text(
             pg_catalog.current_setting('${setting}')::json -> current_user::text) x(name)
           join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass(x.name)
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p')`
      ).then((rows) =>
        rows.sort(
          (a, b) =>
            (a.schema < b.schema ? -1 : a.schema > b.schema ? 1 : 0) ||
            (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        )
      )

    const lockParams = (outcome: PlanOutcome) =>
      outcome.diagnostics
        .filter((d) => d.code === "plan.foreign-exclusive-lock")
        .map((d) => d.params)

    async function rehearse(
      url: string,
      artifact: PlanArtifact,
      model: CompiledModel
    ) {
      return executePlan(writer, { url }, artifact, {
        mode: "rehearse",
        rehearsal: await rehearsalOf(model, artifact),
        planHash: artifact.planHash,
        allow: artifact.requiredPermissions,
        snapshot: canonicalSnapshot(model),
      })
    }

    // Тригерна функція, що лишається без тригера, сліпа для `plpgsql_check`
    const UNTRIGGERED = ["app.party_touch()"]

    it.each([
      [
        "creates a policy",
        undefined,
        POLICY,
        /^CREATE POLICY/,
        "supautils.policy_grants",
        [],
      ],
      [
        "drops a trigger",
        TRIGGER,
        TOUCH,
        /^DROP TRIGGER/,
        "supautils.drop_trigger_grants",
        UNTRIGGERED,
      ],
    ])(
      "takes the provider tables from the target list up front when the plan %s",
      async (_, before, after, pattern, setting, blind) => {
        const from = await withSql(before)
        const to = await withSql(after)
        await inTarget(EMPTY, async (url) => {
          await establish(url, from)
          const outcome = await plan(url, to)
          const artifact = planned(outcome)
          const [step] = stepMatching(artifact, pattern)
          const tables = await listed(url, setting)
          expect(tables).toContainEqual({ schema: "auth", name: "users" })
          // Перелік — з цілі, під хешем плану
          expect(
            artifact.providerLocks.find((s) => s.setting === setting)?.tables
          ).toEqual(tables)
          const taken = [
            ...artifact.locks,
            ...artifact.implicitLocks.map((l) => ({
              schema: l.schema,
              name: l.name,
              mode: l.mode,
            })),
          ]
          for (const t of tables)
            expect(taken).toContainEqual({ ...t, mode: "accessExclusive" })
          // Одне попередження на крок з переліком таблиць і службами
          expect(lockParams(outcome)).toEqual([
            {
              table: tables.map((t) => `${t.schema}.${t.name}`).join(", "),
              step: step!.id,
              services: SERVICES,
            },
          ])
          // Доказ на копії й репетиція на цілі: замків поза слідом немає
          expect(codes(outcome)).not.toContain("apply.lock-footprint-exceeded")
          const rehearsal = await rehearse(url, artifact, to)
          expect(rehearsal.status).toBe("rolledBack")
          expect(rehearsal.diagnostics).toEqual(blindDiagnostics(blind))
        })
      }
    )

    it("takes no provider tables when the plan creates a trigger", async () => {
      const from = await withSql(TOUCH)
      const to = await withSql(TRIGGER)
      await inTarget(EMPTY, async (url) => {
        await establish(url, from, UNTRIGGERED)
        const outcome = await plan(url, to)
        const artifact = planned(outcome)
        expect(stepMatching(artifact, /^CREATE TRIGGER/)).toHaveLength(1)
        const provider = ["auth", "storage", "realtime"]
        expect(
          [...artifact.locks, ...artifact.implicitLocks].filter((l) =>
            provider.includes(l.schema)
          )
        ).toEqual([])
        expect(lockParams(outcome)).toEqual([])
        expect(await rehearse(url, artifact, to)).toMatchObject({
          status: "rolledBack",
          diagnostics: [],
        })
      })
    })
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
        /** Двигун лише для плану промоції; стан «до» ставить справжній. */
        engine?: SchemaEngine
        /** Читач цілі лише для плану промоції. */
        reader?: ApplyDatabase
      } = {}
    ): Promise<PlanOutcome> {
      return inTarget(EMPTY, async (url) => {
        await establish(url, p.before)
        if (o.drift !== undefined)
          await query(o.superuser === true ? asSuperuser(url) : url, o.drift)
        return buildPlan(
          o.engine ?? engine,
          { ...dbs, reader: o.reader ?? dbs.reader },
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
        "ALTER TABLE app.counterparty RENAME CONSTRAINT counterparties_inn_key TO counterparty_tax_id_key",
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
          table: counterparty,
          from: "counterparties_inn_key",
          to: "counterparty_tax_id_key",
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
      // `access:app.counterparty` — згенерований грант читання таблиці виду
      expect(section.permissionItems.map((i) => i.token)).toEqual([
        "access:app.counterparty",
        "access:app.counterparty_contacts",
        "remove:app.counterparty",
      ])
      expect(artifact.requiredPermissions.slice(0, 3)).toEqual([
        "access:app.counterparty",
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
      // Межі 2a немає: план промоції не попереджає про відмову `COMMIT`
      expect(
        outcome.diagnostics
          .filter((d) => d.severity === "warning")
          .map((d) => d.code)
      ).toEqual(["plan.schema-only-proof"])
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
      // Тінь вантажить тіла без перевірки, і крок функції під преамбулою
      // двигуна теж: тіло читає колонку за старим ім'ям, і доказ на копії
      // падає на ревалідації тіл (рішення 3 плану П3-2b-1)
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
      expect(params(outcome, "apply.function-check-failed")).toEqual([
        {
          count: 1,
          functions: expect.stringMatching(/^app\.party_inns\(\): 42703 /),
        },
      ])
    })

    describe("reserved temporary names", () => {
      // Рішення 11 плану П3-2b-1: намір перейменовує через simetra_tmp_<n> і
      // simetra_retired_<n>, тож зайняте таке ім'я — відмова плану, а не
      // сирий 42701/42P07 кроку наміру на копії
      it.each([
        [
          "a column of a unit table",
          `alter table ${OLD} add column simetra_tmp_1 int`,
          "column app.counterparties.simetra_tmp_1",
        ],
        // Саме це ім'я намір дає вилученій колонці created_at: без перевірки
        // крок наміру на копії впав би з 42701
        [
          "a column holding the very name the intent needs",
          `alter table ${OLD} add column simetra_retired_1 int`,
          "column app.counterparties.simetra_retired_1",
        ],
        [
          "a neighbour table in the unit schema",
          "create table app.simetra_tmp_1 (id int)",
          "relation app.simetra_tmp_1",
        ],
        [
          "a type in the unit schema",
          "create type app.simetra_retired_2 as enum ('a')",
          "type app.simetra_retired_2",
        ],
        [
          "a constraint of a unit table",
          `alter table ${OLD} add constraint simetra_tmp_3 check (true)`,
          "constraint app.counterparties.simetra_tmp_3",
        ],
      ])("refuses %s named like a temporary name", async (_, drift, name) => {
        const outcome = await planPromotion(await promoted(), { drift })
        expect(outcome.status).toBe("refused")
        const [taken] = params(outcome, "plan.temp-name-taken")
        expect(String(taken?.names).split(", ")).toContain(name)
        expect(codes(outcome)).not.toContain("apply.step-failed")
      })
    })

    it("refuses a promotion on a target without plpgsql_check", async () => {
      const outcome = await planPromotion(await promoted(), {
        reader: readerWithoutPlpgsqlCheck,
      })
      expect(outcome.status).toBe("refused")
      expect(
        outcome.diagnostics.filter(
          (d) => d.code === "plan.plpgsql-check-unavailable"
        )
      ).toMatchObject([{ severity: "error", params: { on: "target" } }])
    })

    it("plans a promotion with plpgsql_check and the blind warning", async () => {
      const outcome = await planPromotion(await promoted(), {
        drift: BLIND_SETUP,
        superuser: true,
      })
      expect(planned(outcome).plpgsqlCheck).toBe("transient")
      expect(outcome).toMatchObject({
        expectedBlindFunctions: SUPABASE_EXPECTED_BLIND_FUNCTIONS.length,
      })
      expect(params(outcome, "apply.function-check-blind")).toEqual([
        { count: 2, functions: "other.fh(), pgbouncer.other_auth(text)" },
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

    it("collects environment steps after the intent and engine steps of a promotion", async () => {
      // Рішення 5 плану П3-2b-0: копія збору проходить і кроки наміру, тож
      // залишок двигуна — у нових іменах, а доказ засіяний тим самим переліком
      const p = await promoted()
      const outcome = await planPromotion(p, {
        drift:
          "alter default privileges for role postgres grant select on tables to anon",
      })
      const artifact = planned(outcome)
      expect(
        artifact.environment.defaultPrivileges.filter(
          (d) => d.grantee === "anon"
        )
      ).toEqual([
        {
          objtype: "r",
          grantee: "anon",
          privilege: "SELECT",
          grantable: false,
        },
      ])
      const origins = artifact.steps.map((s) => s.origin)
      // Походження йдуть блоками: намір, двигун, середовище
      expect(origins).toEqual(
        [...origins].sort(
          (a, b) =>
            ["intent", "engine", "environment"].indexOf(a) -
            ["intent", "engine", "environment"].indexOf(b)
        )
      )
      expect(artifact.steps.map((s) => s.id)).toEqual(
        artifact.steps.map((_, i) => `s${i + 1}`)
      )
      // Класу конверсії біля кроку середовища немає
      const environment = new Set(
        artifact.steps
          .filter((s) => s.origin === "environment")
          .map((s) => s.id)
      )
      expect(
        artifact.promotion!.conversions.filter((c) => environment.has(c.step))
      ).toEqual([])
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

    it("refuses an engine step that drops a renamed column", async () => {
      // Двигун, що бачить інший стан, ніж оголошено: після наміру він ще й
      // знімає перейменовану колонку — її дані пропали б мовчки
      const dropsRenamed: SchemaEngine = {
        ...engine,
        plan: (from, to, scope, o) => {
          const enginePlan = engine.plan(from, to, scope, o)
          const retired = enginePlan.actions.find((a) =>
            /DROP COLUMN "simetra_retired_1"/.test(a.sql)
          )
          if (retired === undefined) return enginePlan
          const renamed = (text: string) =>
            text.replace("simetra_retired_1", "tax_id")
          return {
            ...enginePlan,
            actions: [
              ...enginePlan.actions,
              {
                ...retired,
                sql: renamed(retired.sql),
                destroys: retired.destroys.map(renamed),
                destroyed: retired.destroyed.map((d) =>
                  d.kind === "column" ? { ...d, name: "tax_id" } : d
                ),
              },
            ],
          }
        },
      }
      const outcome = await planPromotion(await promoted(), {
        engine: dropsRenamed,
      })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.rename-not-realized"])
      expect(params(outcome, "plan.rename-not-realized")).toEqual([
        { objects: "app.counterparty.tax_id" },
      ])
    })

    it("keeps a same-name redefinition of an adopted index a relaxation", async () => {
      // Прийнятий частковий унікальний індекс у бажаному стані стає повним
      // під тим самим ім'ям: для прийнятого об'єкта це не заміна, а зняття
      // унікальності з дозволом і класом із запису (рішення 3)
      const INDEX = "counterparties_inn_active"
      const files = contactsProject()
      const party = JSON.parse(files.get(COUNTERPARTY_FILE)!) as Json
      party.indexes = [
        {
          name: INDEX,
          unique: true,
          keys: [{ column: "inn" }],
          where: "(inn IS NOT NULL)",
        },
      ]
      files.set(COUNTERPARTY_FILE, JSON.stringify(party))
      const mapping = contactsMapping()
      mapping.conversions[`Counterparty#indexes/${INDEX}`] = "rowRule"
      const p = await promoted(files, mapping)
      // Вид такого індексу не описує, тож повний індекс додає бажаній тіні
      // обгортка двигуна
      const fullIndex: SchemaEngine = {
        ...engine,
        withDesiredShadow: (o, sql, scope, fn) =>
          engine.withDesiredShadow(
            o,
            `${sql}\nCREATE UNIQUE INDEX ${INDEX} ON app.counterparty (tax_id);`,
            scope,
            fn
          ),
      }
      const outcome = await planPromotion(p, { engine: fullIndex })
      const artifact = planned(outcome)
      const [drop] = stepMatching(artifact, new RegExp(`DROP INDEX .*${INDEX}`))
      expect(
        stepMatching(artifact, new RegExp(`CREATE UNIQUE INDEX ${INDEX}`))
      ).toHaveLength(1)
      expect(drop?.class).toBe("relaxation")
      expect(artifact.requiredPermissions).toContain(drop!.id)
      expect(artifact.promotion!.conversions).toContainEqual({
        step: drop!.id,
        class: "rowRule",
      })
    })

    describe("class platform (decision 7, R9)", () => {
      const INDEX = "counterparties_inn_idx"

      /** Прийнятий звичайний індекс (типово `inn`) з класом `platform`. */
      async function platformIndex(
        columns: readonly string[] = ["inn"]
      ): Promise<Promoted> {
        const files = contactsProject()
        const party = JSON.parse(files.get(COUNTERPARTY_FILE)!) as Json
        party.indexes = [
          { name: INDEX, keys: columns.map((column) => ({ column })) },
        ]
        files.set(COUNTERPARTY_FILE, JSON.stringify(party))
        const mapping = contactsMapping()
        mapping.conversions[`Counterparty#indexes/${INDEX}`] = "platform"
        return promoted(files, mapping)
      }

      it("refuses an adopted index of the class platform that the kind does not reproduce", async () => {
        // Вид такого індексу не дає, а `UNIQUE (tax_id)` виду його не покриває:
        // `(inn, id)` не префікс ключа. Клас `platform` без заміни був би
        // тихим зникненням індексу
        const outcome = await planPromotion(await platformIndex(["inn", "id"]))
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.platform-replacement-missing"])
        expect(params(outcome, "plan.platform-replacement-missing")).toEqual([
          {
            objects: `Counterparty#indexes/${INDEX} (index app.counterparties.${INDEX})`,
          },
        ])
      })

      it("plans an adopted index of the class platform that a key of the kind covers", async () => {
        // Рішення 11 плану П3-3a1: простий індекс `(inn)` покриває
        // `UNIQUE (tax_id)` реквізиту — той самий пошук, тож заміна є, а
        // індекс знімає двигун
        const outcome = await planPromotion(await platformIndex())
        const artifact = planned(outcome)
        const drops = stepMatching(
          artifact,
          new RegExp(`DROP INDEX .*${INDEX}`)
        )
        expect(drops).toHaveLength(1)
        expect(artifact.promotion!.conversions).toContainEqual({
          step: drops[0]!.id,
          class: "platform",
        })
      })

      it("plans an adopted index of the class platform that the desired state reproduces", async () => {
        // Еквівалентний індекс на тій самій таблиці бажаної тіні — заміна є;
        // його додає обгортка двигуна, бо вид такого індексу поки не описує
        const reproduced: SchemaEngine = {
          ...engine,
          withDesiredShadow: (o, sql, scope, fn) =>
            engine.withDesiredShadow(
              o,
              `${sql}\nCREATE INDEX counterparty_tax_id_idx ON app.counterparty (tax_id);`,
              scope,
              fn
            ),
        }
        const outcome = await planPromotion(await platformIndex(), {
          engine: reproduced,
        })
        const artifact = planned(outcome)
        expect(artifact.promotion!.canonicalNames).toContainEqual({
          kind: "index",
          table: { schema: "app", name: "counterparty" },
          from: INDEX,
          to: "counterparty_tax_id_idx",
        })
      })
    })

    describe("adopted access equal to the schema ADP (decision 10)", () => {
      // Пара гранту, рівна ADP схеми, на копії не видна, і форма `grant` її не
      // перевіряє. Втрату справжнього доступу показує інше місце плану: запис
      // ролей API — гейт шляху запису (Пр21), читання — рядок політики
      const MODULE = "custom-tables/Counterparty/Counterparty.sql"

      /** Модуль прийнятої таблиці з `sql` і класами його одиниць. */
      function withModule(
        sql: string,
        conversions: Record<string, PromoteInput["conversions"][string]>
      ): Promise<Promoted> {
        const files = contactsProject()
        files.set(MODULE, sql)
        // Одиниці модуля — прийнятий борг, як у фікстури з модулем
        files.set(
          "sql-debt.json",
          `${JSON.stringify({ units: Object.keys(conversions).sort() }, null, 2)}\n`
        )
        const mapping = contactsMapping()
        Object.assign(mapping.conversions, conversions)
        return promoted(files, mapping)
      }

      it("refuses an ADP-equal GRANT ALL to the user role through the write-path gate", async () => {
        // Статичний гейт Пр21 бачить запис у тексті прийнятої одиниці ще в
        // `promote`, незалежно від того, чи рівна вона ADP цілі
        const files = contactsProject()
        files.set(MODULE, `GRANT ALL ON TABLE ${OLD} TO authenticated;\n`)
        const identity =
          "grant:grant:table:app.counterparties:authenticated:all"
        files.set(
          "sql-debt.json",
          `${JSON.stringify({ units: [identity] }, null, 2)}\n`
        )
        const mapping = contactsMapping()
        mapping.conversions[identity] = "platform"
        let n = 950_000
        const result = await promoteObject(files, mapping, {
          schemaPath: (file, schemaFile) => `schemas-of/${file}/${schemaFile}`,
          newId: () => uuid(++n),
        })
        expect(
          result.diagnostics
            .filter((d) => d.severity === "error")
            .map((d) => d.code)
        ).toEqual(["promote.write-path"])

        // Той самий грант на цілі, рівний ADP схеми (витяг його не показує),
        // ловить гейт шляху запису наживо
        const outcome = await planPromotion(await promoted(), {
          drift: `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ALL ON TABLES TO authenticated;
                  GRANT ALL ON ${OLD} TO authenticated`,
        })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.write-path"])
        expect(params(outcome, "plan.write-path")[0]?.detail).toContain(
          "grant INSERT to authenticated on app.counterparties"
        )
      })

      it("refuses an adopted read policy for anon that the kind does not replace", async () => {
        // `anon` читав таблицю грантом з ADP і політикою; вид без `publicRead`
        // гостю нічого не дає — відмова називає політику
        const p = await withModule(
          `CREATE POLICY counterparties_anon ON ${OLD} FOR SELECT TO anon USING (true);\n`,
          { "policy:app.counterparties.counterparties_anon": "platform" }
        )
        const outcome = await planPromotion(p, {
          drift: `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO anon;
                  GRANT SELECT ON ${OLD} TO anon;
                  GRANT SELECT ON app.counterparty_contacts TO anon`,
        })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.platform-replacement-missing"])
        expect(params(outcome, "plan.platform-replacement-missing")).toEqual([
          {
            objects:
              "policy:app.counterparties.counterparties_anon (policy app.counterparties.counterparties_anon)",
          },
        ])
      })

      it("shows the drop of an adopted read policy for public with the class removed", async () => {
        const p = await withModule(
          `CREATE POLICY counterparties_all ON ${OLD} FOR SELECT TO public USING (true);\n`,
          { "policy:app.counterparties.counterparties_all": "removed" }
        )
        const outcome = await planPromotion(p, {
          drift: `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO anon;
                  GRANT SELECT ON ${OLD} TO anon;
                  GRANT SELECT ON app.counterparty_contacts TO anon`,
        })
        const artifact = planned(outcome)
        const drops = stepMatching(artifact, /DROP POLICY .*counterparties_all/)
        expect(drops).toHaveLength(1)
        expect(artifact.requiredPermissions).toContain(drops[0]!.id)
      })
    })

    describe("class property (R10)", () => {
      /** Предмет UNIQUE `inn` фікстури має клас `property` (мапінг-зразок). */
      const SUBJECT = "Counterparty#uniques/counterparties_inn_key"
      const OBJECT = "constraint app.counterparties.counterparties_inn_key"

      it("refuses a deferred unique of the class property that the kind recreates immediate", async () => {
        // Запис, написаний до гейта мутації: ціль має відкладений UNIQUE, а
        // вид дає негайний — клас запису сам нічого не доводить
        const outcome = await planPromotion(await promoted(), {
          drift: `ALTER TABLE ${OLD} DROP CONSTRAINT counterparties_inn_key,
            ADD CONSTRAINT counterparties_inn_key UNIQUE (inn)
              DEFERRABLE INITIALLY DEFERRED`,
        })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.property-not-reproduced"])
        expect(params(outcome, "plan.property-not-reproduced")).toEqual([
          {
            subject: SUBJECT,
            object: OBJECT,
            detail: "deferrable: initiallyDeferred → no",
          },
        ])
      })

      it("refuses a unique of the class property that metadata dropped after promote", async () => {
        // Пізніша зміна метаданих зняла `unique` реквізиту, а запис лишив клас
        const p = await promoted()
        const files = new Map(p.afterFiles)
        const raw = JSON.parse(files.get(CATALOG_FILE)!) as Json
        for (const a of raw.attributes as Json[]) delete a.unique
        files.set(CATALOG_FILE, JSON.stringify(raw))
        const changed = await compile(files)
        expect(
          changed.diagnostics.filter((d) => d.severity === "error")
        ).toEqual([])
        const outcome = await planPromotion({ ...p, after: changed.model! })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.property-not-reproduced"])
        expect(params(outcome, "plan.property-not-reproduced")).toEqual([
          {
            subject: SUBJECT,
            object: OBJECT,
            detail: "no element of this kind on the table in the desired state",
          },
        ])
      })

      it("plans a unique of the class property whose column changes type", async () => {
        // Двигун законно перебудовує залежний UNIQUE при зміні типу колонки
        // (§7.2): умова гейта — еквівалент у тіні, а не відсутність DROP
        const mapping = contactsMapping()
        mapping.columns.inn = {
          to: "attribute",
          collection: "attributes",
          element: { name: "taxId", type: "String", length: 12, unique: true },
        }
        const p = await promoted(contactsProject(), mapping)
        expect(p.record.typeChanges.map((t) => t.column)).toContain("tax_id")
        const artifact = planned(await planPromotion(p))
        expect(
          stepMatching(artifact, /ALTER COLUMN "tax_id" TYPE/)
        ).toHaveLength(1)
      })
    })

    it("refuses a record without a marker when the old table is live", async () => {
      // Рядок 8 через конвеєр: стара таблиця на цілі, а marker немає
      const p = await promoted()
      const outcome = await inTarget(
        `create schema app; create table ${OLD} (id uuid primary key);`,
        (url) => buildPlan(engine, dbs, p.after, { target: { url } }, [p.input])
      )
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.promotion-needs-marker"])
      expect(params(outcome, "plan.promotion-needs-marker")).toEqual([
        {
          objectId: COUNTERPARTY_ID,
          file: p.input.file,
          table: OLD,
        },
      ])
    })

    it("ignores a record the ledger has already applied", async () => {
      // Рядок 5 через конвеєр: хеш запису — у ledger цілі
      const p = await promoted()
      const hash = await promotionRecordHash(p.record)
      const outcome = await inTarget(EMPTY, async (url) => {
        await establish(url, p.after)
        // Застосування з COMMIT у 2a відмовляє, тож рядок пише тест
        await query(
          url,
          `update simetra.ledger set promotion = jsonb_build_object('hash', '${hash}')`
        )
        return buildPlan(engine, dbs, p.after, { target: { url } }, [p.input])
      })
      expect(outcome.status).toBe("unchanged")
      expect(
        outcome.diagnostics
          .filter((d) => d.code.startsWith("plan.promotion-"))
          .map((d) => [d.code, d.severity])
      ).toEqual([["plan.promotion-applied", "warning"]])
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
    })

    describe("promotion data steps", () => {
      // Прийнята таблиця `app.items`: `inactive` виводиться з ужитку й стає
      // позначкою видалення кроком конверсії, `code` і `payload` лишаються
      // реквізитами (рішення 1–5, 12, 13 плану П3-2b-2)
      const ITEM_ID = uuid(7401)
      const ITEM_FILE = "custom-tables/Item/Item.meta.json"
      const CODE_T = "sql/app/code_t.sql"
      const NORM = "sql/app/norm.sql"
      const COLOR = "pg-enums/Color/Color.meta.json"
      const OTHER = "custom-tables/Other/Other.meta.json"
      const DELETION_MARK = {
        target: { to: "standard", name: "deletionMark" },
        expression: "coalesce(inactive, false)",
      } as const

      const item = (extra: Json[] = []) => ({
        id: ITEM_ID,
        kind: "CustomTable",
        name: "Item",
        physicalName: "items",
        kindLabel: "item",
        schema: "app",
        columns: [
          {
            id: uuid(7402),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
          { id: uuid(7403), name: "code", physicalName: "code", type: "Text" },
          {
            id: uuid(7404),
            name: "inactive",
            physicalName: "inactive",
            type: "Boolean",
          },
          {
            id: uuid(7405),
            name: "payload",
            physicalName: "payload",
            type: "Text",
          },
          ...extra,
        ],
        primaryKey: { name: "items_pkey", columns: ["id"] },
        uniques: [{ name: "items_code_key", columns: ["code"] }],
        rowLevelSecurity: "enabled",
      })

      /** Тека з таблицею й SQL-файлами `sql`; борг одиниць прийнято. */
      const itemFiles = (
        o: { sql?: Record<string, string>; extra?: Json[] } = {}
      ): Promise<Map<string, string>> =>
        acceptDebt(
          metaFiles({
            "project.meta.json": project(),
            [ITEM_FILE]: item(o.extra),
            ...o.sql,
          })
        )

      const itemMapping = (
        o: {
          fill?: PromoteInput["fill"]
          attributes?: Json[]
          columns?: Record<string, unknown>
          conversions?: Record<string, string>
        } = {}
      ): PromoteInput =>
        promoteInput.parse({
          target: { name: "Item" },
          into: {
            kind: "Catalog",
            name: "Item",
            data: {
              codeLength: 0,
              descriptionLength: 0,
              ...(o.attributes === undefined
                ? {}
                : { attributes: o.attributes }),
            },
          },
          columns: {
            id: { to: "standard", name: "ref" },
            code: { to: "attribute", element: { name: "code", unique: true } },
            inactive: { to: "retire" },
            payload: { to: "attribute", element: { name: "payload" } },
            ...o.columns,
          },
          fill: o.fill ?? [DELETION_MARK],
          conversions: {
            "Item#uniques/items_code_key": "property",
            ...o.conversions,
          },
        })

      const promotedItems = async (
        o: {
          sql?: Record<string, string>
          extra?: Json[]
          fill?: PromoteInput["fill"]
          attributes?: Json[]
          columns?: Record<string, unknown>
          conversions?: Record<string, string>
        } = {}
      ): Promise<Promoted> => promoted(await itemFiles(o), itemMapping(o))

      /** Відмови `plan.promotion-unsupported` з їхніми причинами. */
      const reasons = (outcome: PlanOutcome) =>
        params(outcome, "plan.promotion-unsupported").map((p) => p.reason)

      it("plans a conversion of a retired column into the deletion mark", async () => {
        // Тригер таблиці — модулем: секція бере перелік із цілі, а промоція
        // знімає його з класом `applicationCode`
        const p = await promotedItems({
          sql: {
            "sql/app/touch.sql":
              "CREATE FUNCTION app.touch() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$;\n",
            "custom-tables/Item/Item.sql":
              "CREATE TRIGGER items_touch BEFORE UPDATE ON app.items FOR EACH ROW EXECUTE FUNCTION app.touch();\n",
          },
          conversions: { "trigger:app.items.items_touch": "applicationCode" },
        })
        expect(p.record.dataSteps.map((s) => [s.column, s.kind])).toEqual([
          ["deletion_mark", "conversion"],
        ])
        const outcome = await planPromotion(p)
        const artifact = planned(outcome)
        const section = artifact.promotion!
        expect(section.data).toEqual([
          {
            temp: "simetra_fill_1",
            before: { schema: "app", table: "items", key: "id" },
            after: { schema: "app", table: "item", key: "id" },
            columns: [
              {
                step: "d1",
                column: "deletion_mark",
                type: "boolean",
                expression: "coalesce(inactive, false)",
                kind: "conversion",
                guard:
                  "SELECT pg_catalog.count(*) AS lost FROM (SELECT (\ncoalesce(inactive, false)\n) AS x FROM app.items) AS s WHERE x IS NOT NULL AND (x::boolean) IS DISTINCT FROM x",
              },
            ],
            triggers: [{ name: "items_touch", enabled: "O" }],
          },
        ])
        // Колонка-ціль з'являється кроком наміру, без NOT NULL і DEFAULT
        expect(
          artifact.steps
            .filter((s) => s.origin === "intent")
            .map((s) => s.sql)
            .filter((sql) => sql.includes("ADD COLUMN"))
        ).toEqual(["ALTER TABLE app.item ADD COLUMN deletion_mark boolean"])
        // Конверсія наявних значень не змінює: пункту `repair:` немає
        expect(
          section.permissionItems.filter((i) => i.token.startsWith("repair:"))
        ).toEqual([])
        // Замір цілі — за виразом
        expect(
          section.preservation[0]!.columns.filter((c) => c.dataStep === "d1")
        ).toEqual([
          {
            before: "((\ncoalesce(inactive, false)\n)::boolean)",
            after: "deletion_mark",
            dataStep: "d1",
          },
        ])
        expect(errors(outcome)).toEqual([])
      })

      /** Модель після промоції з іншими файлами `files` поверх її тек. */
      const recompiled = async (
        p: Promoted,
        files: Record<string, string>
      ): Promise<Promoted> => {
        const afterFiles = await acceptDebt(
          new Map([...p.afterFiles, ...Object.entries(files)])
        )
        const result = await compile(afterFiles)
        expect(
          result.diagnostics.filter((d) => d.severity === "error")
        ).toEqual([])
        return { ...p, afterFiles, after: result.model! }
      }

      /**
       * Реквізит `label` бажаного стану — у типі `type` з одиниці `unit`.
       * Метадані виду доменів і власних типів не несуть (`Raw` промоція
       * відхиляє), тож тип підмінено в зібраній моделі, а одиницю типу
       * поставлено перед таблицями.
       */
      const withTypedLabel = (
        p: Promoted,
        type = "app.code_t",
        unit = "code_t",
        column = "label"
      ): Promoted => {
        const node = p.after.creationOrder.find(
          (n) =>
            (n.type === "unit" && n.identity.includes(unit)) ||
            (n.type === "enumType" && n.name === unit)
        )!
        return {
          ...p,
          after: {
            ...p.after,
            physical: {
              ...p.after.physical,
              tables: p.after.physical.tables.map((t) =>
                t.name !== "item"
                  ? t
                  : {
                      ...t,
                      columns: t.columns.map((c) =>
                        c.name === column ? { ...c, type } : c
                      ),
                    }
              ),
            },
            creationOrder: [
              node,
              ...p.after.creationOrder.filter((n) => n !== node),
            ],
          },
        }
      }

      const LABEL = [{ name: "label", type: "Text" }]
      const fillLabel = (expression: string): PromoteInput["fill"] => [
        DELETION_MARK,
        { target: { to: "attribute", name: "label" }, expression },
      ]

      it("refuses an inherited table", async () => {
        const outcome = await planPromotion(await promotedItems(), {
          drift:
            "create schema other; create table other.items_child () inherits (app.items);",
        })
        expect(outcome.status).toBe("refused")
        expect(reasons(outcome)).toEqual(["dataStepTable"])
        expect(params(outcome, "plan.promotion-unsupported")[0]).toMatchObject({
          step: "d1",
          table: "app.items",
        })
      })

      // Рішення В18: правило `UPDATE` — і `ALSO`, і `INSTEAD` — підмінило б
      // той `UPDATE`, чий лічильник звіряється з обчисленим
      it("refuses a table with an UPDATE rewrite rule", async () => {
        const outcome = await planPromotion(await promotedItems(), {
          drift:
            "create rule items_touch as on update to app.items do also notify items_touch;",
        })
        expect(outcome.status).toBe("refused")
        expect(reasons(outcome)).toEqual(["dataStepTable"])
        expect(params(outcome, "plan.promotion-unsupported")[0]).toMatchObject({
          step: "d1",
          table: "app.items",
          detail: "rule",
        })
      })

      const NORM_SQL = (body: string) =>
        `CREATE FUNCTION app.norm(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT ${body} $fn$;\n`

      it("refuses a model function the plan changes", async () => {
        const p = await promotedItems({
          sql: { [NORM]: NORM_SQL("lower(t)") },
          attributes: LABEL,
          fill: fillLabel("app.norm(code)"),
        })
        const outcome = await planPromotion(
          await recompiled(p, { [NORM]: NORM_SQL("upper(t)") })
        )
        expect(outcome.status).toBe("refused")
        // `CREATE OR REPLACE FUNCTION` — дія `alter`: предмет оператора з
        // дерева — сама функція (вердикт В7)
        expect(params(outcome, "plan.data-step-function-changed")).toEqual([
          {
            step: "d2",
            function: "app.norm",
            detail: "changed",
            by: expect.stringMatching(/^s\d+$/),
          },
        ])
      })

      it("refuses a model function that is not immutable on the target", async () => {
        const p = await promotedItems({
          sql: { [NORM]: NORM_SQL("lower(t)") },
          attributes: LABEL,
          fill: fillLabel("app.norm(code)"),
        })
        const outcome = await planPromotion(p, {
          drift: "alter function app.norm(text) stable;",
        })
        expect(outcome.status).toBe("refused")
        expect(params(outcome, "plan.data-step-volatile")).toEqual([
          { step: "d2", function: "app.norm" },
        ])
      })

      it("refuses without the TEMP privilege", async () => {
        // Власник бази має право окремо, тож лише `PUBLIC` не досить
        const outcome = await planPromotion(await promotedItems(), {
          superuser: true,
          drift: `do $$ begin execute format('revoke temp on database %I from public, postgres', current_database()); end $$;`,
        })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.temp-privilege"])
        expect(params(outcome, "plan.temp-privilege")).toEqual([
          { role: "postgres" },
        ])
      })

      it("refuses a session replication role other than origin", async () => {
        const outcome = await planPromotion(await promotedItems(), {
          superuser: true,
          drift: `do $$ begin execute format('alter database %I set session_replication_role = replica', current_database()); end $$;`,
        })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.replication-role"])
        expect(params(outcome, "plan.replication-role")).toEqual([
          { value: "replica" },
        ])
      })

      it("refuses a key that is a fill target", async () => {
        const p = await promotedItems()
        const record: PromotionRecord = {
          ...p.record,
          dataSteps: [
            ...p.record.dataSteps,
            {
              ...p.record.dataSteps[0]!,
              column: "id",
              expression:
                "coalesce(id, '00000000-0000-4000-8000-000000000000'::uuid)",
              kind: "backfill",
            },
          ],
        }
        const outcome = await planPromotion(p, {
          records: [{ ...p.input, record }],
        })
        expect(outcome.status).toBe("refused")
        expect(reasons(outcome)).toEqual(["dataStepKey", "dataStepKey"])
        expect(
          params(outcome, "plan.promotion-unsupported").map((x) => x.detail)
        ).toEqual(["fillTarget", "fillTarget"])
      })

      it("refuses a record whose data step kind was edited", async () => {
        // Ремонт, переписаний у файлі на конверсію, пройшов би без `repair:`
        const p = await promotedItems({
          fill: [
            DELETION_MARK,
            {
              target: { to: "attribute", name: "code" },
              expression: "btrim(code)",
            },
          ],
        })
        expect(p.record.dataSteps.map((s) => s.kind)).toEqual([
          "conversion",
          "repair",
        ])
        const record: PromotionRecord = {
          ...p.record,
          dataSteps: p.record.dataSteps.map((s) => ({
            ...s,
            kind: "conversion",
          })),
        }
        const outcome = await planPromotion(p, {
          records: [{ ...p.input, record }],
        })
        expect(outcome.status).toBe("refused")
        expect(params(outcome, "plan.promotion-record-mismatch")).toEqual([
          {
            objectId: ITEM_ID,
            file: p.input.file,
            detail: "dataSteps",
            step: "d2",
            reason: "derived repair, recorded conversion",
          },
        ])
      })

      it("asks repair: for a repair of existing values", async () => {
        const p = await promotedItems({
          fill: [
            DELETION_MARK,
            {
              target: { to: "attribute", name: "code" },
              expression: "btrim(code)",
            },
          ],
        })
        const artifact = planned(await planPromotion(p))
        expect(
          artifact.promotion!.permissionItems.filter((i) =>
            i.token.startsWith("repair:")
          )
        ).toEqual([
          { token: "repair:app.item", summary: ["code ← btrim(code)"] },
        ])
        expect(artifact.requiredPermissions).toContain("repair:app.item")
      })

      it("refuses a fill target referenced with ON UPDATE CASCADE", async () => {
        const p = await promotedItems({
          fill: [
            DELETION_MARK,
            {
              target: { to: "attribute", name: "code" },
              expression: "btrim(code)",
            },
          ],
        })
        const outcome = await planPromotion(p, {
          drift:
            "create schema other; create table other.refs (code text references app.items (code) on update cascade);",
        })
        expect(outcome.status).toBe("refused")
        expect(reasons(outcome)).toEqual(["dataStepReferenced"])
        expect(params(outcome, "plan.promotion-unsupported")[0]).toMatchObject({
          step: "d2",
          table: "app.items",
          column: "code",
        })
      })

      it("plans a backfill with now()", async () => {
        // Функції часу транзакції — поза перевіркою IMMUTABLE на цілі
        const p = await promotedItems({
          extra: [
            {
              id: uuid(7406),
              name: "createdAt",
              physicalName: "created_at",
              type: "DateTime",
            },
          ],
          columns: { createdAt: { to: "standard", name: "createdAt" } },
          fill: [
            DELETION_MARK,
            {
              target: { to: "standard", name: "createdAt" },
              expression: "coalesce(created_at, now())",
            },
          ],
        })
        const artifact = planned(await planPromotion(p))
        expect(
          artifact.promotion!.data[0]!.columns.map((c) => [
            c.column,
            c.kind,
            c.type,
          ])
        ).toEqual([
          ["deletion_mark", "conversion", "boolean"],
          ["created_at", "backfill", "timestamp with time zone"],
        ])
      })

      it("proves a windowed fill expression measured in a subquery", async () => {
        // Review focus 1: віконна функція в агрегаті заборонена, тож замір
        // «до» прогону-доказу рахує вираз у підзапиті
        const p = await promotedItems({
          attributes: [{ name: "position", type: "Integer" }],
          fill: [
            DELETION_MARK,
            {
              target: { to: "attribute", name: "position" },
              expression: "row_number() over (order by id)",
            },
          ],
        })
        const artifact = planned(await planPromotion(p))
        expect(
          artifact.promotion!.preservation[0]!.columns.find(
            (c) => c.dataStep === "d2"
          )
        ).toEqual({
          before: "((\nrow_number() over (order by id)\n)::integer)",
          // `position` — ключове слово, тож фізичне ім'я дістає `_`
          after: "position_",
          dataStep: "d2",
        })
      })

      it("takes SHARE ROW EXCLUSIVE for a table only a repair touches", async () => {
        // Вердикт (б): таблиця ТЧ уже має канонічні імена, тож ні намір, ні
        // двигун її не займають — слід дає лише крок даних
        const files = contactsProject()
        const raw = JSON.parse(files.get(CONTACT_FILE)!) as Json
        ;(raw.columns as Json[])[1]!.physicalName = "parent_id"
        ;(raw.foreignKeys as Json[])[0]!.name =
          "counterparty_contacts_parent_id_fkey"
        raw.rowLevelSecurity = "enabled"
        // Індекс ключа власника, який вид і так має, — під своїм іменем
        raw.indexes = [
          {
            name: "counterparty_contacts_parent_id_idx",
            keys: [{ column: "counterpartyId" }],
          },
        ]
        files.set(CONTACT_FILE, JSON.stringify(raw))
        const mapping = contactsMapping()
        mapping.conversions[
          "CounterpartyContact#indexes/counterparty_contacts_parent_id_idx"
        ] = "property"
        mapping.fill = [
          {
            table: "CounterpartyContact",
            target: { to: "attribute", name: "phone" },
            expression: "btrim(phone)",
          },
        ]
        const p = await promoted(files, mapping)
        const contacts = { schema: "app", name: "counterparty_contacts" }
        const artifact = planned(await planPromotion(p))
        const touching = artifact.steps.filter((s) =>
          s.lockedTables.some((t) => t.name === contacts.name)
        )
        // Гранти доступу таблиці виду — кроки двигуна без замка таблиці:
        // слід замків вони не змінюють
        expect(touching.map((s) => [s.origin, s.lockClass, s.sql])).toEqual([
          [
            "engine",
            "none",
            'REVOKE ALL ON TABLE "app"."counterparty_contacts" FROM "authenticated"',
          ],
          [
            "engine",
            "none",
            'GRANT SELECT ON TABLE "app"."counterparty_contacts" TO "authenticated"',
          ],
        ])
        expect(artifact.promotion!.data.map((t) => t.columns[0]!.step)).toEqual(
          ["d1"]
        )
        expect(artifact.locks).toContainEqual({
          ...contacts,
          mode: "shareRowExclusive",
        })
        // Без права на явний LOCK замок бере сам крок — і це крок даних
        const reader: ApplyDatabase = {
          transaction: (target, end, fn) =>
            dbs.reader.transaction(target, end, (tx) =>
              fn({
                ...tx,
                query: async <R extends Record<string, unknown>>(
                  sql: string,
                  params?: readonly unknown[]
                ): Promise<R[]> => {
                  const rows = await tx.query<R>(sql, params)
                  return sql.includes("AS lockable")
                    ? rows.map((r) =>
                        r.name === contacts.name ? { ...r, lockable: false } : r
                      )
                    : rows
                },
              })
            ),
        }
        const implicit = planned(await planPromotion(p, { reader }))
        expect(implicit.implicitLocks).toEqual([
          { ...contacts, mode: "shareRowExclusive", step: "d1" },
        ])
      })

      it("refuses a target type absent on the target before the copy", async () => {
        // Домен створює бажаний стан: без відмови до копії `ADD COLUMN`
        // наміру впав би на ній сирим 42704
        const p = await promotedItems({
          attributes: LABEL,
          fill: fillLabel("code"),
        })
        const desired = withTypedLabel(
          await recompiled(p, {
            [CODE_T]: "CREATE DOMAIN app.code_t AS text;\n",
          })
        )
        let clones = 0
        const outcome = await planPromotion(desired, {
          engine: {
            ...engine,
            withTargetClone: (o, target, scope, fn) => {
              clones++
              return engine.withTargetClone(o, target, scope, fn)
            },
          },
        })
        expect(outcome.status).toBe("refused")
        expect(reasons(outcome)).toEqual(["dataStepType"])
        expect(params(outcome, "plan.promotion-unsupported")[0]).toMatchObject({
          step: "d2",
          type: "app.code_t",
          detail: "missing",
        })
        expect(clones).toBe(0)
      })

      it("refuses a type an engine step changes", async () => {
        const domain = (check: string) =>
          `CREATE DOMAIN app.code_t AS text CONSTRAINT code_t_check CHECK (${check});\n`
        const p = await promotedItems({
          sql: { [CODE_T]: domain("VALUE <> ''") },
          attributes: LABEL,
          fill: fillLabel("code"),
        })
        const desired = withTypedLabel(
          await recompiled(p, { [CODE_T]: domain("length(VALUE) < 100") })
        )
        const outcome = await planPromotion(desired)
        expect(outcome.status).toBe("refused")
        expect(reasons(outcome)).toEqual(["dataStepType"])
        expect(params(outcome, "plan.promotion-unsupported")[0]).toMatchObject({
          step: "d2",
          type: "app.code_t",
          detail: "changed",
        })
      })

      it("refuses an enum value an engine step adds", async () => {
        // Вердикт архітектора (8): `ALTER TYPE … ADD VALUE` — предмет оператора
        // — сам енам кроку даних
        // Енам — прийнятий `PgEnum`: SQL-файл енамів не створює
        const enumOf = (values: string[]) =>
          JSON.stringify({
            id: uuid(7601),
            kind: "PgEnum",
            name: "Color",
            physicalName: "color",
            schema: "app",
            values,
          })
        const p = await promotedItems({
          sql: { [COLOR]: enumOf(["red"]) },
          attributes: LABEL,
          fill: fillLabel("'red'"),
        })
        const desired = withTypedLabel(
          await recompiled(p, { [COLOR]: enumOf(["red", "green"]) }),
          "app.color",
          "color"
        )
        const outcome = await planPromotion(desired)
        expect(outcome.status).toBe("refused")
        expect(reasons(outcome)).toEqual(["dataStepType"])
        expect(params(outcome, "plan.promotion-unsupported")[0]).toMatchObject({
          step: "d2",
          type: "app.color",
          detail: "changed",
        })
      })

      it("lets through a type change of another table to the step's domain", async () => {
        // Вердикт В7: `ALTER TABLE … ALTER COLUMN … TYPE <домен>` — теж `alter`
        // із доменом у `consumed`, але предмет оператора — таблиця
        const DOMAIN = "CREATE DOMAIN app.code_t AS text;\n"
        const other = (column: Json) =>
          JSON.stringify({
            id: uuid(7501),
            kind: "CustomTable",
            name: "Other",
            physicalName: "others",
            kindLabel: "other",
            schema: "app",
            columns: [
              {
                id: uuid(7502),
                name: "id",
                physicalName: "id",
                type: "UUID",
                notNull: true,
              },
              { id: uuid(7503), name: "c", physicalName: "c", ...column },
            ],
            primaryKey: { name: "others_pkey", columns: ["id"] },
            rowLevelSecurity: "enabled",
          })
        const p = await promotedItems({
          sql: { [CODE_T]: DOMAIN, [OTHER]: other({ type: "Text" }) },
          attributes: LABEL,
          fill: fillLabel("code"),
        })
        const desired = withTypedLabel(
          await recompiled(p, {
            [OTHER]: other({ type: "Raw", pgType: "app.code_t" }),
          })
        )
        const outcome = await planPromotion(desired)
        const artifact = planned(outcome)
        expect(
          stepMatching(artifact, /ALTER COLUMN "c" TYPE/).map((s) => s.verb)
        ).toEqual(["alter"])
        expect(artifact.promotion!.data[0]!.columns[1]!.type).toBe("app.code_t")
      })

      it("refuses a preservation type the same plan creates", async () => {
        // Вердикт (в): замір «до» приводить `code` до нового типу до будь-якого
        // кроку, а домен створює сам план — відмова плану, а не сирий 42704
        // заміру на застосуванні
        const p = await promotedItems()
        const desired = withTypedLabel(
          await recompiled(p, {
            [CODE_T]: "CREATE DOMAIN app.code_t AS text;\n",
          }),
          "app.code_t",
          "code_t",
          "code"
        )
        const record: PromotionRecord = {
          ...p.record,
          typeChanges: [
            {
              schema: "app",
              table: "item",
              column: "code",
              from: "text",
              to: "app.code_t",
            },
          ],
        }
        let clones = 0
        const outcome = await planPromotion(desired, {
          records: [{ ...p.input, record }],
          engine: {
            ...engine,
            withTargetClone: (o, target, scope, fn) => {
              clones++
              return engine.withTargetClone(o, target, scope, fn)
            },
          },
        })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.preservation-type"])
        expect(params(outcome, "plan.preservation-type")).toEqual([
          { column: "app.item.code", type: "app.code_t", detail: "missing" },
        ])
        expect(clones).toBe(0)
      })

      it("picks the text form of the cast guard when no operator exists", async () => {
        const guardOf = async (expression: string) => {
          const p = await promotedItems({
            attributes: [{ name: "data", type: "Json" }],
            fill: [
              DELETION_MARK,
              { target: { to: "attribute", name: "data" }, expression },
            ],
          })
          const artifact = planned(await planPromotion(p))
          return artifact.promotion!.data[0]!.columns[1]!
        }
        // `jsonb = text` немає: сторож порівнює текст
        const text = await guardOf("payload")
        expect(text.type).toBe("jsonb")
        expect(text.guard).toBe(
          "SELECT pg_catalog.count(*) AS lost FROM (SELECT (\npayload\n) AS x FROM app.items) AS s WHERE x IS NOT NULL AND (x::jsonb)::pg_catalog.text IS DISTINCT FROM x::pg_catalog.text"
        )
        // Явна конверсія: `jsonb` з `jsonb`
        const compare = await guardOf("payload::jsonb")
        expect(compare.guard).toBe(
          "SELECT pg_catalog.count(*) AS lost FROM (SELECT (\npayload::jsonb\n) AS x FROM app.items) AS s WHERE x IS NOT NULL AND (x::jsonb) IS DISTINCT FROM x"
        )
      })

      it("reads the data facts of the target", async () => {
        // Тригери користувача `O` і `A` за іменем, без вимкнених і внутрішніх
        // тригерів FK; партиціонована таблиця; вхідний FK із каскадом
        // оновлення на змаплену ціль; типи й функції в старому стані
        await inTarget(
          `create schema app;
           create table app.items (id uuid primary key, code text unique, n int);
           create function app.touch() returns trigger language plpgsql as $$ begin return new; end $$;
           create trigger b_touch before update on app.items for each row execute function app.touch();
           create trigger a_audit after update on app.items for each row execute function app.touch();
           alter table app.items enable always trigger a_audit;
           create trigger c_off after update on app.items for each row execute function app.touch();
           alter table app.items disable trigger c_off;
           create table app.refs (code text references app.items (code) on update cascade, item uuid references app.items (id));
           create table app.parted (id uuid, k int) partition by range (k);
           create function app.norm(t text) returns text language sql immutable as $$ select lower(t) $$;`,
          async (url) => {
            const parse = await loadSqlParser()
            const column = (
              step: string,
              name: string,
              type: string,
              expression: string
            ) => ({
              step,
              column: name,
              type,
              expression,
              kind: "split" as const,
              guard: "",
            })
            const tables: PlannedDataTable[] = [
              {
                temp: "simetra_fill_1",
                before: { schema: "app", table: "items", key: "id" },
                after: { schema: "app", table: "item", key: "id" },
                columns: [
                  column("d1", "code", "text", "app.norm(code)"),
                  column("d2", "len", "integer", "pg_catalog.length(code)"),
                ],
              },
              {
                temp: "simetra_fill_2",
                before: { schema: "app", table: "parted", key: "id" },
                after: { schema: "app", table: "parted", key: "id" },
                columns: [column("d3", "k2", "public.missing_t", "random()")],
              },
            ]
            const facts = await dbs.reader.transaction(
              { url },
              "rollback",
              (tx) =>
                readDataFacts(tx, tables, parse, new Map([["d1", "code"]]))
            )
            expect(facts.triggers.get(tableKey("app", "items"))).toEqual([
              { name: "a_audit", enabled: "A" },
              { name: "b_touch", enabled: "O" },
            ])
            expect(facts.inherited).toEqual([tableKey("app", "parted")])
            expect(facts.cascading).toEqual(["d1"])
            expect(facts.types).toEqual(
              new Map([
                ["text", "found"],
                ["integer", "found"],
                ["public.missing_t", "missing"],
              ])
            )
            expect(facts.functions).toEqual([
              {
                step: "d1",
                schema: "app",
                name: "norm",
                immutable: true,
                exists: true,
              },
              // Перевантаження `length(bytea, name)` — STABLE: функція
              // доведена лише тоді, коли IMMUTABLE кожне
              {
                step: "d2",
                schema: "pg_catalog",
                name: "length",
                immutable: false,
                exists: true,
              },
              { step: "d3", name: "random", immutable: false, exists: true },
            ])
            expect(facts.tempPrivilege).toBe(true)
            expect(facts.replicationRole).toBe("origin")
          }
        )
      })

      it("keeps a user type qualified in the snapshot and in typeChanges", async () => {
        // Рішення В5: адаптер читає типи під `search_path = pg_catalog`, тож
        // домен `public`, хоч `public` і в шляху сесії, приходить
        // кваліфікованим — і в колонці, і в зміні типу запису
        await inTarget(
          `create schema app;
           create domain public.code_t as text;
           create table app.t (id uuid primary key, c public.code_t);`,
          async (url) => {
            const extracted = await engine.extract({ url }, targetScope)
            expect(
              extracted.model.tables
                .find((t) => t.name === "t")!
                .columns.find((c) => c.name === "c")!.type
            ).toBe("public.code_t")
            const reversed = await reverseGenerate(extracted.model, {
              project: {
                name: "Adopted",
                defaultSchema: "app",
                attributeCase: "camelCase",
                databaseProvider: "supabase",
              },
              existing: new Map(),
              newId: () => randomUUID(),
              schemaPath: (_file, schemaFile) => `schemas/${schemaFile}`,
              parse: await loadSqlParser(),
            })
            const result = await compile(await acceptDebt(reversed.files))
            expect(
              result.diagnostics.filter((d) => d.severity === "error")
            ).toEqual([])
            const before = result.model!.physical
            const t = before.tables.find((x) => x.name === "t")!
            expect(t.columns.find((c) => c.name === "c")!.type).toBe(
              "public.code_t"
            )
            const derived = derivePromotionFacts(
              before,
              {
                physical: {
                  tables: [
                    {
                      ...t,
                      columns: t.columns.map((c) =>
                        c.name === "c" ? { ...c, type: "text" } : c
                      ),
                    },
                  ],
                },
                attributeCase: "camelCase",
              },
              {
                objectId: t.origin.objectId,
                tables: [t.origin.objectId],
                columns: t.columns.map((c) => ({
                  sourceId: c.origin.elementId!,
                  successorId: c.origin.elementId!,
                })),
              }
            )
            expect(derived.ok && derived.facts.typeChanges).toEqual([
              {
                schema: "app",
                table: "t",
                column: "c",
                from: "public.code_t",
                to: "text",
              },
            ])
          }
        )
      })

      it("reads desiredInvalid from the shadow in a promotion", async () => {
        // Борг 2b-1: гілка промоції читає недійсні об'єкти з бажаної тіні
        const p = await promoted()
        const outcome = await inTarget(EMPTY, async (url) => {
          await establish(url, p.before)
          const reader: ApplyDatabase = {
            transaction: (target, end, fn) =>
              dbs.reader.transaction(target, end, (tx) =>
                fn({
                  ...tx,
                  query: async <R extends Record<string, unknown>>(
                    sql: string,
                    params?: readonly unknown[]
                  ): Promise<R[]> =>
                    // Запит недійсних об'єктів, а не об'єктів еквівалентності
                    target.url !== url && sql.includes("domain constraint")
                      ? ([{ object: "constraint app.x x_a" }] as unknown as R[])
                      : tx.query<R>(sql, params),
                })
              ),
          }
          return buildPlan(
            engine,
            { ...dbs, reader },
            p.after,
            { target: { url } },
            [p.input]
          )
        })
        expect(planned(outcome).desiredInvalid).toEqual([
          "constraint app.x x_a",
        ])
      })
    })
  })
})
