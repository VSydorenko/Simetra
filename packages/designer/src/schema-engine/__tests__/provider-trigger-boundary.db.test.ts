import pg from "pg"
import { describe, expect, it } from "vitest"
import { readFingerprint, type EngineScope } from "simetra/schema"
import { testProvider } from "../../../../simetra/test/support"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import { readCensus } from "../census-read"
import { inTarget, query } from "../../__tests__/support/db"

/**
 * Межа тригера на таблиці провайдера — одне правило (платформна спека §6.9,
 * `providerTriggerInBoundarySql`) у трьох читачах: політиці двигуна (витяг),
 * переписі й відбитку дрейфу. Кожен вхід проходить через усіх трьох, і
 * вердикти мусять збігтися з очікуваним: розійтися читачі вже не можуть —
 * розбіжність перепису з витягом дала б `engine.census-mismatch`, а
 * відбитку — хибний дрейф.
 */

const engine = createPgDeltaEngine()
const reader = createApplyDatabase({ readOnly: true })
const scope: EngineScope = { schemas: ["app"], provider: testProvider() }
const TABLE = 'better_auth."user"'

const SETUP = `create schema app; create schema private;
  create extension tcn with schema app;
  create extension fuzzystrmatch with schema app;
  create function app.ok(text) returns boolean language sql immutable as $$ select true $$;
  create function app.on_user() returns trigger language plpgsql as $$ begin return new; end $$;
  create function private.on_user() returns trigger language plpgsql as $$ begin return new; end $$;
  create function better_auth.on_user() returns trigger language plpgsql as $$ begin return new; end $$;`

const CASES: { form: string; trigger: string; inBoundary: boolean }[] = [
  {
    form: "an app function",
    trigger: `after insert on ${TABLE} for each row execute function app.on_user()`,
    inBoundary: true,
  },
  {
    form: "an outside function with an app function in WHEN",
    trigger: `after update on ${TABLE} for each row when (app.ok(new.name)) execute function private.on_user()`,
    inBoundary: true,
  },
  {
    form: "an outside function with an extension member in WHEN",
    trigger: `after update on ${TABLE} for each row when (app.soundex(new.name) <> '') execute function private.on_user()`,
    inBoundary: true,
  },
  {
    form: "a built-in function",
    trigger: `before update on ${TABLE} for each row execute function suppress_redundant_updates_trigger()`,
    inBoundary: true,
  },
  {
    form: "an extension member",
    trigger: `after insert on ${TABLE} for each row execute function app.triggered_change_notification()`,
    inBoundary: true,
  },
  {
    form: "an outside function",
    trigger: `after insert on ${TABLE} for each row execute function private.on_user()`,
    inBoundary: false,
  },
  {
    form: "a provider function",
    trigger: `after insert on ${TABLE} for each row execute function better_auth.on_user()`,
    inBoundary: false,
  },
]

/** Вердикт кожного читача: чи тригер `probe` у межі. */
async function verdicts(url: string) {
  const fingerprint = () =>
    reader.transaction({ url }, "rollback", (tx) => readFingerprint(tx, scope))
  const triggers = async () => {
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try {
      return (
        (await readCensus(client, scope)).find((c) => c.class === "trigger")
          ?.count ?? 0
      )
    } finally {
      await client.end()
    }
  }
  return { fingerprint, triggers }
}

describe.concurrent("provider trigger boundary", () => {
  it.each(CASES)(
    "judges a trigger on $form the same in the policy, the census and the fingerprint",
    async ({ trigger, inBoundary }) => {
      await inTarget(SETUP, scope, async (url) => {
        const read = await verdicts(url)
        const [fpBefore, countBefore] = [
          await read.fingerprint(),
          await read.triggers(),
        ]
        await query(url, `create trigger probe ${trigger}`)
        const extracted = await engine.extract({ url }, scope)
        const policy = extracted.model.units.some(
          (u) => u.class === "trigger" && u.name === "probe"
        )
        const census = (await read.triggers()) - countBefore === 1
        const fingerprint =
          (await read.fingerprint()).sections.triggers !==
          fpBefore.sections.triggers
        expect({ policy, census, fingerprint }).toEqual({
          policy: inBoundary,
          census: inBoundary,
          fingerprint: inBoundary,
        })
      })
    }
  )
})
