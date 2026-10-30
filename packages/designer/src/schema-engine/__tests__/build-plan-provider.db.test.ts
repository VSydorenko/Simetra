import { describe, expect, it } from "vitest"
import { canonicalSnapshot, type CompiledModel } from "simetra/compiler"
import {
  ApplyConnectionLost,
  buildPlan,
  checkGuardCasts,
  executePlan,
  renderDesiredState,
  type ApplyDatabase,
  type EngineAction,
  type PlanArtifact,
  type PlanOutcome,
  type SchemaEngine,
} from "simetra/schema"
import {
  attribute,
  catalog,
  customTable,
  uuid,
} from "../../../../simetra/test/support"
import { asSuperuser, query } from "../../__tests__/support/db"
import {
  blindDiagnostics,
  codes,
  compiled,
  COPIER,
  COPIER_PASSWORD,
  dbs,
  EMPTY,
  engine,
  errors,
  establish,
  inTarget,
  party,
  PARTY,
  plan,
  planned,
  rehearsalOf,
  stepMatching,
  STRANGER,
  useBuildPlanRoles,
  writer,
} from "./build-plan.support"

/**
 * Конвеєр плану `buildPlan` на справжній базі — тригери провайдера, середовище, зміна типу й блокування. Спільна
 * підготовка — `build-plan.support.ts`; конвеєр розділено на файли, щоб шарди
 * DB-джоби CI були рівними (один файл займав понад половину джоби).
 */

useBuildPlanRoles()

/**
 * Прийнята таблиця `app.notes` з рядковою колонкою `note`. Дослівні тригер і
 * політика — лише на `CustomTable`, як прийнятий борг (спека прав §6.1): на таблиці
 * виду це помилка `sql.kind-table-verbatim`. Тести, чий предмет — дослівний
 * тригер чи політика, ставлять їх сюди.
 */
const NOTES = "custom-tables/Notes/Notes.meta.json"
const notes = (
  type: Record<string, unknown> = { type: "String", length: 20 }
) =>
  customTable("Notes", {
    id: uuid(9201),
    physicalName: "notes",
    columns: [
      {
        id: uuid(9202),
        name: "id",
        physicalName: "id",
        type: "UUID",
        notNull: true,
      },
      { id: uuid(9203), name: "note", physicalName: "note", ...type },
    ],
    primaryKey: { name: "notes_pkey", columns: ["id"] },
  })

// Конкурентно: ціль і копії кожного тесту — власні бази, ролі створює лише
// `beforeAll`, а лічильники двигунів-шпигунів — локальні для тесту
describe.concurrent("buildPlan", () => {
  // Згенерований тригер на таблиці провайдера, ім'я якого вже займає чужий
  // тригер (спека промоції §9.2): гейт дрейфу таблиці провайдера не
  // бачить, тож без відмови крок двигуна замінив би чужий тригер мовчки
  describe("provider table triggers", () => {
    const USERS = "catalogs/Users/Users.meta.json"
    const users = catalog("Users", {
      id: uuid(9101),
      role: "users",
      scope: "none",
    })
    /** Тригер провізії платформного шару на `auth.users`. */
    const PROVISION = "simetra_provision_user"

    /** Обробник на таблиці провайдера: роль автентифікації прав на `app` не має. */
    const ON_USER = `CREATE FUNCTION app.on_user() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN NEW;
END $$;`
    const ON_PARTY = `CREATE FUNCTION app.on_party() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
BEGIN
  RETURN NEW;
END $$;`

    const subscription = (n: number, name: string, data: object) => ({
      [`event-subscriptions/${name}/${name}.meta.json`]: {
        id: uuid(n),
        kind: "EventSubscription",
        name,
        ...data,
      },
    })
    const onUser = (physicalName: string) =>
      subscription(9111, "OnUser", {
        physicalName,
        sources: [{ providerTable: "auth.users" }],
        event: "onWrite",
        handler: { schema: "app", name: "on_user" },
      })

    /** Чужа функція тригера в схемі `schema`, поза метаданими. */
    const foreignTrigger = (schema: string, name: string) =>
      `create function ${schema}.foreign_fn() returns trigger language plpgsql
         as $$ begin return new; end $$;
       create trigger ${name} after insert on auth.users
         for each row execute function ${schema}.foreign_fn();`

    const taken = (outcome: PlanOutcome) =>
      outcome.diagnostics
        .filter((d) => d.code === "plan.provider-trigger-taken")
        .map((d) => d.params)

    it("refuses a first apply over a foreign trigger with the name of the provision trigger", async () => {
      const model = await compiled({ [USERS]: users })
      await inTarget(foreignTrigger("public", PROVISION), async (url) => {
        const outcome = await plan(url, model)
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.provider-trigger-taken"])
        expect(taken(outcome)).toEqual([
          { trigger: PROVISION, table: "auth.users" },
        ])
      })
    })

    it("refuses a subscription whose name a foreign trigger took after the last apply", async () => {
      const before = await compiled({ [PARTY]: party() })
      const after = await compiled({
        [PARTY]: party(),
        ...onUser("audit_x"),
        "sql/app/handlers.sql": ON_USER,
      })
      await inTarget(EMPTY, async (url) => {
        await establish(url, before)
        await query(url, foreignTrigger("public", "audit_x"))
        const outcome = await plan(url, after)
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.provider-trigger-taken"])
        expect(taken(outcome)).toEqual([
          { trigger: "audit_x", table: "auth.users" },
        ])
      })
    })

    it("plans a first apply over a trigger equal to the generated one", async () => {
      const model = await compiled({ [USERS]: users })
      // Ціль уже має розгорнутий шар: тригер провізії — той самий текст
      await inTarget(renderDesiredState(model).sql, async (url) => {
        const outcome = await plan(url, model)
        planned(outcome)
        expect(taken(outcome)).toEqual([])
      })
    })

    it("plans a first apply over a generated whenChanged trigger on a varchar column", async () => {
      // `pg_get_triggerdef` друкує умову над `auth.users.email` (`varchar`) з
      // `::text`, генератор — без нього: той самий тригер не «чужий»
      const model = await compiled({
        ...subscription(9111, "OnUser", {
          physicalName: "on_user",
          sources: [{ providerTable: "auth.users" }],
          event: "onWrite",
          whenChanged: ["email"],
          handler: { schema: "app", name: "on_user" },
        }),
        "sql/app/handlers.sql": ON_USER,
      })
      await inTarget(renderDesiredState(model).sql, async (url) => {
        expect(
          await query(
            asSuperuser(url),
            "select pg_get_triggerdef(oid) as def from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'on_user'"
          )
        ).toEqual([
          {
            def: expect.stringContaining(
              "(old.email)::text IS DISTINCT FROM (new.email)::text"
            ),
          },
        ])
        const outcome = await plan(url, model)
        planned(outcome)
        expect(taken(outcome)).toEqual([])
      })
    })

    it("refuses at the desired shadow a foreign trigger whose function is in the provider schema", async () => {
      // Тригер із функцією в схемі провайдера двигун вважає базовим станом
      // провайдера: він засівається в бажану тінь, і згенерований
      // `CREATE TRIGGER` там падає на «already exists». Відмова — двигуна,
      // ще до перевірки імені й копії доказу
      const model = await compiled({ [USERS]: users })
      await inTarget(EMPTY, async (url) => {
        const admin = asSuperuser(url)
        await query(admin, foreignTrigger("auth", PROVISION))
        const state = () =>
          query(
            admin,
            `select
               (select array_agg(pg_get_triggerdef(t.oid) order by t.tgname)
                  from pg_trigger t
                 where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal) as triggers,
               (select array_agg(pg_get_functiondef(p.oid))
                  from pg_proc p
                 where p.pronamespace = 'auth'::regnamespace
                   and p.proname = 'foreign_fn') as functions,
               to_regnamespace('simetra') is not null as layer`
          )
        const before = await state()
        const outcome = await plan(url, model)
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["engine.shadow-load-failed"])
        const [failed] = outcome.diagnostics.filter(
          (d) => d.code === "engine.shadow-load-failed"
        )
        expect(failed?.engineCode).toBe("stuck_statement")
        expect(failed?.message).toContain(
          `CREATE TRIGGER ${PROVISION} AFTER INSERT ON auth.users`
        )
        expect(failed?.message).toContain("already exists")
        // План лише читає ціль: чужий тригер і його функція ті самі, шару
        // платформи не з'явилося
        expect(await state()).toEqual(before)
        expect(before).toEqual([
          {
            // Схему функції `pg_get_*def` друкує лише поза `search_path` сесії
            triggers: [
              expect.stringMatching(
                new RegExp(
                  `^CREATE TRIGGER ${PROVISION} AFTER INSERT ON auth\\.users FOR EACH ROW EXECUTE FUNCTION (auth\\.)?foreign_fn\\(\\)$`
                )
              ),
            ],
            functions: [
              expect.stringMatching(/FUNCTION (auth\.)?foreign_fn\(\)/),
            ],
            layer: false,
          },
        ])
      })
    })

    it("plans nothing after applying subscriptions on a provider table and a catalog", async () => {
      // Живий текст тригера — `pg_get_triggerdef`, бажаний — текст
      // генератора: хибна зміна тригера дала б непорожній другий план
      const model = await compiled({
        [PARTY]: party([
          attribute("price", { id: uuid(9112), type: "Integer" }),
        ]),
        ...onUser("on_user"),
        ...subscription(9113, "OnParty", {
          physicalName: "on_party",
          sources: [{ kind: "Catalog", name: "Party" }],
          event: "beforeWrite",
          whenChanged: ["price"],
          handler: { schema: "app", name: "on_party" },
        }),
        "sql/app/handlers.sql": `${ON_USER}\n${ON_PARTY}`,
      })
      await inTarget(EMPTY, async (url) => {
        await establish(url, model)
        const outcome = await plan(url, model)
        expect(outcome.status).toBe("unchanged")
        expect(errors(outcome)).toEqual([])
      })
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
     * `shadowBase` з іншою роллю адміністрування. Не
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
      // Відмова за іншої ролі копії спрацьовує лише за глобальних ADP хоч з
      // одного боку. Сам доказ від іншої ролі копії тут і без неї не сходиться — права власника схем і
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

    /** Модель із прийнятою `app.notes` і дослівним тригером на ній. */
    const withTrigger = (type: Record<string, unknown>, sql: string) =>
      compiled({ [NOTES]: notes(type), "sql/app/dependent.sql": sql })

    const TRIGGER_FN = `CREATE FUNCTION app.notes_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`

    it("refuses a type change under a trigger WHEN condition", async () => {
      const sql = `${TRIGGER_FN}
CREATE TRIGGER notes_note BEFORE UPDATE ON app.notes FOR EACH ROW WHEN (NEW.note IS DISTINCT FROM OLD.note) EXECUTE FUNCTION app.notes_touch();`
      const outcome = await planChange(
        await withTrigger(LONG, sql),
        await withTrigger(SHORT, sql)
      )
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.type-change-dependent"])
      expect(
        outcome.diagnostics.find((d) => d.code === "plan.type-change-dependent")
          ?.params
      ).toEqual({ objects: "trigger app.notes.notes_note" })
    })

    it("refuses a type change under a trigger UPDATE OF list", async () => {
      // Зміна без втрат: детектор дивиться на кожну зміну типу, бо `ALTER …
      // TYPE` падає однаково
      const sql = `${TRIGGER_FN}
CREATE TRIGGER notes_note_of BEFORE UPDATE OF note ON app.notes FOR EACH ROW EXECUTE FUNCTION app.notes_touch();`
      const outcome = await planChange(
        await withTrigger(SHORT, sql),
        await withTrigger(LONG, sql)
      )
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.type-change-dependent"])
      expect(
        outcome.diagnostics.find((d) => d.code === "plan.type-change-dependent")
          ?.params
      ).toEqual({ objects: "trigger app.notes.notes_note_of" })
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
CREATE TRIGGER notes_note BEFORE UPDATE ON app.notes FOR EACH ROW WHEN (NEW.note IS DISTINCT FROM OLD.note) EXECUTE FUNCTION app.notes_touch();`

    it("lets a type change through when an earlier step drops the dependent trigger", async () => {
      const artifact = planned(
        await planChange(
          await withTrigger(LONG, WHEN_TRIGGER),
          await withTrigger(SHORT, TRIGGER_FN)
        )
      )
      const ids = artifact.steps.map((s) => s.id)
      const [drop] = stepMatching(artifact, /DROP TRIGGER/)
      const [change] = stepMatching(artifact, /ALTER COLUMN "note" TYPE/)
      expect(ids.indexOf(drop!.id)).toBeLessThan(ids.indexOf(change!.id))
    })

    it("refuses a type change when the dependent trigger is dropped only after it", async () => {
      const before = await withTrigger(LONG, WHEN_TRIGGER)
      const after = await withTrigger(SHORT, TRIGGER_FN)
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
      ).toEqual({ objects: "trigger app.notes.notes_note" })
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
   * Слід кроків (спека промоції §7.2, «З'єднання й блокування») на плані без
   * промоції: `app.c.pc → app.p.code`. Замок кожного кроку FK береться наперед
   * у найсильнішому режимі, і звірка сліду на доказі не бачить зайвих замків.
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
    // для операторів політик і зняття тригера ролі з переліку (спека промоції §7.2)
    const POLICY =
      "CREATE POLICY notes_read ON app.notes FOR SELECT TO authenticated USING (true);"
    const TOUCH = `CREATE FUNCTION app.notes_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`
    const TRIGGER = `${TOUCH}
CREATE TRIGGER notes_touch BEFORE UPDATE ON app.notes FOR EACH ROW EXECUTE FUNCTION app.notes_touch();`
    const SERVICES = "Auth, Storage, Realtime"

    const withSql = (sql: string | undefined) =>
      compiled({
        [NOTES]: notes(),
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
    const UNTRIGGERED = ["app.notes_touch()"]

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
})
