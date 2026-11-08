import { describe, expect, it } from "vitest"
import { canonicalSnapshot, type CompiledModel } from "simetra/compiler"
import {
  executePlan,
  renderDesiredState,
  type PlanArtifact,
  type PlanOutcome,
} from "simetra/schema"
import { attribute, catalog, uuid } from "../../../../simetra/test/support"
import { asSuperuser, query } from "../../__tests__/support/db"
import {
  blindDiagnostics,
  codes,
  compiled,
  EMPTY,
  errors,
  establish,
  inTarget,
  NOTES,
  notes,
  party,
  PARTY,
  plan,
  planned,
  rehearsalOf,
  stepMatching,
  useBuildPlanRoles,
  writer,
} from "./build-plan.support"

/**
 * Конвеєр плану `buildPlan` на стеку Supabase — тригери застосунку на
 * таблицях провайдера (`auth.users`) і замки supautils на таблицях його
 * переліку. Спільна підготовка — `build-plan.support.ts`.
 */

useBuildPlanRoles()

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
