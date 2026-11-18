import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { EngineScope } from "simetra/schema"
import { afterEach, expect } from "vitest"
import { databaseResource } from "../io/database"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type { InvokeOptions, ToolResult } from "../tools/types"
import type { DiffData } from "../tools/database-tools"
import { PLATFORM_ROLES, SIGNAL_OUTBOX } from "simetra/model"
import { testProvider } from "../../../simetra/test/support"
import { inTarget as loadTarget } from "./support/db"

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
 * Diff of a database without the apply state against its own introspected
 * metadata: the one difference is the signal outbox, which every project has
 * and the first apply creates (postgres profile spec §5.1) — its table, units
 * and the consumer's grants, and nothing else.
 */
export function expectOnlyOutbox(data: DiffData): void {
  // Ім'я таблиці, її послідовності й функцій — у лапках чи без них
  const name = new RegExp(
    `"?${SIGNAL_OUTBOX.schema}"?\\."?${SIGNAL_OUTBOX.name}`
  )
  const outbox = (text: string) =>
    name.test(text) || text.includes(PLATFORM_ROLES.signalConsumer)
  expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  expect(data.applyState).toBe("absent")
  expect(data.plan.length).toBeGreaterThan(0)
  expect(data.plan.map((a) => a.sql).filter((sql) => !outbox(sql))).toEqual([])
  expect(
    data.differences.map((d) => d.path).filter((path) => !outbox(path))
  ).toEqual([])
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
