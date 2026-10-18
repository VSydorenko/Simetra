import { describe, expect, it } from "vitest"
import type { PromotionRecord } from "simetra/compiler"
import {
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
  PLAN_FORMAT,
  PLATFORM_VERSION,
  parsePlan,
  planArtifactSchema,
  planFileName,
  serializePlan,
  stampPlan,
  verifyPlanHash,
  type CatalogFingerprint,
  type FingerprintSection,
  type PlanArtifact,
} from "simetra/schema"

const fingerprint = (digit: string): CatalogFingerprint => ({
  version: FINGERPRINT_VERSION,
  sections: Object.fromEntries(
    FINGERPRINT_SECTIONS.map((s) => [s, digit.repeat(64)])
  ) as Record<FingerprintSection, string>,
})

/** Факти сервера, які план прочитав з цілі. */
const SERVER = {
  major: 17,
  encoding: "UTF8",
  collate: "C.UTF-8",
  ctype: "C.UTF-8",
  localeProvider: "c",
  locale: null,
  collationVersion: null,
}

const draft = (): Omit<PlanArtifact, "planHash"> => ({
  format: PLAN_FORMAT,
  platformVersion: PLATFORM_VERSION,
  engine: { name: "pg-delta", version: "1.0.0-alpha.56" },
  fingerprintVersion: FINGERPRINT_VERSION,
  fromHash: null,
  toHash: "f".repeat(64),
  scope: { schemas: ["app", "simetra"], provider: "supabase" },
  targetFingerprint: fingerprint("a"),
  desiredFingerprint: fingerprint("b"),
  steps: [
    {
      id: "s1",
      origin: "engine",
      sql: "ALTER TABLE app.t DROP COLUMN c",
      verb: "alter",
      class: "destructive",
      lockClass: "accessExclusive",
      transactionality: "transactional",
      newSegmentBefore: false,
      lockedTables: [{ schema: "app", name: "t" }],
      produces: [],
      consumes: ["table:app.t"],
      destroys: ["column:app.t.c"],
      produced: [],
      destroyed: [{ kind: "column", schema: "app", table: "t", name: "c" }],
      consumed: [{ kind: "table", schema: "app", name: "t" }],
      dataLoss: true,
      rewriteRisk: false,
      guards: [],
    },
  ],
  requiredPermissions: ["s1"],
  drift: null,
  role: "postgres",
  server: SERVER,
  ledgerHead: null,
  locks: [{ schema: "app", name: "t", mode: "accessExclusive" }],
  implicitLocks: [
    {
      schema: "storage",
      name: "objects",
      mode: "shareRowExclusive",
      step: "s1",
    },
  ],
  providerLocks: [
    {
      setting: "supautils.policy_grants",
      statements: ["createPolicy", "dropPolicy"],
      tables: [{ schema: "auth", name: "users" }],
    },
  ],
  foreignKeys: { subjects: [], live: [] },
  preamble: [{ name: "search_path", value: "pg_catalog" }],
  revalidationSearchPath: '"$user", public',
  plpgsqlCheck: "transient",
  platformFunctions: [],
  desiredInvalid: [],
  promotion: null,
  environment: { defaultPrivileges: [] },
  resultCatalog: { tables: [], enumTypes: [], units: [] },
})

const RECORD: PromotionRecord = {
  format: 1,
  base: "0".repeat(64),
  result: "1".repeat(64),
  objectId: "00000000-0000-4000-8000-000000000001",
  kind: "Catalog",
  tables: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      schema: "app",
      from: "parties",
      to: "party",
    },
  ],
  columns: [],
  typeChanges: [],
  dataSteps: [],
  retired: [],
  relaxed: [],
  tightened: [],
  rowLevelSecurity: [],
  deleteSemantics: [],
  conversions: [],
  movedUnits: [],
  rewrittenUnits: [],
  contractChanges: [],
}

const PROMOTION = (): NonNullable<PlanArtifact["promotion"]> => ({
  recordHash: "d".repeat(64),
  record: RECORD,
  permissionItems: [{ token: "access:app.party", summary: ["anon: select"] }],
  preservation: [
    {
      before: { schema: "app", table: "parties" },
      after: { schema: "app", table: "party" },
      key: { before: "id", after: "id" },
      columns: [
        { before: "name", after: "description" },
        { before: "code", after: "code", typeChangeStep: "s4" },
      ],
    },
  ],
  columns: [
    {
      table: { schema: "app", name: "party" },
      from: "name",
      to: "description",
    },
  ],
  canonicalNames: [
    {
      kind: "constraint",
      table: { schema: "app", name: "party" },
      from: "parties_pkey",
      to: "party_pkey",
    },
  ],
  conversions: [{ step: "s1", class: "removed" }],
  data: [],
})

const withPromotion = (): Omit<PlanArtifact, "planHash"> => ({
  ...draft(),
  promotion: PROMOTION(),
  requiredPermissions: ["access:app.party", "s1"],
})

const DRIFT = {
  reason: "drift",
  sections: ["owner"],
  paths: ["tables.app.t.columns.c"],
} as const satisfies PlanArtifact["drift"]

const withDrift = (): Omit<PlanArtifact, "planHash"> => ({
  ...draft(),
  drift: { ...DRIFT, sections: [...DRIFT.sections], paths: [...DRIFT.paths] },
  requiredPermissions: ["drift", "s1"],
})

describe("plan artifact", () => {
  it("hashes the same content to the same planHash", async () => {
    const a = await stampPlan(draft())
    const b = await stampPlan(draft())
    expect(a.planHash).toMatch(/^[0-9a-f]{64}$/)
    expect(b.planHash).toBe(a.planHash)
    expect(await verifyPlanHash(a)).toBe(true)
  })

  it("covers the steps with the hash", async () => {
    const stamped = await stampPlan(draft())
    const changed = draft()
    changed.steps[0]!.sql = "ALTER TABLE app.t DROP COLUMN d"
    expect((await stampPlan(changed)).planHash).not.toBe(stamped.planHash)
    const tampered: PlanArtifact = { ...changed, planHash: stamped.planHash }
    expect(await verifyPlanHash(tampered)).toBe(false)
  })

  it("covers lockedTables with the hash", async () => {
    const stamped = await stampPlan(draft())
    const changed = draft()
    changed.steps[0]!.lockedTables = []
    expect((await stampPlan(changed)).planHash).not.toBe(stamped.planHash)
  })

  it("covers the drift with the hash", async () => {
    const clean = await stampPlan(draft())
    const drifted = await stampPlan(withDrift())
    expect(drifted.planHash).not.toBe(clean.planHash)
    const other = withDrift()
    other.drift = { ...DRIFT, sections: ["relations"], paths: [] }
    expect((await stampPlan(other)).planHash).not.toBe(drifted.planHash)
    const swapped: PlanArtifact = { ...drifted, drift: null }
    expect(await verifyPlanHash(swapped)).toBe(false)
  })

  it("round-trips a plan with drift", async () => {
    const text = serializePlan(await stampPlan(withDrift()))
    const parsed = parsePlan(text)
    if (!parsed.ok) throw new Error(parsed.message)
    expect(parsed.artifact.drift).toEqual(DRIFT)
    expect(serializePlan(parsed.artifact)).toBe(text)
    expect(await verifyPlanHash(parsed.artifact)).toBe(true)
  })

  it("rejects a drift section of unknown shape", async () => {
    const artifact = await stampPlan(withDrift())
    const variants: unknown[] = [
      { ...DRIFT, note: "x" },
      { ...DRIFT, reason: "unknown" },
      { ...DRIFT, sections: ["nowhere"] },
      { reason: "drift", sections: [] },
    ]
    for (const drift of variants)
      expect(
        parsePlan(serializePlan({ ...artifact, drift } as PlanArtifact)).ok
      ).toBe(false)
    const missing: Record<string, unknown> = { ...artifact }
    delete missing.drift
    expect(parsePlan(JSON.stringify(missing)).ok).toBe(false)
  })

  it("round-trips the file byte for byte", async () => {
    const text = serializePlan(await stampPlan(draft()))
    expect(text.endsWith("}\n")).toBe(true)
    expect(text.split("\n")[1]).toMatch(/^ {2}"[a-zA-Z]+": /)
    const parsed = parsePlan(text)
    if (!parsed.ok) throw new Error(parsed.message)
    expect(serializePlan(parsed.artifact)).toBe(text)
    expect(await verifyPlanHash(parsed.artifact)).toBe(true)
  })

  it("writes keys in canonical order", async () => {
    const text = serializePlan(await stampPlan(draft()))
    const top = [...text.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1])
    expect(top).toEqual([...top].sort())
  })

  it("rejects an unknown top-level key", async () => {
    const artifact = await stampPlan(draft())
    const parsed = parsePlan(
      serializePlan({ ...artifact, extra: 1 } as PlanArtifact)
    )
    expect(parsed.ok).toBe(false)
  })

  it("rejects an unknown key in a step", async () => {
    const artifact = await stampPlan(draft())
    const text = serializePlan(artifact).replace(
      '"class": "destructive"',
      '"class": "destructive",\n      "note": "x"'
    )
    // Відмова від схеми, а не від синтаксису
    expect(() => JSON.parse(text) as unknown).not.toThrow()
    expect(parsePlan(text).ok).toBe(false)
  })

  it("covers the role, the locks, the provider list and the preamble with the hash", async () => {
    const stamped = await stampPlan(draft())
    const relocked = draft()
    relocked.locks[0]!.mode = "shareRowExclusive"
    expect((await stampPlan(relocked)).planHash).not.toBe(stamped.planHash)
    const implicit = draft()
    implicit.implicitLocks[0]!.step = "s2"
    expect((await stampPlan(implicit)).planHash).not.toBe(stamped.planHash)
    expect((await stampPlan({ ...draft(), role: "other" })).planHash).not.toBe(
      stamped.planHash
    )
    const bare = draft()
    bare.preamble = []
    expect((await stampPlan(bare)).planHash).not.toBe(stamped.planHash)
    // Перелік провайдера — властивість цілі, з якою план побудовано (R27)
    const provider = draft()
    provider.providerLocks[0]!.tables = []
    expect((await stampPlan(provider)).planHash).not.toBe(stamped.planHash)
  })

  it("is strict about the role, the locks and the preamble", async () => {
    const artifact = await stampPlan(draft())
    const variants: unknown[] = [
      { ...artifact, locks: [{ schema: "app", name: "t" }] },
      {
        ...artifact,
        locks: [{ schema: "app", name: "t", mode: "rowExclusive" }],
      },
      {
        ...artifact,
        locks: [
          { schema: "app", name: "t", mode: "accessExclusive", note: "x" },
        ],
      },
      {
        ...artifact,
        preamble: [{ name: "search_path", value: "pg_catalog", note: "x" }],
      },
      // Неявний замок без кроку
      {
        ...artifact,
        implicitLocks: [
          { schema: "storage", name: "objects", mode: "shareRowExclusive" },
        ],
      },
      { ...artifact, role: 1 },
      // Невідомий клас оператора і зайвий ключ таблиці провайдера
      {
        ...artifact,
        providerLocks: [
          { setting: "x", statements: ["createTrigger"], tables: [] },
        ],
      },
      {
        ...artifact,
        providerLocks: [
          {
            setting: "x",
            statements: [],
            tables: [{ schema: "auth", name: "users", mode: "share" }],
          },
        ],
      },
    ]
    for (const variant of variants)
      expect(parsePlan(JSON.stringify(variant)).ok).toBe(false)
    for (const field of [
      "role",
      "locks",
      "implicitLocks",
      "providerLocks",
      "preamble",
    ]) {
      const missing: Record<string, unknown> = { ...artifact }
      delete missing[field]
      expect(parsePlan(JSON.stringify(missing)).ok).toBe(false)
    }
  })

  it.each([
    { name: "role", value: "postgres" },
    { name: "search_path", value: "app, public" },
    { name: "check_function_bodies", value: "on" },
    { name: "toString", value: "x" },
  ])(
    "rejects a preamble setting off the allowed list ($name = $value)",
    async (setting) => {
      const artifact = await stampPlan({ ...draft(), preamble: [setting] })
      expect(parsePlan(serializePlan(artifact)).ok).toBe(false)
    }
  )

  it("accepts every allowed preamble setting", async () => {
    const artifact = await stampPlan({
      ...draft(),
      preamble: [
        { name: "search_path", value: "pg_catalog" },
        { name: "check_function_bodies", value: "off" },
      ],
    })
    const parsed = parsePlan(serializePlan(artifact))
    if (!parsed.ok) throw new Error("plan must parse")
    expect(parsed.artifact).toEqual(artifact)
  })

  it("reports a plan of another format as unsupported, not as malformed", async () => {
    const artifact = await stampPlan(draft())
    // Форма першого формату: без нових полів і з іншим `format`
    const old: Record<string, unknown> = { ...artifact, format: 1 }
    delete old.locks
    delete old.preamble
    const parsed = parsePlan(JSON.stringify(old))
    expect(parsed).toMatchObject({
      ok: false,
      reason: "format",
      diagnostic: {
        code: "apply.plan-format",
        severity: "error",
        params: { found: 1, supported: PLAN_FORMAT },
      },
    })
    if (parsed.ok || parsed.reason !== "format") throw new Error("format")
    expect(parsed.diagnostic.message).toMatch(
      /plan format 1 is not supported.*rebuild the plan/i
    )
    expect(PLAN_FORMAT).toBe(5)
  })

  it("asks to rebuild a plan of the second format", async () => {
    const artifact = await stampPlan(draft())
    // Форма другого формату: без середовища
    const old: Record<string, unknown> = { ...artifact, format: 2 }
    delete old.environment
    expect(parsePlan(JSON.stringify(old))).toMatchObject({
      ok: false,
      reason: "format",
      diagnostic: { params: { found: 2, supported: PLAN_FORMAT } },
    })
  })

  it("asks to rebuild a plan of the third format", async () => {
    const artifact = await stampPlan(draft())
    // Форма третього формату: без фактів сервера й голови ledger
    const old: Record<string, unknown> = { ...artifact, format: 3 }
    delete old.server
    delete old.ledgerHead
    const parsed = parsePlan(JSON.stringify(old))
    expect(parsed).toMatchObject({
      ok: false,
      reason: "format",
      diagnostic: {
        code: "apply.plan-format",
        params: { found: 3, supported: PLAN_FORMAT },
      },
    })
    if (parsed.ok || parsed.reason !== "format") throw new Error("format")
    expect(parsed.diagnostic.message).toMatch(
      /plan format 3 is not supported.*rebuild the plan/i
    )
  })

  it("asks to rebuild a plan of the fourth format", async () => {
    const artifact = await stampPlan(draft())
    // Форма четвертого формату: без сигнатур функцій платформи
    const old: Record<string, unknown> = { ...artifact, format: 4 }
    delete old.platformFunctions
    const parsed = parsePlan(JSON.stringify(old))
    expect(parsed).toMatchObject({
      ok: false,
      reason: "format",
      diagnostic: {
        code: "apply.plan-format",
        params: { found: 4, supported: PLAN_FORMAT },
      },
    })
    if (parsed.ok || parsed.reason !== "format") throw new Error("format")
    expect(parsed.diagnostic.message).toMatch(
      /plan format 4 is not supported.*rebuild the plan/i
    )
  })

  it("round-trips environment steps and the role's global default privileges", async () => {
    const base = draft()
    const artifact = await stampPlan({
      ...base,
      steps: [
        ...base.steps,
        {
          ...base.steps[0]!,
          id: "s2",
          origin: "environment",
          sql: 'REVOKE ALL ON FUNCTION "app"."f"() FROM PUBLIC',
          class: "catalogOnly",
          lockClass: "none",
          lockedTables: [],
          consumes: [],
          destroys: [],
          destroyed: [],
          consumed: [],
          dataLoss: false,
        },
      ],
      environment: {
        defaultPrivileges: [
          {
            objtype: "f",
            grantee: "postgres",
            privilege: "EXECUTE",
            grantable: false,
          },
        ],
      },
    })
    const parsed = parsePlan(serializePlan(artifact))
    if (!parsed.ok) throw new Error(parsed.message)
    expect(parsed.artifact).toEqual(artifact)
    expect(await verifyPlanHash(parsed.artifact)).toBe(true)
  })

  it("rejects a plan without the environment or with an unknown object type", async () => {
    const artifact = await stampPlan(draft())
    const without: Record<string, unknown> = { ...artifact }
    delete without.environment
    expect(parsePlan(JSON.stringify(without))).toMatchObject({
      ok: false,
      reason: "invalid",
    })
    const unknownType = {
      ...artifact,
      environment: {
        defaultPrivileges: [
          {
            objtype: "L",
            grantee: "anon",
            privilege: "SELECT",
            grantable: false,
          },
        ],
      },
    }
    expect(parsePlan(JSON.stringify(unknownType))).toMatchObject({
      ok: false,
      reason: "invalid",
    })
  })

  it("covers the revalidation search path with the hash and requires it", async () => {
    const artifact = await stampPlan(draft())
    expect(
      (await stampPlan({ ...draft(), revalidationSearchPath: "app" })).planHash
    ).not.toBe(artifact.planHash)
    const without: Record<string, unknown> = { ...artifact }
    delete without.revalidationSearchPath
    expect(parsePlan(JSON.stringify(without))).toMatchObject({
      ok: false,
      reason: "invalid",
    })
    expect(
      parsePlan(JSON.stringify({ ...artifact, revalidationSearchPath: null }))
    ).toMatchObject({ ok: false, reason: "invalid" })
  })

  it("covers the plpgsql_check mode with the hash and requires a known one", async () => {
    const artifact = await stampPlan(draft())
    expect(
      (await stampPlan({ ...draft(), plpgsqlCheck: "installed" })).planHash
    ).not.toBe(artifact.planHash)
    const without: Record<string, unknown> = { ...artifact }
    delete without.plpgsqlCheck
    expect(parsePlan(JSON.stringify(without))).toMatchObject({
      ok: false,
      reason: "invalid",
    })
    expect(
      parsePlan(JSON.stringify({ ...artifact, plpgsqlCheck: "maybe" }))
    ).toMatchObject({ ok: false, reason: "invalid" })
  })

  it("covers the foreign keys of the footprint with the hash and requires them", async () => {
    const artifact = await stampPlan(draft())
    const watched = {
      subjects: [{ schema: "app", name: "t" }],
      live: [
        {
          schema: "other",
          table: "r",
          columns: ["t"],
          references: { schema: "app", table: "t", columns: ["id"] },
        },
      ],
    }
    const stamped = await stampPlan({ ...draft(), foreignKeys: watched })
    expect(stamped.planHash).not.toBe(artifact.planHash)
    expect(parsePlan(serializePlan(stamped))).toEqual({
      ok: true,
      artifact: stamped,
    })
    const without: Record<string, unknown> = { ...artifact }
    delete without.foreignKeys
    expect(parsePlan(JSON.stringify(without))).toMatchObject({
      ok: false,
      reason: "invalid",
    })
    expect(
      parsePlan(
        JSON.stringify({
          ...artifact,
          foreignKeys: { subjects: [], live: [{ schema: "x" }] },
        })
      )
    ).toMatchObject({ ok: false, reason: "invalid" })
  })

  it("covers the server facts and the ledger head with the hash and requires them", async () => {
    const artifact = await stampPlan(draft())
    const other = await stampPlan({
      ...draft(),
      server: { ...SERVER, collate: "C", collationVersion: "1" },
      ledgerHead: "00000000-0000-4000-8000-0000000000aa",
    })
    expect(other.planHash).not.toBe(artifact.planHash)
    expect(
      (await stampPlan({ ...draft(), ledgerHead: other.ledgerHead })).planHash
    ).not.toBe(artifact.planHash)
    expect(parsePlan(serializePlan(other))).toEqual({
      ok: true,
      artifact: other,
    })
    for (const field of ["server", "ledgerHead"]) {
      const without: Record<string, unknown> = { ...artifact }
      delete without[field]
      expect(parsePlan(JSON.stringify(without))).toMatchObject({
        ok: false,
        reason: "invalid",
      })
    }
    for (const server of [
      { ...SERVER, major: "17" },
      { ...SERVER, extra: true },
      { ...SERVER, locale: undefined },
    ])
      expect(parsePlan(JSON.stringify({ ...artifact, server }))).toMatchObject({
        ok: false,
        reason: "invalid",
      })
  })

  it("covers the desired invalid objects with the hash and requires them", async () => {
    const artifact = await stampPlan(draft())
    expect(
      (await stampPlan({ ...draft(), desiredInvalid: ["index app.i"] }))
        .planHash
    ).not.toBe(artifact.planHash)
    const without: Record<string, unknown> = { ...artifact }
    delete without.desiredInvalid
    expect(parsePlan(JSON.stringify(without))).toMatchObject({
      ok: false,
      reason: "invalid",
    })
  })

  it("holds the current format in the schema itself, not only in parsePlan", async () => {
    const artifact = await stampPlan(draft())
    expect(planArtifactSchema.safeParse(artifact).success).toBe(true)
    expect(
      planArtifactSchema.safeParse({ ...artifact, format: 1 }).success
    ).toBe(false)
  })

  it("round-trips a plan with a promotion section", async () => {
    const artifact = await stampPlan(withPromotion())
    const text = serializePlan(artifact)
    const parsed = parsePlan(text)
    if (!parsed.ok) throw new Error(parsed.message)
    expect(parsed.artifact).toEqual(artifact)
    expect(serializePlan(parsed.artifact)).toBe(text)
    expect(await verifyPlanHash(parsed.artifact)).toBe(true)
  })

  it("covers the promotion section with the hash", async () => {
    const stamped = await stampPlan(withPromotion())
    expect(stamped.planHash).not.toBe((await stampPlan(draft())).planHash)
    const changed = withPromotion()
    changed.promotion!.columns[0]!.to = "title"
    expect((await stampPlan(changed)).planHash).not.toBe(stamped.planHash)
    const swapped: PlanArtifact = { ...stamped, promotion: null }
    expect(await verifyPlanHash(swapped)).toBe(false)
  })

  it("rejects a promotion section of unknown shape", async () => {
    const artifact = await stampPlan(withPromotion())
    const section = PROMOTION()
    const variants: unknown[] = [
      { ...section, note: "x" },
      { ...section, recordHash: "not-a-hash" },
      { ...section, record: { ...RECORD, note: "x" } },
      { ...section, conversions: [{ step: "s1", class: "lost" }] },
      {
        ...section,
        canonicalNames: [
          {
            kind: "trigger",
            table: { schema: "app", name: "party" },
            from: "a",
            to: "b",
          },
        ],
      },
      {
        ...section,
        columns: [{ table: { schema: "app", name: "party" }, from: "a" }],
      },
      // Таблиця — структурний ключ нового імені (R23): голе ім'я неоднозначне
      { ...section, columns: [{ table: "party", from: "a", to: "b" }] },
      {
        ...section,
        columns: [
          {
            table: { schema: "app", name: "party", note: "x" },
            from: "a",
            to: "b",
          },
        ],
      },
      {
        ...section,
        canonicalNames: [
          { kind: "index", table: "app.party", from: "a", to: "b" },
        ],
      },
      {
        ...section,
        permissionItems: [{ token: "access:app.party", summary: "x" }],
      },
      {
        ...section,
        preservation: [{ ...section.preservation[0]!, note: "x" }],
      },
      // Неявні замки — поле артефакту, а не секції (R26): у секції воно чуже
      { ...section, implicitLocks: [] },
    ]
    for (const promotion of variants)
      expect(parsePlan(JSON.stringify({ ...artifact, promotion })).ok).toBe(
        false
      )
    const missing: Record<string, unknown> = { ...artifact }
    delete missing.promotion
    expect(parsePlan(JSON.stringify(missing)).ok).toBe(false)
  })

  it("rejects text that is not JSON", () => {
    expect(parsePlan("{").ok).toBe(false)
  })

  it("names the file after both snapshot hashes", () => {
    expect(planFileName(null, "abcdef0123456789")).toBe(
      "initial-abcdef012345.plan.json"
    )
    expect(planFileName("0123456789abcdef", "fedcba9876543210")).toBe(
      "0123456789ab-fedcba987654.plan.json"
    )
  })

  // План лише з дрейфом (рішення 16) не змінює знімок: from = to. Ім'я
  // лишається звичайним і не збігається ні з першим застосуванням, ні з
  // планом, що веде до того самого знімка з іншого
  it("names a drift-only plan with the same hash on both sides", () => {
    const h = "0123456789abcdef"
    expect(planFileName(h, h)).toBe("0123456789ab-0123456789ab.plan.json")
    expect(
      new Set([
        planFileName(h, h),
        planFileName(null, h),
        planFileName("fedcba9876543210", h),
      ]).size
    ).toBe(3)
  })

  it("round-trips a drift-only plan with an empty step list", async () => {
    const h = "c".repeat(64)
    const artifact = await stampPlan({
      ...draft(),
      fromHash: h,
      toHash: h,
      steps: [],
      requiredPermissions: ["drift"],
      drift: { reason: "drift", sections: ["owner"], paths: [] },
    })
    const parsed = parsePlan(serializePlan(artifact))
    if (!parsed.ok) throw new Error(parsed.message)
    expect(parsed.artifact).toEqual(artifact)
    expect(await verifyPlanHash(parsed.artifact)).toBe(true)
  })
})
