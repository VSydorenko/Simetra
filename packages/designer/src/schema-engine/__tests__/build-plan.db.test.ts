import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { compile, loadSqlParser } from "simetra/compiler"
import {
  buildPlan,
  reverseGenerate,
  serializePlan,
  SUPABASE_EXPECTED_BLIND_FUNCTIONS,
  type ApplyDatabase,
  type EngineAction,
  type SchemaEngine,
} from "simetra/schema"
import {
  acceptDebt,
  attribute,
  customTable,
  project,
  uuid,
} from "../../../../simetra/test/support"
import { asSuperuser, query } from "../../__tests__/support/db"
import {
  BLIND_SETUP,
  codes,
  compiled,
  dbs,
  EMPTY,
  engine,
  errors,
  establish,
  inTarget,
  OWNER,
  party,
  PARTY,
  plan,
  planned,
  readerWithoutPlpgsqlCheck,
  SERVICE_ROLE,
  stepMatching,
  STRANGER,
  targetScope,
  useBuildPlanRoles,
} from "./build-plan.support"

/**
 * Конвеєр плану `buildPlan` на справжній базі — гейт дрейфу, план від живої цілі, класи, лінт і доказ на копії. Спільна
 * підготовка — `build-plan.support.ts`; конвеєр розділено на файли, щоб шарди
 * DB-джоби CI були рівними (один файл займав понад половину джоби).
 */

useBuildPlanRoles()

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

  it("warns that the numbering of a new catalog is not generated", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      const outcome = await plan(url, model)
      planned(outcome)
      expect(
        outcome.diagnostics.filter(
          (d) => d.code === "plan.numbering-not-generated"
        )
      ).toEqual([
        expect.objectContaining({
          severity: "warning",
          params: { object: "Party", table: "app.party" },
        }),
      ])
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
