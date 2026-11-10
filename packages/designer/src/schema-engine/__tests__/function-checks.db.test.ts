import pg from "pg"
import { describe, expect, it } from "vitest"
import { executePlan } from "simetra/schema"
import {
  apply,
  checkFailed,
  columnsOf,
  desiredFingerprint,
  FP,
  inTarget,
  NEUTRAL,
  options,
  planFor,
  platformFunctionNames,
  PREAMBLE,
  RENAME_A,
  run,
  sessionPath,
  step,
  STRANGER,
  TABLE_T,
  useFunctionChecks,
} from "./function-checks.support"
import { query } from "../../__tests__/support/db"

/**
 * Ревалідація тіл функцій раннером на справжній базі (спека промоції
 * §7.2): валідатори мов `sql` і `plpgsql` до кроків і після, під шляхом
 * ревалідації й власними налаштуваннями функції, проти базової лінії в тій
 * самій транзакції. Спільна підготовка — `function-checks.support.ts`; режими
 * `plpgsql_check`, що залежать від розширення, якого немає в базі профілю, —
 * `function-checks.supabase.db.test.ts`.
 */

useFunctionChecks()

describe("function body revalidation", () => {
  it("refuses a step that breaks a SQL function body", async () => {
    const setup = `${TABLE_T};
      create function app.fa() returns text language sql as $$ select a from app.t $$`
    const steps = [RENAME_A]
    await inTarget(setup, async (url) => {
      const outcome = await executePlan(
        apply,
        { url },
        await planFor(url, steps),
        options
      )
      expect(outcome).toMatchObject({
        status: "failed",
        diagnostics: [{ code: "apply.function-check-failed" }],
      })
      expect(outcome.diagnostics[0]!.params).toMatchObject({ count: 1 })
      expect(String(outcome.diagnostics[0]!.params.functions)).toContain(
        "app.fa(): 42703"
      )
      expect(await columnsOf(url, "app.t")).toEqual(["id", "a"])
    })
  })

  // Під преамбулою крок проходить, а валідатор `plpgsql`
  // компілює тіло в ревалідації. Без `plpgsql_check`: інакше відмову дав би
  // і він, і тест не помітив би, що DO-блок пропустив мову `plpgsql`
  it("refuses a plpgsql body that does not compile although the preamble turned validation off", async () => {
    const steps = [
      step(
        "s1",
        "CREATE FUNCTION app.bad() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$"
      ),
    ]
    await inTarget("select 1", async (url) => {
      const outcome = await executePlan(
        apply,
        { url },
        await planFor(url, steps, {
          desiredFingerprint: await desiredFingerprint(url, steps, {
            bodiesOff: true,
          }),
          preamble: PREAMBLE,
          plpgsqlCheck: "unavailable",
        }),
        options
      )
      expect(outcome).toMatchObject({
        status: "failed",
        diagnostics: [{ code: "apply.function-check-failed" }],
      })
      expect(String(outcome.diagnostics[0]!.params.functions)).toContain(
        "app.bad()"
      )
      expect(
        await query(url, "select to_regprocedure('app.bad()') is null as gone")
      ).toEqual([{ gone: true }])
    })
  })

  it("does not count a SQL function that was broken before the plan", async () => {
    const setup = `${TABLE_T};
      set check_function_bodies = off;
      create function app.fb() returns int language sql as $$ select nope from app.t $$`
    const steps = [NEUTRAL]
    await inTarget(setup, async (url) => {
      const outcome = await executePlan(
        apply,
        { url },
        await planFor(url, steps),
        options
      )
      expect(outcome).toMatchObject({ status: "committed", diagnostics: [] })
    })
  })

  // Без `proconfig` функції `t` не знайшлася б ні до кроків, ні після, і
  // перейменування колонки пройшло б непоміченим
  it("validates a SQL function under its own search_path", async () => {
    const setup = `${TABLE_T};
      create function app.fc() returns text language sql set search_path = app as $$ select a from t $$`
    for (const [steps, broken] of [
      [[NEUTRAL], false],
      [[RENAME_A], true],
    ] as const) {
      await inTarget(setup, async (url) => {
        const outcome = await executePlan(
          apply,
          { url },
          await planFor(url, [...steps]),
          options
        )
        if (!broken) {
          expect(outcome).toMatchObject({ status: "committed" })
          return
        }
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [{ code: "apply.function-check-failed" }],
        })
        expect(String(outcome.diagnostics[0]!.params.functions)).toContain(
          "app.fc()"
        )
      })
    }
  })

  // Валідатор чекає на чужий замок таблиці поза слідом
  it("retries instead of blaming a function when a table it names is locked", async () => {
    const setup = `create schema other;
      create table other.far (x int);
      create function app.fr() returns int language sql as $$ select x from other.far $$`
    const steps = [NEUTRAL]
    await inTarget(setup, async (url) => {
      const plan = await planFor(url, steps)
      const holder = new pg.Client({ connectionString: url })
      holder.on("error", () => {})
      await holder.connect()
      try {
        await holder.query(
          "begin; lock table other.far in access exclusive mode"
        )
        const outcome = await executePlan(apply, { url }, plan, {
          ...options,
          timeouts: { lockTimeoutMs: 200, attempts: 2 },
        })
        expect(outcome).toMatchObject({
          status: "failed",
          attempts: 2,
          diagnostics: [
            { code: "apply.lock-timeout", params: { attempts: 2 } },
          ],
        })
      } finally {
        await holder.end()
      }
      expect(
        await query(url, "select to_regclass('app.n') is null as absent")
      ).toEqual([{ absent: true }])
    })
  })

  // Тіло функції з посиланням уперед доводиться: під
  // преамбулою функція створюється до таблиці, а ревалідація після кроків
  // таблицю вже бачить
  it("proves a forward-referencing SQL function", async () => {
    const steps = [
      step(
        "s1",
        "CREATE FUNCTION app.ff() RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM app.later $$"
      ),
      step("s2", "CREATE TABLE app.later (id int)"),
    ]
    const outcome = await inTarget("select 1", async (url) =>
      executePlan(
        apply,
        { url },
        await planFor(url, steps, {
          desiredFingerprint: await desiredFingerprint(url, steps, {
            bodiesOff: true,
          }),
          preamble: PREAMBLE,
        }),
        { ...options, mode: "proof" }
      )
    )
    expect(outcome).toMatchObject({ status: "committed", diagnostics: [] })
  })

  it("warns about a function it cannot check", async () => {
    const setup = `${TABLE_T};
      create function app.fh() returns text language sql as $$ select a from app.t $$`
    const superuser = `alter function app.fh() owner to ${STRANGER};
      revoke execute on function app.fh() from public`
    const steps = [NEUTRAL]
    await inTarget(
      setup,
      async (url) => {
        const outcome = await executePlan(
          apply,
          { url },
          await planFor(url, steps),
          options
        )
        expect(outcome).toMatchObject({
          status: "committed",
          diagnostics: [
            {
              code: "apply.function-check-blind",
              severity: "warning",
              params: { count: 1, functions: "app.fh()" },
            },
          ],
        })
      },
      superuser
    )
  })

  it("does not call a platform function blind, only the user function", async () => {
    // Ті самі умови для обох: чужий власник і `EXECUTE` відкликано. Функція
    // механіки — одиниця генератора платформи, тож її не названо; функція
    // застосунку лишається сліпою
    const setup = `${TABLE_T};
      create function app.fh() returns text language sql as $$ select a from app.t $$`
    const superuser = `alter function app.fh() owner to ${STRANGER};
      revoke execute on function app.fh() from public;
      alter function simetra.touch() owner to ${STRANGER}`
    expect(platformFunctionNames()).toContain("simetra.touch()")
    await inTarget(
      setup,
      async (url) => {
        const outcome = await executePlan(
          apply,
          { url },
          await planFor(url, [NEUTRAL]),
          options
        )
        expect(outcome).toMatchObject({
          status: "committed",
          diagnostics: [
            {
              code: "apply.function-check-blind",
              params: { count: 1, functions: "app.fh()" },
            },
          ],
        })
      },
      superuser
    )
  })

  it("leaves the transaction settings as they were", async () => {
    // Запис стану йде після ревалідації: тригер на ledger бачить, що
    // повернула фаза 15
    const setup = `create table app.seen (path text, bodies text);
      create function app.seen_state() returns trigger language plpgsql as $$
      begin
        insert into app.seen values (current_setting('search_path'), current_setting('check_function_bodies'));
        return null;
      end $$;
      create trigger seen_state after insert on simetra.ledger
        for each row execute function app.seen_state();`
    const steps = [NEUTRAL]
    await inTarget(setup, async (url) => {
      const session = await sessionPath(url)
      // Шлях ревалідації інший за сесійний: повернення видно
      const outcome = await executePlan(
        apply,
        { url },
        await planFor(url, steps, {
          preamble: PREAMBLE,
          revalidationSearchPath: "app, public",
        }),
        options
      )
      expect(outcome).toMatchObject({ status: "committed" })
      expect(session).not.toBe("app, public")
      expect(
        await query<{ path: string; bodies: string }>(
          url,
          "select path, bodies from app.seen"
        )
      ).toEqual([{ path: session, bodies: "on" }])
    })
  })
})

/**
 * `plpgsql_check` проти базової лінії (спека промоції §7.2): тимчасове
 * розширення в точці збереження, наявне — на місці.
 */
describe("plpgsql_check", () => {
  it("refuses a step that breaks a plpgsql body", async () => {
    await run(FP, [RENAME_A], {}, async (outcome, url) => {
      expect(checkFailed(outcome)).toContain("app.fp(): 42703")
      expect(await columnsOf(url, "app.t")).toEqual(["id", "a"])
    })
    // Валідатор мови колонок у запитах тіла не розв'язує: без розширення
    // той самий крок проходить, тож відмову вище дав саме plpgsql_check
    await run(
      FP,
      [RENAME_A],
      { plpgsqlCheck: "unavailable" },
      async (outcome) => expect(outcome).toMatchObject({ status: "committed" })
    )
  })

  it("checks a trigger function with each table it fires on", async () => {
    const setup = `${TABLE_T};
      create table app.t2 (id int, a text);
      create function app.tg() returns trigger language plpgsql as $$ begin new.a := upper(new.a); return new; end $$;
      create trigger tg before insert on app.t for each row execute function app.tg();
      create trigger tg before insert on app.t2 for each row execute function app.tg()`
    await run(setup, [RENAME_A], {}, async (outcome) => {
      const functions = checkFailed(outcome)
      expect(outcome.diagnostics[0]!.params.count).toBe(1)
      expect(functions).toMatch(/^app\.tg\(\) on app\.t: /)
      expect(functions).not.toContain("app.t2")
    })
  })

  it("checks a trigger with transition tables", async () => {
    const setup = `${TABLE_T};
      create function app.tt() returns trigger language plpgsql as $$ begin perform count(*) from n; return null; end $$;
      create trigger tt after insert on app.t referencing new table as n
        for each statement execute function app.tt()`
    await run(setup, [NEUTRAL], {}, async (outcome) =>
      expect(outcome).toMatchObject({ status: "committed", diagnostics: [] })
    )
  })

  // Базова лінія поглинає наявну помилку функції чужої
  // ролі, а нова помилка в тій самій функції однаково ловиться
  it("keeps an error of another role's function that was there before", async () => {
    const setup = `${TABLE_T};
      create function app.fo() returns int language plpgsql as $$ declare x int; begin select nope into x from app.t; perform a from app.t; return x; end $$`
    const superuser = `alter function app.fo() owner to ${STRANGER}`
    await run(
      setup,
      [NEUTRAL],
      {},
      async (outcome) =>
        expect(outcome).toMatchObject({ status: "committed", diagnostics: [] }),
      superuser
    )
    await run(
      setup,
      [RENAME_A],
      {},
      async (outcome) => {
        expect(checkFailed(outcome)).toContain("app.fo(): 42703")
        expect(outcome.diagnostics[0]!.params.count).toBe(1)
      },
      superuser
    )
  })

  // Oid перествореної функції інший — збіг за сигнатурою
  it("matches a function the plan recreates with the same error", async () => {
    const body = `RETURNS int LANGUAGE plpgsql AS $$ DECLARE x int; BEGIN SELECT nope INTO x FROM app.t; RETURN x; END $$`
    const setup = `${TABLE_T};
      create function app.fz() ${body}`
    await run(
      setup,
      [
        step("s1", "DROP FUNCTION app.fz()", { verb: "drop" }),
        step("s2", `CREATE FUNCTION app.fz() ${body}`),
      ],
      {},
      async (outcome) =>
        expect(outcome).toMatchObject({ status: "committed", diagnostics: [] })
    )
  })
})
