import { describe, expect, it } from "vitest"
import { PROVIDER_OWNER_ROLES } from "simetra/model"
import type { EngineScope } from "simetra/schema"
import {
  FIXTURES,
  readReferenceDomain,
  testProvider,
  testRoleFor,
} from "../../../../simetra/test/support"
import {
  expectExtractMatchesModel,
  extractDesired,
  unitClasses,
} from "./engine-extract.support"

/**
 * Extract порту мапить факти pg-delta у модель каталогу (спека П2 §9):
 * рендер бажаного стану в тіні → extract → модель дорівнює знімку
 * компілятора. Спільна підготовка — `engine-extract.support.ts`; публікація
 * `supabase_realtime` і сервісна роль — `engine-extract.supabase.db.test.ts`.
 */

describe("extract maps pg-delta facts into the catalog model", () => {
  for (const [name, fixture] of FIXTURES) {
    it(name, async () => {
      await expectExtractMatchesModel(fixture(testProvider()))
    })
  }

  it("reference domain", async () => {
    await expectExtractMatchesModel(readReferenceDomain(testProvider()))
  })

  it("every unit class maps to the compiler identity", async () => {
    await expectExtractMatchesModel(unitClasses())
  })
})

describe("properties without a model field are loud", () => {
  const scope: EngineScope = { schemas: ["app"], provider: testProvider() }
  const OWNER = PROVIDER_OWNER_ROLES[testProvider()]
  const ANON = testRoleFor("anonymous")

  it("unlogged table and not valid foreign key are unrepresentable", async () => {
    const extracted = await extractDesired(
      `
      create schema app;
      create table app.parent (id int primary key);
      create unlogged table app.scratch (id int);
      create table app.child (id int primary key, parent_id int);
      alter table app.child add constraint child_parent_fk
        foreign key (parent_id) references app.parent (id) not valid;
      `,
      scope
    )
    const unrepresentable = extracted.diagnostics
      .filter((d) => d.code === "engine.unrepresentable")
      .map((d) => ({ object: d.object, severity: d.severity }))
    expect(unrepresentable).toEqual(
      expect.arrayContaining([
        { object: "table:app.scratch", severity: "error" },
        { object: "constraint:app.child.child_parent_fk", severity: "error" },
      ])
    )
    expect(unrepresentable).toHaveLength(2)
    expect(
      extracted.diagnostics.find((d) => d.object === "table:app.scratch")
        ?.message
    ).toContain("persistence")
    const child = extracted.model.tables.find((t) => t.name === "child")
    expect(child?.foreignKeys).toEqual([])
  })

  it("not valid domain constraint is unrepresentable", async () => {
    const extracted = await extractDesired(
      `
      create schema app;
      create domain app.d as int;
      alter domain app.d add constraint d_positive check (value > 0) not valid;
      `,
      scope
    )
    expect(
      extracted.diagnostics
        .filter((d) => d.code === "engine.unrepresentable")
        .map((d) => d.object)
    ).toEqual(["constraint:app.d.d_positive"])
  })

  it("force row level security without enable is unrepresentable", async () => {
    const extracted = await extractDesired(
      `
      create schema app;
      create table app.doc (id int primary key);
      alter table app.doc force row level security;
      `,
      scope
    )
    const found = extracted.diagnostics.filter(
      (d) => d.code === "engine.unrepresentable"
    )
    expect(found.map((d) => d.object)).toEqual(["table:app.doc"])
    expect(found[0]?.message).toContain("forceRowSecurity")
  })

  it("a grant equal to the schema default privileges is implicit", async () => {
    const extracted = await extractDesired(
      `
      create schema app;
      create table app.older (id int);
      alter default privileges for role ${OWNER} in schema app
        grant select on tables to ${ANON};
      create table app.fresh (id int);
      create table app.extra (id int);
      grant insert on app.extra to ${ANON};
      `,
      scope
    )
    expect(extracted.diagnostics.filter((d) => d.severity === "error")).toEqual(
      []
    )
    // `fresh` має рівно права ADP — неявні; `older` створено до ADP, тож
    // прав ADP у нього немає — явне відкликання; `extra` має більше — грант
    expect(extracted.model.units.map((u) => u.identity)).toEqual([
      `defaultPrivileges:${OWNER}:app:table:grant:${ANON}:select`,
      `grant:grant:table:app.extra:${ANON}:insert,select`,
      `grant:revoke:table:app.older:${ANON}:select`,
    ])
  })

  it("default privileges missing on an identity sequence are a revoke", async () => {
    const older = await extractDesired(
      `
      create schema app;
      create table app.counter (id bigint generated always as identity primary key);
      alter default privileges for role ${OWNER} in schema app
        grant select on sequences to ${ANON};
      `,
      scope
    )
    expect(older.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(older.model.units.map((u) => u.identity)).toEqual([
      `defaultPrivileges:${OWNER}:app:sequence:grant:${ANON}:select`,
      `grant:revoke:sequence:app.counter_id_seq:${ANON}:select`,
    ])
    // Контроль: ADP раніше за таблицю — права послідовності неявні
    const fresh = await extractDesired(
      `
      create schema app;
      alter default privileges for role ${OWNER} in schema app
        grant select on sequences to ${ANON};
      create table app.counter (id bigint generated always as identity primary key);
      `,
      scope
    )
    expect(fresh.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(fresh.model.units.map((u) => u.identity)).toEqual([
      `defaultPrivileges:${OWNER}:app:sequence:grant:${ANON}:select`,
    ])
  })

  it("a revoke that also drops a default grant option is unrepresentable", async () => {
    const extracted = await extractDesired(
      `
      create schema app;
      alter default privileges for role ${OWNER} in schema app
        grant select, insert on tables to ${ANON} with grant option;
      create table app.doc (id int);
      revoke insert on app.doc from ${ANON} cascade;
      revoke grant option for select on app.doc from ${ANON} cascade;
      `,
      scope
    )
    const found = extracted.diagnostics.filter(
      (d) => d.code === "engine.unrepresentable"
    )
    expect(found.map((d) => d.object)).toEqual([`acl:(table:app.doc).${ANON}`])
    expect(found[0]?.message).toContain("grantable")
  })

  it("a grant option narrower than the default privileges is unrepresentable", async () => {
    const extracted = await extractDesired(
      `
      create schema app;
      alter default privileges for role ${OWNER} in schema app
        grant select on tables to ${ANON} with grant option;
      create table app.doc (id int);
      revoke grant option for select on app.doc from ${ANON} cascade;
      `,
      scope
    )
    // Права рівні типовим, а опцію відкликано: GRANT без опції її не прибрав
    // би, тож одиниця була б хибною
    const found = extracted.diagnostics.filter(
      (d) => d.code === "engine.unrepresentable"
    )
    expect(found.map((d) => d.object)).toEqual([`acl:(table:app.doc).${ANON}`])
    expect(found[0]?.message).toContain("grantable")
    expect(
      extracted.model.units.filter((u) => u.identity.includes("app.doc"))
    ).toEqual([])
  })

  it("extension comment is implicit unless it differs from the control file", async () => {
    const plain = await extractDesired(
      "create extension citext with schema extensions;",
      scope
    )
    expect(plain.model.units.map((u) => u.identity)).toEqual([
      "extension:citext",
    ])
    const commented = await extractDesired(
      `
      create extension citext with schema extensions;
      comment on extension citext is 'case-insensitive text for app';
      `,
      scope
    )
    expect(commented.model.units.map((u) => u.identity)).toEqual([
      "comment:extension:citext",
      "extension:citext",
    ])
  })

  it("replica identity full is a unit", async () => {
    const extracted = await extractDesired(
      `
      create schema app;
      create table app.doc (id int primary key);
      alter table app.doc replica identity full;
      `,
      scope
    )
    expect(extracted.diagnostics.filter((d) => d.severity === "error")).toEqual(
      []
    )
    expect(extracted.model.units).toEqual([
      {
        class: "replicaIdentity",
        identity: "replicaIdentity:app.doc",
        schema: "app",
        name: "doc",
        sql: "ALTER TABLE app.doc REPLICA IDENTITY FULL",
      },
    ])
  })
})
