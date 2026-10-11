import pg from "pg"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { EngineScope } from "simetra/schema"
import { createPgDeltaEngine } from ".."
import { engineFacts } from "../pg-delta/adapter"
import { coverageGaps } from "../pg-delta/fingerprint-coverage"
import {
  shadowDatabaseCount,
  testDatabaseUrl,
} from "../../../../simetra/test/support"

/**
 * Контракт покриття відбитка (рішення 3 плану П3-1): кожне поле моделі
 * закріпленого двигуна має секцію відбитка чи виняток із причиною, і мапа не
 * тримає полів, яких модель уже не має. Каталог багатий настільки, щоб
 * двигун видобув кожне поле мапи; нове поле альфи pg-delta валить тест.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }

const CATALOG = `
  create extension if not exists citext with schema app;
  create type app.mood as enum ('a', 'b');
  create type app.pair as (x int, y text);
  create type app.span as range (subtype = int4);
  create domain app.pos as int default 1 not null constraint pos_check check (value > 0);
  create domain app.txt as text collate "C";
  create collation app.co from "C";
  create sequence app.seq as int start 5 increment 2 minvalue 1 maxvalue 1000 cache 3 cycle;
  create table app.parent (id int generated always as identity primary key, name text not null default 'x', m app.mood, d app.pos, g int generated always as (id * 2) stored, r int4range, exclude using gist (r with &&)) with (fillfactor = 70);
  alter table app.parent replica identity full;
  alter table app.parent enable row level security;
  alter table app.parent force row level security;
  alter sequence app.seq owned by app.parent.name;
  create table app.child (extra int) inherits (app.parent);
  create table app.u (id serial primary key, p int references app.parent (id) on delete cascade deferrable initially deferred, c text);
  alter table app.u add constraint c_ne check (c <> '') not valid;
  create unlogged table app.ul (id int);
  create table app.part (k int not null, v text) partition by range (k);
  create table app.part_1 partition of app.part for values from (0) to (10);
  create table app.part_d partition of app.part default;
  create index part_k on app.part (k);
  create unique index u_c on app.u (lower(c)) where c is not null;
  alter table app.u replica identity using index u_pkey;
  create view app.v with (security_barrier) as select id, name from app.parent where id > 0 with local check option;
  create materialized view app.mv as select id from app.parent with no data;
  create function app.f(a int default 1) returns int language sql immutable strict security definer set search_path = '' cost 5 as $$ select a $$;
  create procedure app.pr(a int) language plpgsql as $$ begin null; end $$;
  create function app.trg() returns trigger language plpgsql as $$ begin return new; end $$;
  create trigger t1 before insert on app.parent for each row when (new.id > 0) execute function app.trg();
  alter table app.parent disable trigger t1;
  create function app.ffin(int) returns int language sql as $$ select $1 $$;
  create function app.minv(int, int) returns int language sql strict as $$ select $1 - $2 $$;
  create aggregate app.s(int) (sfunc = int4pl, stype = int, initcond = '0', finalfunc = app.ffin, combinefunc = int4pl, msfunc = int4pl, minvfunc = app.minv, mstype = int, minitcond = '0', mfinalfunc = app.ffin, sortop = <, parallel = safe);
  create aggregate app.os(order by int) (sfunc = int4pl, stype = int, initcond = 0);
  create policy p on app.parent as restrictive for update to authenticated using (true) with check (id > 0);
  create rule r as on insert to app.u where new.c = 'z' do instead nothing;
  create publication app_pub for table app.parent (id, name) where (id > 0), table app.u with (publish = 'insert');
  create publication app_pub2 for tables in schema app;
  comment on table app.parent is 'parent';
  comment on column app.parent.name is 'name';
  comment on function app.f(int) is 'f';
  comment on type app.mood is 'mood';
  comment on policy p on app.parent is 'pol';
  comment on trigger t1 on app.parent is 'trg';
  comment on rule r on app.u is 'rule';
  comment on schema app is 'app';
  comment on constraint pos_check on domain app.pos is 'pc';
  comment on index app.u_c is 'idx';
  comment on sequence app.seq is 'seq';
  comment on view app.v is 'v';
  comment on materialized view app.mv is 'mv';
  comment on domain app.pos is 'pos';
  comment on aggregate app.s(int) is 'agg';
  comment on procedure app.pr(int) is 'pr';
  comment on collation app.co is 'co';
  comment on column app.pair.x is 'px';
  grant select on app.parent to anon;
  grant update (name) on app.parent to authenticated;
  grant usage on sequence app.seq to anon;
  grant execute on function app.f(int) to anon;
  grant usage on type app.mood to anon;
  grant usage on schema app to anon;
  revoke execute on function app.trg() from public;
  alter default privileges in schema app grant select on tables to anon;
  alter default privileges in schema app grant execute on functions to authenticated;
  create extension if not exists postgres_fdw with schema extensions;
  create server app_srv foreign data wrapper postgres_fdw options (host 'localhost', dbname 'none');
  create foreign table app.ft (x int options (column_name 'xx') default 1, y int not null) server app_srv options (table_name 'remote');
`

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

describe("fingerprint coverage of the engine model", () => {
  it("maps every engine property to a section or an exception", async () => {
    const outcome = await engine.withDesiredShadow(
      { target: stack },
      "create schema app;",
      scope,
      async (target) => {
        const client = new pg.Client({ connectionString: target.url })
        await client.connect()
        try {
          await client.query(CATALOG)
        } finally {
          await client.end()
        }
        return coverageGaps(
          engineFacts((await engine.extract(target, scope)).catalog)
        )
      }
    )
    if (outcome.status !== "loaded")
      throw new Error(outcome.diagnostics.map((d) => d.message).join("; "))
    expect(outcome.value).toEqual([])
  })
})
