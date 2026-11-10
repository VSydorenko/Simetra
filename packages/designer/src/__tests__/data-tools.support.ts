import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import pg from "pg"
import { expect } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  type DatabaseProvider,
  type MetadataRef,
  type Operation,
} from "simetra/model"
import { readRoleOf } from "simetra/server"
import {
  DATA_GUARD_FACTS_SQL,
  dataGuardFactsParams,
  dataResource,
} from "../io/data"
import { readMetadataDir } from "../io/metadata-dir"
import { dataCommandTool, dataReadTool } from "../tools/data-tools"
import { invoke } from "../tools/invoke"
import type { Tool } from "../tools/types"
import {
  GAUGE_LOG_FILE,
  GAUGE_LOG_TABLE,
  GAUGE_TABLE,
  acceptDebt,
  policyDomain,
  profileLayer,
  runtimeValuesLayer,
  testProvider,
} from "../../../simetra/test/support"
import { withObjectModule } from "./helpers/object-module"
import {
  heldResource,
  query,
  seedMarker,
  seedRuntimeActor,
  withModelTarget,
  withRuntimeLogin,
  type RuntimeActor,
} from "./support/db"

/**
 * Спільна підготовка тестів інструментів даних (`data-tools.db.test.ts` та
 * його профільні напарники): ціль із моделлю й засівом, роль входу у формі
 * `simetra_runtime`, виклик інструмента каналом MCP, факти запобіжника.
 */

export const ENV = "APP_DATA"
export const GAUGE: MetadataRef = { kind: "Catalog", name: "Gauge" }
export const GAUGE_LOG: MetadataRef = { kind: "Catalog", name: "GaugeLog" }
export const ASSIGNMENTS: MetadataRef = {
  kind: "Catalog",
  name: "OrgRoleAssignments",
}

export const REQUEST_ROLE = readRoleOf(testProvider())!

export interface Env {
  dir: string
  model: CompiledModel
  provider: DatabaseProvider
  /** Ціль від імені мігратора (власник схеми `simetra`). */
  url: string
  owner: pg.Client
  /** Роль входу у формі `simetra_runtime`: роль команд і роль запиту. */
  login: string
  me: RuntimeActor
  other: RuntimeActor
  /** Рядки `Gauge` кожного актора й `GaugeLog` організації `me`. */
  mine: string
  foreign: string
  log: string
}

/** Корінь проєкту з текою метаданих; `GaugeLog` — об'єкт із модулем. */
async function writeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-data-tools-"))
  const dir = join(root, "metadata")
  const files = await acceptDebt(
    withObjectModule(
      policyDomain(runtimeValuesLayer(), profileLayer()),
      GAUGE_LOG_FILE
    )
  )
  for (const [path, content] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

async function seedRow(
  owner: pg.Client,
  table: string,
  org: string
): Promise<string> {
  const id = randomUUID()
  await owner.query(
    `INSERT INTO public.${table} (id, org_id) VALUES ($1, $2)`,
    [id, org]
  )
  return id
}

export const heldEnv = () =>
  heldResource<Env>(async (use) => {
    const dir = await writeProject()
    try {
      const compiled = await compile(await readMetadataDir(dir))
      expect(compiled.diagnostics).toEqual([])
      const model = compiled.model!
      // Фікстура має те, на чому стоять кейси 8 і 9
      expect(model.objects.map((o) => o.name)).toContain(ASSIGNMENTS.name)
      expect(model.moduleFiles).toHaveLength(1)
      await withModelTarget(model, async (url) => {
        const owner = new pg.Client({ connectionString: url })
        await owner.connect()
        try {
          await seedMarker(owner, model.hash)
          const me = await seedRuntimeActor(owner)
          const other = await seedRuntimeActor(owner)
          const mine = await seedRow(owner, GAUGE_TABLE, me.org)
          const foreign = await seedRow(owner, GAUGE_TABLE, other.org)
          const log = await seedRow(owner, GAUGE_LOG_TABLE, me.org)
          await withRuntimeLogin(
            url,
            [PLATFORM_ROLES.command, REQUEST_ROLE],
            (login) =>
              use({
                dir,
                model,
                provider: model.project.database.provider,
                url,
                owner,
                login,
                me,
                other,
                mine,
                foreign,
                log,
              })
          )
        } finally {
          await owner.end()
        }
      })
    } finally {
      await rm(dirname(dir), { recursive: true, force: true })
    }
  })

export interface GuardFacts {
  rolsuper: boolean
  rolbypassrls: boolean
  command: boolean
  migrator: boolean
  service: boolean
}

/** Порушення фактів ролі входу — те, за що запобіжник відмовляє. */
export const violations = (f: GuardFacts): string[] =>
  Object.entries({
    rolsuper: f.rolsuper,
    rolbypassrls: f.rolbypassrls,
    migrator: f.migrator,
    service: f.service,
    "no-command": !f.command,
  })
    .filter(([, v]) => v)
    .map(([k]) => k)

export const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`

/** Помічники, що читають ціль у момент виклику: `env` задає `beforeAll` файлу. */
export function dataToolsHelpers(env: () => Env) {
  /** Виклик через MCP-канал, як його робить агент. */
  const call = (
    tool: Tool,
    input: unknown,
    o: {
      url?: string
      as?: string
      agent?: string
      allowDataWrite?: boolean
      allowRightsWrite?: boolean
    } = {}
  ) =>
    invoke(tool, input, {
      dir: env().dir,
      readOnly: false,
      allowDatabaseWrite: false,
      allowDataWrite: o.allowDataWrite ?? true,
      allowRightsWrite: o.allowRightsWrite ?? false,
      dryRun: false,
      confirmed: false,
      channel: "mcp",
      data: dataResource(
        { [ENV]: o.url ?? env().login },
        {
          urlEnv: ENV,
          as: o.as ?? env().me.user,
          ...(o.agent === undefined ? {} : { agent: o.agent }),
        }
      ),
      dataEnv: ENV,
    })

  const readGauges = (o: Parameters<typeof call>[2] = {}) =>
    call(dataReadTool, { query: { object: GAUGE, limit: 200 } }, o)

  const command = (
    operations: Operation[],
    o: Parameters<typeof call>[2] = {}
  ) => call(dataCommandTool, { operations }, o)

  /** Версія рядка — читанням власника, повз інструмент. */
  const versionOf = async (table: string, id: string): Promise<number> =>
    (
      await env().owner.query<{ version: number }>(
        `SELECT version::int AS version FROM public.${table} WHERE id = $1`,
        [id]
      )
    ).rows[0]!.version

  const factsAs = async (loginUrl: string): Promise<GuardFacts> =>
    (
      await query<GuardFacts>(
        loginUrl,
        DATA_GUARD_FACTS_SQL,
        dataGuardFactsParams(env().provider)
      )
    )[0]!

  return { call, readGauges, command, versionOf, factsAs }
}
