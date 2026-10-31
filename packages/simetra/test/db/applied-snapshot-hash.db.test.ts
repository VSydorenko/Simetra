import { describe, expect, it } from "vitest"
import type pg from "pg"
import { compile, type CompiledModel } from "simetra/compiler"
import { PLATFORM_ROLES } from "simetra/model"
import { renderApplyState, renderDesiredState } from "simetra/schema"
import {
  catalog,
  metaFiles,
  project,
} from "../../src/compiler/__tests__/helpers"
import { commandAs, queryAs, withRollback } from "./connection"

/**
 * Звірка хешу знімка рантаймом (рішення Р-A3-12, Р-A3-16): роль команд
 * читає хеш лише через `simetra.applied_snapshot_hash()`. Чи дає грант
 * `EXECUTE` і чи читає `SECURITY DEFINER` marker без гранту таблиці, вирішує
 * Postgres — текст рендеру цього не доводить. Обидві форми безпеки схеми:
 * від стану застосування (без «Користувачів») і від платформного шару.
 */

const MODELS: [string, Record<string, unknown>][] = [
  [
    "without the platform layer",
    { "catalogs/Party/Party.meta.json": catalog("Party") },
  ],
  [
    "with the platform layer",
    {
      "catalogs/Users/Users.meta.json": catalog("Users", {
        role: "users",
        scope: "none",
      }),
    },
  ],
]

async function model(files: Record<string, unknown>): Promise<CompiledModel> {
  const result = await compile(
    metaFiles({ "project.meta.json": project(), ...files })
  )
  expect(result.diagnostics).toEqual([])
  return result.model!
}

async function deploy(client: pg.Client, m: CompiledModel): Promise<void> {
  await client.query(`${renderDesiredState(m).sql}\n\n${renderApplyState(m)}`)
  // Членство з `SET` — як у рантайму, що перемикається `SET LOCAL ROLE`
  await client.query(
    `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
  )
}

const HASH = "snapshot-hash-a"
const READ = "SELECT simetra.applied_snapshot_hash() AS hash"

describe.each(MODELS)("applied_snapshot_hash %s", (_, files) => {
  it("returns the recorded hash to the command role, NULL before the first apply", async () => {
    const m = await model(files)
    await withRollback(async (client) => {
      await deploy(client, m)
      expect(await commandAs(client, {}, undefined, READ)).toEqual({
        rows: [{ hash: null }],
      })
      await client.query(
        `INSERT INTO simetra.marker (format, snapshot_hash, snapshot, scope, catalog, engine_name, engine_version, fingerprint, fingerprint_version, platform_version, plan_hash)
         VALUES (1, $1, '{}', '{}', '{}', 'engine', '1', '{}', 1, '0', 'plan')`,
        [HASH]
      )
      expect(await commandAs(client, {}, undefined, READ)).toEqual({
        rows: [{ hash: HASH }],
      })
      // Без `SECURITY DEFINER` роль команд marker не прочитала б
      expect(
        await commandAs(
          client,
          {},
          undefined,
          "SELECT snapshot_hash FROM simetra.marker"
        )
      ).toMatchObject({ code: "42501" })
    })
  })

  it("refuses the API role", async () => {
    const m = await model(files)
    await withRollback(async (client) => {
      await deploy(client, m)
      expect(
        await queryAs(client, "authenticated", { role: "authenticated" }, READ)
      ).toEqual({ code: "42501" })
    })
  })
})
