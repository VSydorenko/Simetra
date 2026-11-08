import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"

/**
 * Стенд спайку 3 для профілю `postgres`: власний Postgres і Centrifugo в
 * docker з тегом прогону. Спільного DB-стеку не чіпає. Усе, що створено,
 * прибирає `down()` — і на падінні, і на сигналі.
 *
 * Centrifugo — два екземпляри над одним Postgres: споживач outbox з
 * `LISTEN/NOTIFY` (`notify`) і з опитуванням 300 мс (`poll`), щоб виміряти
 * внесок кожного в затримку сигналу.
 */

export type ConsumerMode = "notify" | "poll"

const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

const hostPort = (container: string, port: number) => {
  const out = docker("port", container, `${port}/tcp`).split("\n")[0] ?? ""
  return Number(out.slice(out.lastIndexOf(":") + 1))
}

// Сталий порт хоста: `docker restart` з ефемерним портом міг би дати інший,
// і клієнт Centrifugo не перепідключився б до тієї самої адреси.
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })

export const OBJECT_ID = "0b7c6a52-3a7e-4c1e-9f2a-5d1b8e3c9a01"
export const ZERO = "00000000-0000-0000-0000-000000000000"
export const TOPIC = `simetra:${ZERO}:${ZERO}:${OBJECT_ID}`

const SCHEMA = (table: string) => `
create table if not exists item (
  id uuid primary key,
  name text not null,
  n integer not null,
  version bigint not null default 1
);
create table if not exists ${table} (
  id bigserial primary key,
  method text not null,
  payload jsonb not null,
  partition integer not null default 0,
  created_at timestamptz not null default now()
);
`

const NOTIFY = `
create or replace function outbox_notify() returns trigger language plpgsql as $$
begin
  perform pg_notify('centrifugo_partition_change', new.partition::text);
  return new;
end $$;
drop trigger if exists outbox_notify on outbox_notify;
create trigger outbox_notify after insert on outbox_notify
  for each row execute function outbox_notify();
`

function centrifugoConfig(mode: ConsumerMode, dsn: string) {
  return {
    http_server: { port: 8000 },
    log: { level: "warn" },
    health: { enabled: true },
    client: {
      allow_anonymous_connect_without_token: true,
      allowed_origins: ["*"],
    },
    http_api: { key: "stand-api-key" },
    channel: {
      namespaces: [
        {
          name: "simetra",
          history_size: 1000,
          history_ttl: "300s",
          history_meta_ttl: "3600s",
          force_recovery: true,
          allow_subscribe_for_client: true,
          allow_subscribe_for_anonymous: true,
        },
      ],
    },
    consumers: [
      {
        enabled: true,
        name: `outbox_${mode}`,
        type: "postgresql",
        postgresql: {
          dsn,
          outbox_table_name: `outbox_${mode}`,
          num_partitions: 1,
          ...(mode === "notify"
            ? { partition_notification_channel: "centrifugo_partition_change" }
            : { partition_poll_interval: "300ms" }),
        },
      },
    ],
  }
}

export interface Stand {
  tag: string
  db: pg.Pool
  /** URL websocket Centrifugo для режиму споживача. */
  wsUrl(mode: ConsumerMode): string
  restartCentrifugo(mode: ConsumerMode): Promise<void>
  down(): void
}

async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  ms = 30_000
) {
  const until = Date.now() + ms
  for (;;) {
    try {
      if (await check()) return
    } catch {
      // ще не готовий
    }
    if (Date.now() > until) throw new Error(`stand: ${what} not ready`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

export async function up(): Promise<Stand> {
  const tag = Math.random().toString(36).slice(2, 8).padEnd(6, "0")
  const net = `simetra-spike-${tag}`
  const pgName = `simetra-spike-pg-${tag}`
  const cf = (mode: ConsumerMode) => `simetra-spike-cf-${mode}-${tag}`
  const dir = mkdtempSync(join(tmpdir(), `simetra-spike-${tag}-`))
  const created: string[] = []
  let pool: pg.Pool | undefined
  const down = () => {
    void pool?.end().catch(() => {})
    for (const c of created.reverse()) {
      try {
        if (c.startsWith("net:")) docker("network", "rm", c.slice(4))
        else docker("rm", "-f", "-v", c)
      } catch {
        // уже прибрано
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
  const onSignal = () => {
    down()
    process.exit(130)
  }
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(s, onSignal)
  try {
    docker("network", "create", "--label", `simetra-spike=${tag}`, net)
    created.push(`net:${net}`)
    docker(
      "run",
      "-d",
      "--name",
      pgName,
      "--network",
      net,
      "--label",
      `simetra-spike=${tag}`,
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-p",
      "127.0.0.1::5432",
      "postgres:17"
    )
    created.push(pgName)
    const port = hostPort(pgName, 5432)
    pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
      max: 8,
      application_name: `simetra_spike_${tag}`,
    })
    const db = pool
    await waitFor(
      async () => (await db.query("select 1")).rowCount === 1,
      "postgres"
    )
    for (const mode of ["notify", "poll"] as const)
      await db.query(SCHEMA(`outbox_${mode}`))
    await db.query(NOTIFY)
    const dsn = `postgresql://postgres:postgres@${pgName}:5432/postgres`
    const ports = { notify: await freePort(), poll: await freePort() }
    for (const mode of ["notify", "poll"] as const) {
      writeFileSync(
        join(dir, `${mode}.json`),
        JSON.stringify(centrifugoConfig(mode, dsn))
      )
      docker(
        "run",
        "-d",
        "--name",
        cf(mode),
        "--network",
        net,
        "--label",
        `simetra-spike=${tag}`,
        "-v",
        `${dir}:/cfg:ro`,
        "-p",
        `127.0.0.1:${ports[mode]}:8000`,
        "centrifugo/centrifugo:v6",
        "centrifugo",
        "-c",
        `/cfg/${mode}.json`
      )
      created.push(cf(mode))
    }
    const http = (mode: ConsumerMode) => `http://127.0.0.1:${ports[mode]}`
    for (const mode of ["notify", "poll"] as const)
      await waitFor(
        async () => (await fetch(`${http(mode)}/health`)).ok,
        `centrifugo ${mode}`
      )
    return {
      tag,
      db,
      wsUrl: (mode) => `ws://127.0.0.1:${ports[mode]}/connection/websocket`,
      async restartCentrifugo(mode) {
        docker("restart", "-t", "0", cf(mode))
        await waitFor(
          async () => (await fetch(`${http(mode)}/health`)).ok,
          `centrifugo ${mode}`
        )
      },
      down,
    }
  } catch (error) {
    down()
    throw error
  }
}
