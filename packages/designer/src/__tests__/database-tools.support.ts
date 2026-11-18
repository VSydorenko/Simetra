import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect } from "vitest"
import { databaseResource } from "../io/database"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type { InvokeOptions, ToolResult } from "../tools/types"
import type { DiffData } from "../tools/database-tools"
import { compile, platformInstall } from "simetra/compiler"
import { applyStateOwnership, type EngineScope } from "simetra/schema"
import { readMetadataDir } from "../io/metadata-dir"
import { testProvider } from "../../../simetra/test/support"
import { inTarget as loadTarget } from "./support/db"
import { installMismatch, installObjects } from "./support/platform-install"

/**
 * Спільна підготовка тестів `introspect` і `diff` над живою базою
 * (`database-tools.db.test.ts` та його профільні напарники): тека проєкту,
 * ціль із SQL фікстури, виклик інструмента з ресурсом запуску.
 */

export const SIMETRA = resolve(__dirname, "../../../simetra")
export const ENV = "SIMETRA_DATABASE_URL"

const disposers: (() => Promise<void>)[] = []

/** Прибирання після тесту; кличеться на верхньому рівні файлу тестів. */
export function useDatabaseToolsCleanup(): void {
  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((d) => d()))
  })
}

/** Прибирання, що виконається після поточного тесту. */
export const onCleanup = (dispose: () => Promise<void>): void => {
  disposers.push(dispose)
}

/** Корінь проєкту з `node_modules/simetra`; тека метаданих ще не існує. */
export async function freshProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-db-tools-"))
  await mkdir(join(root, "node_modules"))
  await symlink(SIMETRA, join(root, "node_modules", "simetra"), "dir")
  onCleanup(() => rm(root, { recursive: true }))
  return join(root, "metadata")
}

export const scopeOf = (schemas: string[]): EngineScope => ({
  schemas,
  provider: testProvider(),
})

/**
 * Розгортає `sql` у тимчасову базу поруч зі стеком; її прибирає порт.
 * Спільний `inTarget`, де межу задає перелік схем.
 */
export const inTarget = (
  sql: string,
  schemas: string[],
  fn: (url: string) => Promise<void>
): Promise<void> => loadTarget(sql, scopeOf(schemas), fn)

export const options = (
  dir: string,
  env: NodeJS.ProcessEnv,
  shadow?: string
): InvokeOptions => ({
  dir,
  readOnly: false,
  allowDatabaseWrite: false,
  dryRun: false,
  confirmed: false,
  channel: "cli",
  database: databaseResource(env, {
    url: ENV,
    ...(shadow === undefined ? {} : { shadow }),
  }),
})

export const call = (
  name: "introspect" | "diff",
  input: unknown,
  o: InvokeOptions
): Promise<ToolResult> => invoke(toolByName(name)!, input, o)

export const errors = (r: ToolResult) =>
  r.diagnostics.filter((d) => d.severity === "error")

/**
 * Diff of a database without the apply state against the metadata `dir`
 * holds: no errors, and the plan and the differences are exactly the
 * platform install (fork (b) of the outbox: the first apply installs it,
 * `diff` lists that install) — derived by `installObjects` from the compiled
 * empty project, without what the apply state owns. A new platform table or
 * unit changes the expected set by itself; an action or difference outside it
 * is red.
 */
export async function expectOnlyPlatformInstall(
  data: DiffData,
  dir: string
): Promise<void> {
  const compiled = await compile(await readMetadataDir(dir))
  expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  const expected = installObjects(
    await platformInstall(testProvider()),
    applyStateOwnership(compiled.model!).owns
  )
  expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  expect(data.applyState).toBe("absent")
  expect(expected.objects.length).toBeGreaterThan(0)
  expect(installMismatch(data, expected)).toEqual({
    foreignActions: [],
    foreignDifferences: [],
    foreignGrants: [],
    unplanned: [],
    undifferenced: [],
  })
}

export const SHOP = `
  CREATE SCHEMA app;
  CREATE TYPE app.order_status AS ENUM ('new', 'paid');
  CREATE TABLE app.customer (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE app.orders (
    id uuid PRIMARY KEY,
    customer_id uuid NOT NULL REFERENCES app.customer (id),
    status app.order_status NOT NULL,
    total numeric(12, 2)
  );
  CREATE INDEX orders_customer_idx ON app.orders (customer_id);
`

export const introspectInput = {
  schemas: ["app"],
  project: {
    name: "Shop",
    attributeCase: "snake_case",
    database: { provider: testProvider() },
  },
}

/** Ціль SHOP і тека, вже прочитана з неї. */
export async function introspected(
  fn: (dir: string, env: NodeJS.ProcessEnv, url: string) => Promise<void>
): Promise<void> {
  await inTarget(SHOP, ["app"], async (url) => {
    const dir = await freshProject()
    const env = { [ENV]: url }
    const r = await call("introspect", introspectInput, options(dir, env))
    expect(errors(r)).toEqual([])
    expect(r.written).toBe(true)
    await fn(dir, env, url)
  })
}
