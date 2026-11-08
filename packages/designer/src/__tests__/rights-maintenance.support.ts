import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import pg from "pg"
import { expect } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import { desiredForApply, type RightsMaintenanceRequest } from "simetra/schema"
import { databaseResource } from "../io/database"
import { readMetadataDir } from "../io/metadata-dir"
import { invoke } from "../tools/invoke"
import {
  rightsMaintenanceTool,
  type RightsMaintenanceData,
} from "../tools/rights-maintenance-tool"
import type { ToolResult } from "../tools/types"
import {
  acceptDebt,
  adminRoles,
  memberScopedReferences,
  policyDomain,
} from "../../../simetra/test/support"
import { heldResource, inTarget, query, seedMarker } from "./support/db"

/**
 * Спільна підготовка тестів інструмента обслуговування прав над справжньою
 * базою: проєкт із моделлю прав, ціль із бажаним станом застосування й marker
 * з хешем моделі, запуск інструмента як людиною з `--yes`.
 */

export const SIMETRA = resolve(__dirname, "../../../simetra")
export const ENV = "SIMETRA_DATABASE_URL"
export const ORG = "org"

export interface Env {
  dir: string
  url: string
  model: CompiledModel
}

/** Корінь проєкту з `node_modules/simetra` і текою метаданих моделі файлу. */
export async function writeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-rights-maintenance-"))
  await mkdir(join(root, "node_modules"))
  await symlink(SIMETRA, join(root, "node_modules", "simetra"), "dir")
  const dir = join(root, "metadata")
  const files = await acceptDebt(
    policyDomain(adminRoles(), memberScopedReferences())
  )
  for (const [path, content] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

/**
 * Ціль з бажаним станом застосування й marker з хешем моделі теки: інструмент
 * компілює ту саму теку, тож звірка хешу проходить. Тримається, доки `close`
 * не відпустить колбек `inTarget`. З'єднань до цілі не тримає: копія
 * `TEMPLATE` вимагає цілі без сесій.
 */
export const heldEnv = () =>
  heldResource<Env>(async (use) => {
    const dir = await writeProject()
    try {
      const compiled = await compile(await readMetadataDir(dir))
      expect(compiled.diagnostics).toEqual([])
      const model = compiled.model!
      const desired = await desiredForApply(model)
      await inTarget(desired.sql, desired.scope, async (url) => {
        await asOwner(url, (owner) => seedMarker(owner, model.hash))
        await use({ dir, url, model })
      })
    } finally {
      await rm(dirname(dir), { recursive: true, force: true })
    }
  })

/** Власник бази на час `fn`: сесія закривається й на шляху падіння. */
export async function asOwner<T>(
  url: string,
  fn: (owner: pg.Client) => Promise<T>
): Promise<T> {
  const owner = new pg.Client({ connectionString: url })
  await owner.connect()
  try {
    return await fn(owner)
  } finally {
    await owner.end()
  }
}

/** Інструмент так, як його запускає людина з `--yes`. */
export const maintain = (
  dir: string,
  url: string,
  request: RightsMaintenanceRequest
) =>
  invoke(rightsMaintenanceTool, request, {
    dir,
    readOnly: false,
    allowDatabaseWrite: true,
    dryRun: false,
    confirmed: true,
    channel: "cli",
    database: databaseResource({ [ENV]: url }, { url: ENV }),
  })

/** Відмова інструмента — код і параметри першої діагностики. */
export const refusalOf = (r: ToolResult) => {
  expect(r.ok, JSON.stringify(r.diagnostics)).toBe(false)
  const [d] = r.diagnostics
  return { code: d?.code, params: d?.params }
}

export const doneOf = (r: ToolResult): RightsMaintenanceData => {
  expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
  return r.data as RightsMaintenanceData
}

export const countOf = async (
  url: string,
  sql: string,
  params: unknown[] = []
) =>
  Number(
    (
      await query<{ n: string }>(
        url,
        `SELECT count(*) AS n FROM ${sql}`,
        params
      )
    )[0]!.n
  )

/** Записи журналу прав про рядок `row`. */
export const journalOf = (url: string, row: string) =>
  query(
    url,
    "SELECT actor, reason, action FROM simetra.rights_journal WHERE row_id = $1",
    [row]
  )

export const globalAssignments = (url: string) =>
  countOf(url, "public.global_role_assignments")
