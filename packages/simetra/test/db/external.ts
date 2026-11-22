// Зовнішні ресурси DB-прогону поза Postgres: контейнери docker з міткою тегу
// і бакети `run-<тег>` (Garage на postgres, Supabase Storage на supabase).
// Сторож бачить їх так само, як бази й ролі, а прибиральник перерваного
// прогону видаляє порожні з них у межах свого дедлайну. Docker і
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
import { garageDevKeyId, s3Of, type S3ClientLike } from "./s3"

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

/**
 * `docker run` label args of a container of run `tag` on the stack of
 * profile `p`: the guard sees and removes a container only by both labels.
 */
export function runContainerLabels(tag: string, p: TestProvider): string[] {
  return ["--label", `${RUN_LABEL}=${tag}`, "--label", `${STACK_LABEL}=${p}`]
}

/** The Garage bucket of run `tag`: its global alias. */
export function runBucketName(tag: string): string {
  return `run-${tag}`
}

/**
 * Creates the bucket of run `tag` (global alias `run-<tag>`) through the
 * Garage admin API, lets the dev key read and write it (a new bucket has no
 * key, so S3 calls would be refused) and returns its id.
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
  await garage(stack, fetch, CALL_TIMEOUT_MS, "AllowBucketKey", {
    body: {
      bucketId: id,
      accessKeyId: garageDevKeyId(),
      permissions: { read: true, write: true, owner: false },
    },
  })
  return id
}

// Бакет адресується іменем `run-<тег>`: порожній чи кривий тег дав би
// `run-` або чужий бакет, тож без перевірки на Supabase нічого б не завадило
function checkTag(tag: string): void {
  if (!isRunTag(tag)) throw new Error(`"${tag}" is not a run tag`)
}

function isNoSuchBucket(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === "NoSuchBucket" || e?.$metadata?.httpStatusCode === 404
}

/**
 * Deletes the bucket `run-<tag>` that the caller created and already emptied
 * itself (a test's own teardown: the guard only reports a bucket at the end of
 * a normal run). The stack refuses a non-empty bucket, so nothing is deleted
 * that the caller left. Same addressing as {@link removeEmptyRunBucket}: the
 * name is exactly {@link runBucketName} of `tag`. `false` when it is not there.
 */
export async function deleteRunBucket(
  tag: string,
  stack: TestStack,
  deps: { fetch: Fetch; s3?: S3ClientLike; timeoutMs?: number }
): Promise<boolean> {
  checkTag(tag)
  const deadline = Date.now() + (deps.timeoutMs ?? 30_000)
  const budget = (): number => {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error("the cleanup deadline ran out")
    return Math.min(CALL_TIMEOUT_MS, left)
  }
  if (stack.garageAdminUrl !== null) {
    const id = (await listRunBuckets(stack, deps.fetch, budget())).find(
      (b) => b.tag === tag
    )?.id
    if (id === undefined) return false
    await garage(stack, deps.fetch, budget(), "DeleteBucket", {
      query: { id },
    })
    return true
  }
  try {
    await (deps.s3 ?? s3Of(stack)).deleteBucket(
      { Bucket: runBucketName(tag) },
      { abortSignal: AbortSignal.timeout(budget()) }
    )
    return true
  } catch (error) {
    if (isNoSuchBucket(error)) return false
    throw error
  }
}

/**
 * Deletes the bucket `run-<tag>` when it is EMPTY: Garage through the admin
 * API (its alias goes with it), Supabase through S3. A bucket with objects is
 * left as it is and reported (`non-empty`, with the count when the stack
 * tells it): bytes of a test are not the cleaner's to delete (AGENTS.md); the
 * test removes its own through the API. The name is exactly
 * {@link runBucketName} of `tag`: never chosen by a prefix, never another
 * run's or a dev bucket. `absent` when the bucket is not there (on Garage: not
 * in the admin API). Throws when any call fails or `timeoutMs` runs out; the
 * bucket then stays as it was left.
 */
export async function removeEmptyRunBucket(
  tag: string,
  stack: TestStack,
  deps: { fetch: Fetch; s3?: S3ClientLike; timeoutMs?: number }
): Promise<
  | { status: "removed" | "absent" }
  | { status: "non-empty"; objects: number | undefined }
> {
  checkTag(tag)
  const deadline = Date.now() + (deps.timeoutMs ?? 30_000)
  const budget = (): number => {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error("the cleanup deadline ran out")
    return Math.min(CALL_TIMEOUT_MS, left)
  }
  const bucket = runBucketName(tag)
  if (stack.garageAdminUrl !== null) {
    // Бакета без псевдоніма в адмінці немає — S3 не питаємо
    const id = (await listRunBuckets(stack, deps.fetch, budget())).find(
      (b) => b.tag === tag
    )?.id
    if (id === undefined) return { status: "absent" }
    const objects = await bucketObjects(stack, deps.fetch, budget(), id)
    if (objects > 0) return { status: "non-empty", objects }
    await garage(stack, deps.fetch, budget(), "DeleteBucket", {
      query: { id },
    })
    return { status: "removed" }
  }
  const s3 = deps.s3 ?? s3Of(stack)
  try {
    const page = await s3.listObjectsV2(
      { Bucket: bucket, MaxKeys: 1 },
      { abortSignal: AbortSignal.timeout(budget()) }
    )
    if ((page.Contents ?? []).length > 0)
      return { status: "non-empty", objects: undefined }
    await s3.deleteBucket(
      { Bucket: bucket },
      { abortSignal: AbortSignal.timeout(budget()) }
    )
    return { status: "removed" }
  } catch (error) {
    if (isNoSuchBucket(error)) return { status: "absent" }
    throw error
  }
}

/**
 * Every container of profile `p` that carries a run label, with its tag. A
 * container without a tag value is not a run's and is skipped. Throws when
 * docker fails or does not answer within `timeoutMs`: an empty list then
 * would hide a leak.
 */
export function runContainers(
  p: TestProvider,
  exec: Exec,
  timeoutMs: number = CALL_TIMEOUT_MS
): Promise<{ name: string; tag: string }[]> {
  return listContainers(p, exec, timeoutMs)
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
 * (`docker rm -f -v`) and its bucket `run-<tag>` when it is empty
 * ({@link removeEmptyRunBucket}); a bucket with objects is left and reported.
 * Throws only on a malformed tag, before any call; otherwise never throws and
 * never runs past `deadlineMs`: a bucket that is not empty, could not be
 * deleted or checked is in `left`, and the commands to finish it by hand are
 * in `cleanup`.
 */
export async function removeRunResources(
  tag: string,
  p: TestProvider,
  deps: { exec: Exec; fetch: Fetch; deadlineMs: number; s3?: S3ClientLike }
): Promise<{ removed: string[]; left: string[]; cleanup: string[] }> {
  checkTag(tag)
  const deadline = Date.now() + deps.deadlineMs
  // Кожен виклик обмежений рештою дедлайну: прибиральник у обробнику сигналу
  // має власну межу, і завислий docker чи Garage не мусить її з'їсти
  const budget = (): number =>
    Math.max(1, Math.min(CALL_TIMEOUT_MS, deadline - Date.now()))
  const removed: string[] = []
  const left: string[] = []
  const cleanup: string[] = []
  const bucketName = runBucketName(tag)
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
  const where = stack.garageAdminUrl === null ? "Supabase Storage" : "Garage"
  // Ім'я бакета виводиться з тегу, а не з переліку: людина знає, що
  // перевірити, і коли адмінка чи S3 мовчать
  try {
    const result = await removeEmptyRunBucket(tag, stack, {
      fetch: deps.fetch,
      ...(deps.s3 !== undefined ? { s3: deps.s3 } : {}),
      timeoutMs: Math.max(1, deadline - Date.now()),
    })
    if (result.status === "removed") removed.push(`bucket ${bucketName}`)
    if (result.status === "non-empty") {
      const count =
        result.objects === undefined
          ? "has objects"
          : `${result.objects} object(s)`
      left.push(`bucket ${bucketName} (${count})`)
      cleanup.push(`bucket ${bucketName}: empty and delete in ${where}`)
    }
  } catch (error) {
    left.push(`bucket ${bucketName} (${reason(error)})`)
    cleanup.push(`bucket ${bucketName}: empty and delete in ${where}`)
  }
  return { removed, left, cleanup }
}

/** One admin API v2 call: `GET` without a body, `POST` with one or for a delete. */
async function garage(
  stack: TestStack,
  fetch: Fetch,
  timeoutMs: number,
  endpoint:
    | "ListBuckets"
    | "GetBucketInfo"
    | "CreateBucket"
    | "DeleteBucket"
    | "AllowBucketKey",
  o: { query?: Record<string, string>; body?: unknown } = {}
): Promise<unknown> {
  if (stack.garageAdminUrl === null)
    throw new Error("This stack has no Garage admin API")
  const url = new URL(`/v2/${endpoint}`, stack.garageAdminUrl)
  for (const [key, value] of Object.entries(o.query ?? {}))
    url.searchParams.set(key, value)
  const write =
    endpoint === "CreateBucket" ||
    endpoint === "DeleteBucket" ||
    endpoint === "AllowBucketKey"
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
