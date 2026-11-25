// Кроки бази розробника, спільні для `db-setup.mjs` і фікстури e2e: міграція
// Better Auth від `simetra_auth` і `simetra plan` / `apply` від `simetra_owner`.
// Крок `simetra roles` сюди не входить: його робить лише `db-setup.mjs`, а
// фікстура на спільному стеку замінює його власним (там логіни Simetra мають
// `CONNECT` до інших баз, і `roles` відмовляє, `roles.shared-cluster`).
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { getMigrations } from "better-auth/db/migration"
import pg from "pg"
import config from "../simetra.config.ts"
import { authSchemaOptions, withAuthOptions } from "./auth-options.mjs"

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Запускає `simetra <args>` з DSN у змінній `SIMETRA_DATABASE_URL` (argv видно
 * в `ps`); вивід — у винятку, коли команда не вдалась.
 */
export function runSimetra(args, databaseUrl) {
  const designer = dirname(
    createRequire(import.meta.url).resolve("@simetrajs/designer/package.json")
  )
  const result = spawnSync(
    process.execPath,
    [join(designer, "bin/simetra.mjs"), ...args],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, SIMETRA_DATABASE_URL: databaseUrl },
    }
  )
  if (result.status !== 0) {
    throw new Error(
      `simetra ${args[0]} failed\n${result.stdout}${result.stderr}`
    )
  }
  return result.stdout
}

async function migrateBetterAuth(authUrl, { origin, secret }) {
  const pool = new pg.Pool({
    connectionString: withAuthOptions(authUrl),
    max: 1,
  })
  try {
    const { runMigrations } = await getMigrations(
      authSchemaOptions(pool, { origin, secret })
    )
    await runMigrations()
  } finally {
    await pool.end()
  }
}

/**
 * Таблиці сервера авторизації агентів (спека П4-F §5.4, Р-F4-3). Схему
 * `agent_oauth` створює кластер профілю з власником `simetra_auth`, тож тут
 * лише таблиці від цієї ролі: `CREATE SCHEMA IF NOT EXISTS` вимагав би
 * `CREATE` на базу. Строкових типових значень немає: усі строки ставить
 * годинник JS (Р-F4-11). Ідемпотентно.
 */
export const AGENT_OAUTH_DDL = `
CREATE TABLE IF NOT EXISTS agent_oauth.models (
  model       text        NOT NULL,
  id_hash     text        NOT NULL,
  grant_id    text,
  uid         text,
  payload     jsonb       NOT NULL,
  consumed_at timestamptz,
  expires_at  timestamptz,
  PRIMARY KEY (model, id_hash)
);
CREATE INDEX IF NOT EXISTS models_grant_id ON agent_oauth.models (grant_id);
CREATE INDEX IF NOT EXISTS models_uid ON agent_oauth.models (uid);
CREATE TABLE IF NOT EXISTS agent_oauth.agent_grants (
  grant_id     text        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES better_auth."user" (id) ON DELETE CASCADE,
  client_id    text        NOT NULL,
  tenant       uuid,
  created_at   timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS agent_grants_user_id ON agent_oauth.agent_grants (user_id);
`

/** Крок DDL `agent_oauth` від `simetra_auth`; після міграції Better Auth (FK на `user`). */
export async function migrateAgentOauth(authUrl) {
  const client = new pg.Client({ connectionString: authUrl })
  await client.connect()
  try {
    await client.query(AGENT_OAUTH_DDL)
  } finally {
    await client.end()
  }
}

/**
 * Порядок кроків: `beforeMigration` (ролі й схема `better_auth`) → міграція
 * Better Auth → таблиці `agent_oauth` → `afterMigration` (гранти власнику на таблицю ідентичності) →
 * `plan` і `apply` від власника. Повертає шлях застосованого плану чи
 * `undefined`, коли база вже збігається з метаданими.
 */
export async function runDbSetup({
  authUrl,
  ownerUrl,
  beforeMigration,
  afterMigration,
  origin = "http://localhost:3000",
  secret,
}) {
  await beforeMigration()
  await migrateBetterAuth(authUrl, { origin, secret })
  await migrateAgentOauth(authUrl)
  await afterMigration()
  const planned = JSON.parse(
    runSimetra(["plan", config.metadataDir, "--format=json"], ownerUrl)
  )
  if (planned.planHash === undefined || planned.file === undefined)
    return undefined
  runSimetra(
    [
      "apply",
      planned.file,
      config.metadataDir,
      `--plan-hash=${planned.planHash}`,
      // `apply` — руйнівний інструмент, і без підтвердження CLI відмовляє;
      // рішення — за людиною, що запустила `db-setup`
      "--yes",
    ],
    ownerUrl
  )
  return planned.file
}
