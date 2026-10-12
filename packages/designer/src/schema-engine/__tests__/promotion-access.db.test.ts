import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  readAccessDependents,
  tableKey,
  type EngineScope,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  shadowDatabaseCount,
  testDatabaseUrl,
} from "../../../../simetra/test/support"

/**
 * Залежні статичного гейту доступу (рішення 8 плану П3-2a) на справжній
 * базі: чужі політики, що читають прийняту таблицю, і в'юхи, чия видимість
 * іде за нею. Ціль кожного тесту — окрема база від `withDesiredShadow`.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }
const reader = createApplyDatabase({ readOnly: true })

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

async function inTarget<T>(
  sql: string,
  fn: (url: string) => Promise<T>
): Promise<T> {
  const outcome = await engine.withDesiredShadow(
    { target: { url: stack.url } },
    sql,
    scope,
    (db) => fn(db.url)
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `database did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
  return outcome.value
}

/**
 * Прийнята `items` і таблиця боргу з політикою, що читає її підзапитом;
 * політика самої `items` на неї ж — не чужа. В'юхи: з `security_invoker`,
 * звичайна й матеріалізована. Таблиця з крапкою в імені — щоб ключ і
 * кваліфікація не злипались.
 */
const TARGET = `
create schema app;
create table app.items (id uuid primary key, owner uuid);
alter table app.items enable row level security;
create policy items_own on app.items for select
  using (exists (select 1 from app.items i where i.id = items.id));
create table app."debts.v2" (id uuid primary key, item_id uuid);
alter table app."debts.v2" enable row level security;
create policy "debts read" on app."debts.v2" for select
  using (item_id in (select id from app.items));
create view app.items_invoker with (security_invoker = true) as
  select id from app.items;
create view app.items_plain as select id from app.items;
create materialized view app.items_stored as select id from app.items;
create table app.lonely (id uuid primary key);
`

const read = (url: string, forcedToEnabled: boolean) =>
  reader.transaction({ url }, "rollback", (tx) =>
    readAccessDependents(tx, [
      { schema: "app", name: "items", forcedToEnabled },
      { schema: "app", name: "lonely", forcedToEnabled },
    ])
  )

describe("readAccessDependents", () => {
  it("lists other tables' policies and security_invoker views", async () => {
    await inTarget(TARGET, async (url) => {
      const dependents = await read(url, false)
      expect(dependents.get(tableKey("app", "items"))).toEqual([
        'policy app."debts.v2"."debts read"',
        "view app.items_invoker",
      ])
      expect(dependents.get(tableKey("app", "lonely"))).toEqual([])
    })
  })

  it("adds plain views only for forced → enabled", async () => {
    await inTarget(TARGET, async (url) => {
      const dependents = await read(url, true)
      expect(dependents.get(tableKey("app", "items"))).toEqual([
        'policy app."debts.v2"."debts read"',
        "view app.items_invoker",
        "view app.items_plain",
      ])
    })
  })
})
