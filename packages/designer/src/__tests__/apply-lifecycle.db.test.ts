import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import pg from "pg"
import { compile } from "simetra/compiler"
import type { EngineScope } from "simetra/schema"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import { databaseResource } from "../io/database"
import { readMetadataDir } from "../io/metadata-dir"
import { createPgDeltaEngine } from "../schema-engine"
import type { ApplyData, PlanData } from "../tools/apply-tools"
import type { DiffData } from "../tools/database-tools"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type { InvokeOptions, ToolResult } from "../tools/types"
import {
  acceptDebt,
  attribute,
  catalog,
  metaFiles,
  project as projectFile,
  shadowDatabaseCount,
  testDatabaseUrl,
  testSuperuserUrl,
  uuid,
} from "../../../simetra/test/support"

/**
 * Наскрізний цикл `plan` → `apply` → `diff` на порожній цілі (план П3-1,
 * задача 11): ланцюжок хешів, репетиція, атомарний відкат на даних, прийняття
 * дрейфу та відмова на підміні власника. Ціль — окрема база від
 * `withDesiredShadow`; база стеку лише читається.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }
const SIMETRA = resolve(__dirname, "../../../simetra")
const ENV = "SIMETRA_DATABASE_URL"
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }

/** Роль, якій за спиною платформи передають таблицю цілі. */
const OWNER = "simetra_apply_lifecycle_owner"

async function other(url: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

async function rows<R extends Record<string, unknown>>(
  url: string,
  sql: string
): Promise<R[]> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return (await client.query<R>(sql)).rows
  } finally {
    await client.end()
  }
}

const dropRole = () =>
  other(testSuperuserUrl(), `drop role if exists ${OWNER};`)

beforeAll(async () => {
  // Роль могла лишитися від убитого прогону
  await dropRole()
  await other(
    testSuperuserUrl(),
    `create role ${OWNER} nologin; grant ${OWNER} to postgres;`
  )
})
afterAll(dropRole)

let shadowsBefore = 0
const disposers: (() => Promise<void>)[] = []
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((d) => d()))
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

async function inTarget(fn: (url: string) => Promise<void>): Promise<void> {
  const outcome = await engine.withDesiredShadow(
    { target: stack },
    "select 1;",
    scope,
    (target) => fn(target.url)
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `target did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
}

const PARTY = "catalogs/Party/Party.meta.json"
const ATTRIBUTE_ID = uuid(9202)
const party = (title: string, extra: Record<string, unknown> | null) =>
  catalog("Party", {
    id: uuid(9201),
    title: { en: title },
    attributes:
      extra === null
        ? []
        : [
            attribute("note", {
              id: ATTRIBUTE_ID,
              type: "String",
              length: 50,
              ...extra,
            }),
          ],
  })

/** Записує метадані в теку; дослівні одиниці — прийнятий борг. */
async function writeMetadata(dir: string, entry: unknown): Promise<void> {
  const files = await acceptDebt(
    metaFiles({
      "project.meta.json": projectFile({ defaultSchema: "app" }),
      [PARTY]: entry,
    })
  )
  await rm(dir, { recursive: true, force: true })
  for (const [path, content] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
}

/** Корінь проєкту з `node_modules/simetra` і текою метаданих. */
async function newProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-apply-lifecycle-"))
  await mkdir(join(root, "node_modules"))
  await symlink(SIMETRA, join(root, "node_modules", "simetra"), "dir")
  disposers.push(() => rm(root, { recursive: true }))
  return join(root, "metadata")
}

const options = (dir: string, url: string): InvokeOptions => ({
  dir,
  readOnly: false,
  allowDatabaseWrite: true,
  dryRun: false,
  confirmed: true,
  channel: "cli",
  database: databaseResource({ [ENV]: url }, { url: ENV }),
})

const call = (
  name: "plan" | "apply" | "diff",
  input: unknown,
  o: InvokeOptions
): Promise<ToolResult> => invoke(toolByName(name)!, input, o)

const errors = (r: ToolResult) =>
  r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)

const hashOf = async (dir: string): Promise<string> => {
  const compiled = await compile(await readMetadataDir(dir))
  if (compiled.model === undefined)
    throw new Error(JSON.stringify(compiled.diagnostics))
  return compiled.model.hash
}

async function planned(dir: string, url: string): Promise<PlanData> {
  const r = await call("plan", {}, options(dir, url))
  expect(r.refusal).toBeUndefined()
  expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
  expect(r.written).toBe(true)
  return r.data as PlanData
}

const applyCall = (
  dir: string,
  url: string,
  data: PlanData,
  extra: Record<string, unknown>
) =>
  call(
    "apply",
    { plan: data.file, planHash: data.planHash, ...extra },
    options(dir, url)
  )

async function committed(
  dir: string,
  url: string,
  data: PlanData,
  allow: string[] = data.requiredPermissions
): Promise<void> {
  const r = await applyCall(dir, url, data, { allow })
  expect(r.diagnostics, JSON.stringify(r.diagnostics)).toEqual([])
  expect(r.data).toMatchObject({ status: "committed" })
}

/** `plan` над станом, що вже збігається з метаданими: нічого застосовувати. */
async function expectUnchanged(dir: string, url: string): Promise<void> {
  const r = await call("plan", {}, options(dir, url))
  expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
  expect(r.data).toBeUndefined()
  expect(r.artifacts).toEqual([])
  expect(r.diagnostics.map((d) => d.code)).not.toContain("apply.drift")
}

const markerHash = async (url: string) =>
  (
    await rows<{ snapshot_hash: string }>(
      url,
      "select snapshot_hash from simetra.marker"
    )
  )[0]?.snapshot_hash

const ledger = (url: string) =>
  rows<{
    id: string
    from_hash: string | null
    to_hash: string
    allowed: string[]
    drift: { reason: string } | null
  }>(
    url,
    "select id, from_hash, to_hash, allowed, drift from simetra.ledger order by id"
  )

const columnNullable = async (url: string, column: string) =>
  (
    await rows<{ is_nullable: string }>(
      url,
      `select is_nullable from information_schema.columns where table_schema = 'app' and table_name = 'party' and column_name = '${column}'`
    )
  )[0]?.is_nullable

describe("apply lifecycle", () => {
  it("runs plan, apply and diff through chain, rehearsal, data failure, drift and owner swap", async () => {
    await inTarget(async (url) => {
      const dir = await newProject()
      await writeMetadata(dir, party("Party", null))

      // 1. Перше застосування на порожній цілі; після нього diff порожній
      const h1 = await hashOf(dir)
      const first = await planned(dir, url)
      expect(first.fromHash).toBeNull()
      await committed(dir, url, first)
      const diff = await call("diff", {}, options(dir, url))
      expect((diff.data as DiffData).empty).toBe(true)

      // 2. Лише непрофізична зміна: кроків немає, marker пересувається
      await writeMetadata(dir, party("Parties", null))
      const h2 = await hashOf(dir)
      expect(h2).not.toBe(h1)
      const retitled = await planned(dir, url)
      expect(retitled.steps).toEqual([])
      expect(retitled.toHash).toBe(h2)
      expect(retitled.fromHash).toBe(h1)
      await committed(dir, url, retitled)
      expect(await markerHash(url)).toBe(h2)
      await expectUnchanged(dir, url)

      // 3. Новий реквізит: репетиція нічого не лишає, потім справжнє застосування
      await writeMetadata(dir, party("Parties", {}))
      const h3 = await hashOf(dir)
      const added = await planned(dir, url)
      const rehearsal = await applyCall(dir, url, added, {
        allow: added.requiredPermissions,
        rehearse: true,
      })
      expect(rehearsal.diagnostics).toEqual([])
      expect((rehearsal.data as ApplyData).status).toBe("rolledBack")
      expect(await columnNullable(url, "note")).toBeUndefined()
      expect(await markerHash(url)).toBe(h2)
      await committed(dir, url, added)
      expect(await columnNullable(url, "note")).toBe("YES")
      expect(await markerHash(url)).toBe(h3)

      // 4. Збій на даних: NULL у реквізиті, що стає обов'язковим
      await other(
        url,
        "insert into app.party (id) values ('00000000-0000-4000-8000-000000000001')"
      )
      await writeMetadata(dir, party("Parties", { required: true }))
      const strict = await planned(dir, url)
      const notNull = strict.steps.find((s) => /SET NOT NULL/i.test(s.sql))
      expect(notNull?.class).toBe("validationScan")
      const ledgerBefore = await ledger(url)
      const failed = await applyCall(dir, url, strict, {
        allow: strict.requiredPermissions,
      })
      expect(errors(failed)).toEqual(["apply.step-failed"])
      expect(
        failed.diagnostics.find((d) => d.code === "apply.step-failed")?.params
      ).toMatchObject({ step: notNull!.id, sqlstate: "23502" })
      expect(await markerHash(url)).toBe(h3)
      expect(await ledger(url)).toEqual(ledgerBefore)
      expect(await columnNullable(url, "note")).toBe("YES")

      // 5. Ledger: три застосування в порядку id, ланцюжок хешів
      const chain = await ledger(url)
      expect(chain.map((r) => [r.from_hash, r.to_hash])).toEqual([
        [null, h1],
        [h1, h2],
        [h2, h3],
      ])
      const ids = chain.map((r) => BigInt(r.id))
      expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : 1)))

      // 6. Скасування кроку 4: метадані знову дорівнюють стану кроку 3
      await writeMetadata(dir, party("Parties", {}))
      expect(await hashOf(dir)).toBe(h3)
      await expectUnchanged(dir, url)
      await other(url, "delete from app.party")

      // 7. Дрейф у керованій властивості приймається дозволом `drift`
      await other(url, "alter table app.party add column extra int")
      const drifted = await planned(dir, url)
      expect(drifted.drift).not.toBeNull()
      expect(drifted.requiredPermissions[0]).toBe("drift")
      const dropExtra = drifted.steps.find((s) => /DROP COLUMN/i.test(s.sql))
      expect(dropExtra).toBeDefined()
      const ledgerPre = await ledger(url)
      const withoutDrift = await applyCall(dir, url, drifted, {
        allow: drifted.steps
          .filter((s) => drifted.requiredPermissions.includes(s.id))
          .map((s) => s.id),
      })
      expect(errors(withoutDrift)).toEqual(["apply.permission-required"])
      expect(
        withoutDrift.diagnostics.find(
          (d) => d.code === "apply.permission-required"
        )?.params?.items
      ).toBe("drift")
      expect(await columnNullable(url, "extra")).toBe("YES")
      expect(await markerHash(url)).toBe(h3)
      expect(await ledger(url)).toEqual(ledgerPre)

      await committed(dir, url, drifted, drifted.requiredPermissions)
      expect(await columnNullable(url, "extra")).toBeUndefined()
      const accepted = (await ledger(url)).at(-1)
      expect(accepted?.drift).toEqual(drifted.drift)
      // Нова база: прийнятий дрейф лишається лише в ledger
      await expectUnchanged(dir, url)

      // 8. Підміна власника за спиною платформи — відмова з порадою
      // Новий власник мусить мати CREATE на схемі, інакше ALTER OWNER неможливий
      await other(
        url,
        `grant create on schema app to ${OWNER}; alter table app.party owner to ${OWNER};`
      )
      const ledgerAtSwap = await ledger(url)
      const plansDir = join(dirname(dir), "plans")
      const plansBeforeSwap = await readdir(plansDir)
      const swapped = await call("plan", {}, options(dir, url))
      expect(swapped.ok).toBe(false)
      expect(errors(swapped)).toEqual(["plan.owner-mismatch"])
      const mismatch = swapped.diagnostics.find(
        (d) => d.code === "plan.owner-mismatch"
      )
      expect(String(mismatch?.params?.objects)).toContain("app.party")
      expect(String(mismatch?.params?.objects)).toContain(OWNER)
      expect(swapped.written).toBe(false)
      // Відмова не лишає нового файлу плану
      expect(await readdir(plansDir)).toEqual(plansBeforeSwap)
      expect(await markerHash(url)).toBe(h3)
      expect(await ledger(url)).toEqual(ledgerAtSwap)
      // Грант на схему був лише для ALTER OWNER; лишений, він сам став би дрейфом ACL
      await other(
        url,
        `alter table app.party owner to postgres; revoke create on schema app from ${OWNER};`
      )
      await expectUnchanged(dir, url)

      // 9. Змінились обидві версії: план лише з дрейфом, а не відмова
      await other(
        url,
        "update simetra.marker set engine_version = 'other', fingerprint_version = fingerprint_version + 1"
      )
      const versions = await planned(dir, url)
      expect(versions.drift?.reason).toBe("versions-changed")
      expect(versions.steps).toEqual([])
      const warned = await call("plan", {}, options(dir, url))
      expect(warned.diagnostics.map((d) => d.code)).toContain(
        "apply.versions-changed"
      )
      await committed(dir, url, versions, ["drift"])
      await expectUnchanged(dir, url)

      // 10. П'ять рядків; drift лише там, де його приймали
      const all = await ledger(url)
      expect(all).toHaveLength(5)
      expect(all.slice(0, 3).map((r) => r.drift)).toEqual([null, null, null])
      expect(all[3]?.drift).not.toBeNull()
      expect(all[4]?.drift?.reason).toBe("versions-changed")
      expect(all[4]?.from_hash).toBe(all[4]?.to_hash)
    })
  })
})
