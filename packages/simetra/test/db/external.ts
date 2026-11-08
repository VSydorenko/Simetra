// Зовнішні ресурси DB-прогону поза Postgres: контейнери docker з міткою тегу
// і бакети Garage `run-<тег>`. Сторож бачить їх так само, як бази й ролі, а
// прибиральник перерваного прогону видаляє в межах свого дедлайну. Docker і
// мережа приходять параметрами: юніт-тести підставляють їх, а прогін і
// прибиральник — справжні.
import { execFile } from "node:child_process"
import { isRunTag } from "./connection"
import {
  garageAdminToken,
  TEST_STACKS,
  type TestProvider,
  type TestStack,
} from "./profile"

/** Runs `file` with `args` (no shell) and resolves with its stdout. */
export type Exec = (
  file: string,
  args: readonly string[],
  opts: { timeoutMs: number }
) => Promise<string>

export type Fetch = typeof fetch

const RUN_LABEL = "simetra-run"
const STACK_LABEL = "simetra-stack"
// Docker і адмінка Garage локальні: виклик, що довший за це, — завислий
// демон, і прогін краще впаде, ніж чекатиме
const CALL_TIMEOUT_MS = 10_000

export const nodeExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: opts.timeoutMs, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout)
        else
          reject(
            new Error(
              `${file} ${args.join(" ")}: ${stderr.trim() || error.message}`
            )
          )
      }
    )
  })

/** The Garage bucket of run `tag`: its global alias. */
export function runBucketName(tag: string): string {
  return `run-${tag}`
}

/**
 * Creates the bucket of run `tag` (global alias `run-<tag>`) through the
 * Garage admin API and returns its id.
 */
export async function createRunBucket(
  tag: string,
  stack: TestStack,
  fetch: Fetch
): Promise<string> {
  const created = await garage(stack, fetch, CALL_TIMEOUT_MS, "CreateBucket", {
    body: { globalAlias: runBucketName(tag) },
  })
  const id = isRecord(created) ? created.id : undefined
  if (typeof id !== "string")
    throw new Error("Garage admin API CreateBucket: no bucket id in the answer")
  return id
}

/**
 * Every container of profile `p` that carries a run label, with its tag. A
 * container without a tag value is not a run's and is skipped. Throws when
 * docker fails: an empty list then would hide a leak.
 */
export function runContainers(
  p: TestProvider,
  exec: Exec
): Promise<{ name: string; tag: string }[]> {
  return listContainers(p, exec, CALL_TIMEOUT_MS)
}

async function listContainers(
  p: TestProvider,
  exec: Exec,
  timeoutMs: number
): Promise<{ name: string; tag: string }[]> {
  // Фільтр за стеком — у docker: контейнер прогону іншого стека не є витоком
  // цього, навіть коли обидва прогони йдуть одночасно
  const out = await exec(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=${RUN_LABEL}`,
      "--filter",
      `label=${STACK_LABEL}=${p}`,
      "--format",
      `{{.Names}}\t{{.Label "${RUN_LABEL}"}}`,
    ],
    { timeoutMs }
  )
  return out.split("\n").flatMap((line) => {
    const [name = "", tag = ""] = line.trim().split("\t")
    return name !== "" && tag !== "" ? [{ name, tag }] : []
  })
}

/**
 * Every Garage bucket of the stack whose global alias is `run-<tag>`, with
 * its object count. `[]` on a stack without Garage. Throws when the admin API
 * fails: an empty list then would hide a leak.
 */
export async function runBuckets(
  stack: TestStack,
  fetch: Fetch,
  timeoutMs: number
): Promise<{ id: string; name: string; tag: string; objects: number }[]> {
  const buckets = []
  for (const bucket of await listRunBuckets(stack, fetch, timeoutMs))
    buckets.push({
      ...bucket,
      objects: await bucketObjects(stack, fetch, timeoutMs, bucket.id),
    })
  return buckets
}

async function listRunBuckets(
  stack: TestStack,
  fetch: Fetch,
  timeoutMs: number
): Promise<{ id: string; name: string; tag: string }[]> {
  if (stack.garageAdminUrl === null) return []
  const list = await garage(stack, fetch, timeoutMs, "ListBuckets")
  if (!Array.isArray(list))
    throw new Error("Garage admin API ListBuckets: the answer is not a list")
  return list.flatMap((bucket: unknown) => {
    if (!isRecord(bucket) || typeof bucket.id !== "string") return []
    const id = bucket.id
    const aliases = Array.isArray(bucket.globalAliases)
      ? bucket.globalAliases
      : []
    return aliases.flatMap((alias: unknown) => {
      if (typeof alias !== "string" || !alias.startsWith("run-")) return []
      const tag = alias.slice("run-".length)
      return isRunTag(tag) ? [{ id, name: alias, tag }] : []
    })
  })
}

async function bucketObjects(
  stack: TestStack,
  fetch: Fetch,
  timeoutMs: number,
  id: string
): Promise<number> {
  const info = await garage(stack, fetch, timeoutMs, "GetBucketInfo", {
    query: { id },
  })
  const objects = isRecord(info) ? info.objects : undefined
  if (typeof objects !== "number")
    throw new Error(
      `Garage admin API GetBucketInfo ${id}: no object count in the answer`
    )
  return objects
}

/**
 * Removes the containers of run `tag` on the stack of profile `p`
 * (`docker rm -f -v`) and its empty buckets; a bucket with objects is left
 * (emptying it comes with the first writer of bytes). Never throws and never
 * runs past `deadlineMs`: what it could not remove or check is in `left`, and
 * the commands to finish it by hand are in `cleanup`.
 */
export async function removeRunResources(
  tag: string,
  p: TestProvider,
  deps: { exec: Exec; fetch: Fetch; deadlineMs: number }
): Promise<{ removed: string[]; left: string[]; cleanup: string[] }> {
  const deadline = Date.now() + deps.deadlineMs
  // Кожен виклик обмежений рештою дедлайну: прибиральник у обробнику сигналу
  // має власну межу, і завислий docker чи Garage не мусить її з'їсти
  const budget = (): number =>
    Math.max(1, Math.min(CALL_TIMEOUT_MS, deadline - Date.now()))
  const removed: string[] = []
  const left: string[] = []
  const cleanup: string[] = []
  const bucketName = runBucketName(tag)
  const emptyAndDelete = (bucket: string): string =>
    `bucket ${bucket}: empty and delete in Garage`
  const reason = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

  try {
    const containers = (await listContainers(p, deps.exec, budget())).filter(
      (c) => c.tag === tag
    )
    for (const { name } of containers)
      try {
        await deps.exec("docker", ["rm", "-f", "-v", name], {
          timeoutMs: budget(),
        })
        removed.push(`container ${name}`)
      } catch (error) {
        left.push(`container ${name} (${reason(error)})`)
        cleanup.push(`docker rm -f -v ${name}`)
      }
  } catch (error) {
    left.push(`containers of run ${tag} (not checked: ${reason(error)})`)
    cleanup.push(
      `docker ps -a --filter label=${RUN_LABEL}=${tag} --filter label=${STACK_LABEL}=${p}  # then docker rm -f -v each`
    )
  }

  const stack = TEST_STACKS[p]
  // Без Garage на стеку бакетів немає — і файла секретів не читаємо
  if (stack.garageAdminUrl === null) return { removed, left, cleanup }
  let buckets: { id: string; name: string }[]
  try {
    buckets = (await listRunBuckets(stack, deps.fetch, budget())).filter(
      (b) => b.tag === tag
    )
  } catch (error) {
    // Ім'я бакета виводиться з тегу: людина знає, що перевірити
    left.push(`bucket ${bucketName} (not checked: ${reason(error)})`)
    cleanup.push(emptyAndDelete(bucketName))
    return { removed, left, cleanup }
  }
  for (const bucket of buckets)
    try {
      const objects = await bucketObjects(
        stack,
        deps.fetch,
        budget(),
        bucket.id
      )
      if (objects > 0) {
        left.push(`bucket ${bucket.name} (${objects} object(s))`)
        cleanup.push(emptyAndDelete(bucket.name))
        continue
      }
      await garage(stack, deps.fetch, budget(), "DeleteBucket", {
        query: { id: bucket.id },
      })
      removed.push(`bucket ${bucket.name}`)
    } catch (error) {
      left.push(`bucket ${bucket.name} (${reason(error)})`)
      cleanup.push(emptyAndDelete(bucket.name))
    }
  return { removed, left, cleanup }
}

/** One admin API v2 call: `GET` without a body, `POST` with one or for a delete. */
async function garage(
  stack: TestStack,
  fetch: Fetch,
  timeoutMs: number,
  endpoint: "ListBuckets" | "GetBucketInfo" | "CreateBucket" | "DeleteBucket",
  o: { query?: Record<string, string>; body?: unknown } = {}
): Promise<unknown> {
  if (stack.garageAdminUrl === null)
    throw new Error("This stack has no Garage admin API")
  const url = new URL(`/v2/${endpoint}`, stack.garageAdminUrl)
  for (const [key, value] of Object.entries(o.query ?? {}))
    url.searchParams.set(key, value)
  const write = endpoint === "CreateBucket" || endpoint === "DeleteBucket"
  const response = await fetch(url, {
    method: write ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${garageAdminToken()}`,
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok)
    throw new Error(
      `Garage admin API ${endpoint}: HTTP ${response.status} ${text.slice(0, 200)}`
    )
  return text === "" ? null : (JSON.parse(text) as unknown)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
