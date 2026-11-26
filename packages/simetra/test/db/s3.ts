// S3-клієнт тестів для обох стеків. Garage — фіксований dev-ключ стека
// postgres; Supabase — значення одного `supabase status -o env` пришитого
// CLI, яке globalSetup кладе в env прогону. Env, а не лише vitest `provide`:
// прибиральник на сигналі — окремий процес поза vitest і успадковує лише env.
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { S3 } from "@aws-sdk/client-s3"
import {
  devSecret,
  profileStack,
  type TestProvider,
  type TestStack,
} from "./profile"

/**
 * The slice of the aggregate `S3` client that tests and the run-bucket
 * cleaner use; the production `fromS3Client` takes a subset of it.
 */
export type S3ClientLike = Pick<
  S3,
  | "putObject"
  | "getObject"
  | "deleteObject"
  | "listObjectsV2"
  | "deleteObjects"
  | "createBucket"
  | "deleteBucket"
>

/** Env var with the Supabase S3 values (JSON of {@link S3Config}). */
export const SUPABASE_S3_ENV = "SIMETRA_TEST_SUPABASE_S3"

export interface S3Config {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

/** Access key id of the Garage dev key (the bucket gets it via `AllowBucketKey`). */
export function garageDevKeyId(): string {
  return devSecret("GARAGE_DEV_KEY_ID")
}

/**
 * Picks the S3 values out of the output of `supabase status -o env`. Throws
 * naming what is missing: a guess would send keys to a wrong endpoint.
 */
export function parseSupabaseS3(text: string): S3Config {
  const env = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim())
    if (m !== null) env.set(m[1]!, m[2]!)
  }
  // Адресу не виводимо з `API_URL`: вгадана адреса послала б ключі не туди
  const endpoint = env.get("STORAGE_S3_URL")
  const accessKeyId = env.get("S3_PROTOCOL_ACCESS_KEY_ID")
  const secretAccessKey = env.get("S3_PROTOCOL_ACCESS_KEY_SECRET")
  if (
    endpoint === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  )
    throw new Error(
      "`supabase status -o env` has no S3 values (need S3_PROTOCOL_ACCESS_KEY_ID, S3_PROTOCOL_ACCESS_KEY_SECRET and STORAGE_S3_URL): is [storage.s3_protocol] enabled and the stack running?"
    )
  return {
    endpoint,
    // CLI друкує регіон не завжди; локальний Storage підписує запити з
    // регіоном `local`, тож типове значення — не здогад, а налаштування стека
    region: env.get("S3_PROTOCOL_REGION") ?? "local",
    accessKeyId,
    secretAccessKey,
  }
}

/**
 * One `supabase status -o env` of the pinned CLI, put into the env of the run
 * so workers and the interrupt cleaner inherit it. Called by the Supabase
 * guard setup; nothing else runs the CLI during a run.
 */
export function provideSupabaseS3(): S3Config {
  const out = execFileSync(
    "pnpm",
    ["exec", "supabase", "status", "-o", "env"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
    }
  )
  const config = parseSupabaseS3(out)
  process.env[SUPABASE_S3_ENV] = JSON.stringify(config)
  return config
}

function supabaseS3(): S3Config {
  const raw = process.env[SUPABASE_S3_ENV]
  // Прибиральник, запущений людиною без прогону, бере значення сам
  return raw === undefined || raw === ""
    ? provideSupabaseS3()
    : (JSON.parse(raw) as S3Config)
}

/**
 * The S3 config of a stack (or of the stack of profile `p`, computed now).
 * The Garage address comes from the stack, never from a constant.
 */
export function s3ConfigOf(target: TestStack | TestProvider): S3Config {
  const stack = typeof target === "string" ? profileStack(target) : target
  return stack.garageS3Url !== null
    ? {
        endpoint: stack.garageS3Url,
        region: "garage",
        accessKeyId: garageDevKeyId(),
        secretAccessKey: devSecret("GARAGE_DEV_KEY_SECRET"),
      }
    : supabaseS3()
}

/**
 * S3 client of a test stack: Garage (the S3 port of the stack index, region
 * `garage`, the dev key) or Supabase Storage (values of the guard's `supabase status`).
 * Path-style: neither stack resolves bucket subdomains.
 */
export function s3Of(stack: TestStack | TestProvider): S3ClientLike {
  const c = s3ConfigOf(stack)
  return new S3({
    endpoint: c.endpoint,
    region: c.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
    },
  })
}
