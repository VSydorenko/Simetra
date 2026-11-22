import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createRunBucket,
  emptyAndDeleteRunBucket,
  type Exec,
  type Fetch,
  nodeExec,
  removeRunResources,
  runBuckets,
  runContainers,
} from "./external"
import { garageAdminToken, PROVIDER_ENV, TEST_STACKS } from "./profile"
import type { S3ClientLike } from "./s3"
import { sweepRun } from "./sweep"

// Підставна база: недосяжна на з'єднанні, із запитом, що ніколи не повертається,
// чи порожня. Прибиральник мусить дійти до зовнішніх ресурсів у кожному разі
const db = vi.hoisted(() => ({
  mode: "refuse" as "refuse" | "hang" | "empty",
}))
vi.mock("pg", () => {
  class Client {
    connect(): Promise<void> {
      return db.mode === "refuse"
        ? Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:54422"))
        : Promise.resolve()
    }
    query(): Promise<{ rows: never[] }> {
      // Без реакції й на `end()`: межу мусить тримати сам прибиральник
      return db.mode === "hang"
        ? new Promise(() => {})
        : Promise.resolve({ rows: [] })
    }
    end(): Promise<void> {
      return Promise.resolve()
    }
  }
  return { default: { Client } }
})

const TAG = "abc123"
const OTHER_TAG = "zzz999"
const postgres = TEST_STACKS.postgres

type FakeContainer = { name: string; tag: string; stack: string }

/**
 * Підставний docker: `ps` фільтрує контейнери за переданими `--filter`, як
 * справжній, а `rm` видаляє їх зі стану й пише виклик.
 */
function fakeDocker(containers: FakeContainer[]): {
  exec: Exec
  calls: string[][]
  alive: () => string[]
} {
  const state = [...containers]
  const calls: string[][] = []
  const exec: Exec = (file, args) => {
    calls.push([file, ...args])
    if (args[0] === "ps") {
      const filters = args.flatMap((a, i) =>
        args[i - 1] === "--filter" ? [a.replace(/^label=/, "")] : []
      )
      const matches = (c: FakeContainer): boolean =>
        filters.every((f) => {
          const [key, value] = f.split("=")
          const labels: Record<string, string> = {
            "simetra-run": c.tag,
            "simetra-stack": c.stack,
          }
          const label = labels[key ?? ""]
          return label !== undefined && (value === undefined || label === value)
        })
      return Promise.resolve(
        state
          .filter(matches)
          .map((c) => `${c.name}\t${c.tag}\n`)
          .join("")
      )
    }
    if (args[0] === "rm") {
      for (const name of args.slice(3)) {
        const i = state.findIndex((c) => c.name === name)
        if (i >= 0) state.splice(i, 1)
      }
      return Promise.resolve("")
    }
    return Promise.reject(new Error(`unexpected docker ${args.join(" ")}`))
  }
  return { exec, calls, alive: () => state.map((c) => c.name) }
}

type FakeBucket = { id: string; alias: string; objects: number }

/** Підставна адмінка Garage v2: маршрути й форми відповідей звірено з v2.5.0. */
function fakeGarage(
  buckets: FakeBucket[],
  o: {
    hang?: (endpoint: string) => boolean
    status?: number
    // Справжній Garage не видаляє непорожній бакет: порядок «спорожнити, потім
    // видалити» перевіряє фальшивка, а не лише журнал викликів
    nonEmpty?: (alias: string) => boolean
  } = {}
): { fetch: Fetch; requests: Request[]; buckets: () => FakeBucket[] } {
  const state = [...buckets]
  const requests: Request[] = []
  const fetch: Fetch = (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    const url = new URL(request.url)
    const endpoint = url.pathname.replace(/^\/v2\//, "")
    if (o.hang?.(endpoint) === true)
      // Як справжній fetch: висить, доки сигнал не перерве
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason)
        )
      })
    const json = (body: unknown, status = 200): Promise<Response> =>
      Promise.resolve(Response.json(body, { status }))
    if (o.status !== undefined) return json({ code: "InternalError" }, o.status)
    const id = url.searchParams.get("id")
    const bucket = state.find((b) => b.id === id)
    if (endpoint === "ListBuckets")
      return json(state.map((b) => ({ id: b.id, globalAliases: [b.alias] })))
    if (endpoint === "GetBucketInfo")
      return bucket === undefined
        ? json({ code: "NoSuchBucket" }, 404)
        : json({ id: bucket.id, objects: bucket.objects })
    if (endpoint === "DeleteBucket") {
      if (bucket === undefined) return json({ code: "NoSuchBucket" }, 404)
      if (o.nonEmpty?.(bucket.alias) === true)
        return json({ code: "BucketNotEmpty" }, 409)
      state.splice(state.indexOf(bucket), 1)
      return json(null)
    }
    if (endpoint === "CreateBucket") return json({ id: "new-id" })
    if (endpoint === "AllowBucketKey") return json({ id: "new-id" })
    return json({ code: "NotFound" }, 404)
  }
  return { fetch, requests, buckets: () => state }
}

/**
 * Підставний S3: бакети з ключами, сторінки по два об'єкти (спорожнення мусить
 * пройти кілька сторінок), журнал викликів із бакетом кожного.
 */
function fakeS3(
  contents: Record<string, string[]>,
  o: { deleteErrors?: boolean; hang?: boolean } = {}
): {
  s3: S3ClientLike
  calls: { op: string; bucket: string }[]
  contents: Record<string, string[]>
} {
  const calls: { op: string; bucket: string }[] = []
  const noBucket = (): never => {
    throw Object.assign(new Error("NoSuchBucket"), { name: "NoSuchBucket" })
  }
  const hang = (signal?: AbortSignal): Promise<never> =>
    new Promise((_, reject) =>
      signal?.addEventListener("abort", () => reject(signal.reason))
    )
  const client = {
    listObjectsV2: (
      a: { Bucket: string },
      opts?: { abortSignal?: AbortSignal }
    ) => {
      calls.push({ op: "list", bucket: a.Bucket })
      if (o.hang === true) return hang(opts?.abortSignal)
      const keys = contents[a.Bucket] ?? noBucket()
      return Promise.resolve({
        Contents: keys.slice(0, 2).map((Key) => ({ Key })),
      })
    },
    deleteObjects: (a: {
      Bucket: string
      Delete: { Objects: { Key: string }[] }
    }) => {
      calls.push({ op: "deleteObjects", bucket: a.Bucket })
      if (o.deleteErrors === true)
        return Promise.resolve({
          Errors: [{ Key: a.Delete.Objects[0]?.Key, Code: "AccessDenied" }],
        })
      const gone = new Set(a.Delete.Objects.map((k) => k.Key))
      contents[a.Bucket] = (contents[a.Bucket] ?? []).filter(
        (k) => !gone.has(k)
      )
      return Promise.resolve({})
    },
    deleteBucket: (a: { Bucket: string }) => {
      calls.push({ op: "deleteBucket", bucket: a.Bucket })
      if ((contents[a.Bucket] ?? noBucket()).length > 0)
        throw Object.assign(new Error("BucketNotEmpty"), {
          name: "BucketNotEmpty",
        })
      delete contents[a.Bucket]
      return Promise.resolve({})
    },
  }
  return { s3: client as unknown as S3ClientLike, calls, contents }
}

afterEach(() => {
  vi.unstubAllEnvs()
  db.mode = "refuse"
})

describe("runContainers", () => {
  it("parses name and tag, skips a line without a tag, filters by stack", async () => {
    const docker = fakeDocker([
      { name: "simetra-run-abc123-a", tag: TAG, stack: "postgres" },
      { name: "untagged", tag: "", stack: "postgres" },
    ])
    expect(await runContainers("postgres", docker.exec)).toEqual([
      { name: "simetra-run-abc123-a", tag: TAG },
    ])
    expect(docker.calls[0]).toEqual(
      expect.arrayContaining(["--filter", "label=simetra-stack=postgres"])
    )
  })

  // Review Focus 1: прогони двох стеків одночасно не бачать контейнерів одне одного
  it("container of another stack is not a leak", async () => {
    const docker = fakeDocker([
      { name: "pg-run", tag: TAG, stack: "postgres" },
      { name: "sb-run", tag: OTHER_TAG, stack: "supabase" },
    ])
    expect(await runContainers("supabase", docker.exec)).toEqual([
      { name: "sb-run", tag: OTHER_TAG },
    ])
  })
})

describe("runBuckets", () => {
  it("keeps only run-<tag> buckets, counts objects and sends the token", async () => {
    const garage = fakeGarage([
      { id: "b1", alias: `run-${TAG}`, objects: 2 },
      { id: "b2", alias: "simetra-dev", objects: 0 },
      { id: "b3", alias: "run-not-a-tag", objects: 0 },
    ])
    expect(await runBuckets(postgres, garage.fetch, 1_000)).toEqual([
      { id: "b1", name: `run-${TAG}`, tag: TAG, objects: 2 },
    ])
    for (const request of garage.requests)
      expect(request.headers.get("authorization")).toBe(
        `Bearer ${garageAdminToken()}`
      )
  })

  it("returns nothing on a stack without Garage", async () => {
    const garage = fakeGarage([{ id: "b1", alias: `run-${TAG}`, objects: 0 }])
    expect(await runBuckets(TEST_STACKS.supabase, garage.fetch, 1_000)).toEqual(
      []
    )
    expect(garage.requests).toEqual([])
  })
})

// Review Focus 5: порожній перелік через недоступний docker чи Garage сховав би витік
describe("lister failure fails the run", () => {
  it("throws when docker fails", async () => {
    const exec: Exec = () => Promise.reject(new Error("docker: not found"))
    await expect(runContainers("postgres", exec)).rejects.toThrow(/docker/)
  })

  // Завислий демон docker: справжній процес, що не виходить, — межу тримає
  // `nodeExec`, а не тест
  it("throws before the deadline when docker exec hangs", async () => {
    const hung: Exec = (_file, _args, opts) =>
      nodeExec(process.execPath, ["-e", "setInterval(() => {}, 1000)"], opts)
    const started = Date.now()
    await expect(runContainers("postgres", hung, 300)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("throws when the Garage admin API answers 500", async () => {
    const garage = fakeGarage([], { status: 500 })
    await expect(runBuckets(postgres, garage.fetch, 1_000)).rejects.toThrow(
      /500/
    )
  })
})

describe("removeRunResources", () => {
  it("removes the tag's containers and its empty bucket, nothing else", async () => {
    const docker = fakeDocker([
      { name: "mine", tag: TAG, stack: "postgres" },
      { name: "other-run", tag: OTHER_TAG, stack: "postgres" },
      { name: "other-stack", tag: TAG, stack: "supabase" },
    ])
    const garage = fakeGarage([
      { id: "mine", alias: `run-${TAG}`, objects: 0 },
      { id: "theirs", alias: `run-${OTHER_TAG}`, objects: 0 },
    ])
    const result = await removeRunResources(TAG, "postgres", {
      exec: docker.exec,
      fetch: garage.fetch,
      s3: fakeS3({ [`run-${TAG}`]: [] }).s3,
      deadlineMs: 5_000,
    })
    expect(result).toEqual({
      removed: ["container mine", `bucket run-${TAG}`],
      left: [],
      cleanup: [],
    })
    expect(docker.alive()).toEqual(["other-run", "other-stack"])
    expect(garage.buckets().map((b) => b.id)).toEqual(["theirs"])
    expect(docker.calls).toContainEqual(["docker", "rm", "-f", "-v", "mine"])
  })

  it("empties a bucket with objects page by page, then deletes it", async () => {
    const mine = `run-${TAG}`
    const s3 = fakeS3({ [mine]: ["a", "b", "c", "d", "e"] })
    const garage = fakeGarage([{ id: "full", alias: mine, objects: 5 }], {
      nonEmpty: (alias) => (s3.contents[alias] ?? []).length > 0,
    })
    const result = await removeRunResources(TAG, "postgres", {
      exec: fakeDocker([]).exec,
      fetch: garage.fetch,
      s3: s3.s3,
      deadlineMs: 5_000,
    })
    expect(result).toEqual({
      removed: [`bucket ${mine}`],
      left: [],
      cleanup: [],
    })
    expect(garage.buckets()).toEqual([])
    // Спорожнення — до видалення: Garage відмовив би непорожньому
    expect(s3.calls.filter((c) => c.op !== "list")).toEqual([
      { op: "deleteObjects", bucket: mine },
      { op: "deleteObjects", bucket: mine },
      { op: "deleteObjects", bucket: mine },
    ])
  })

  // І13: прибиральник адресує рівно бакет свого тегу
  it("touches only the bucket named by its own tag", async () => {
    const mine = `run-${TAG}`
    const theirs = `run-${OTHER_TAG}`
    const s3 = fakeS3({
      [mine]: ["x"],
      [theirs]: ["y"],
      "run-abc12": ["z"],
      "simetra-dev": ["w"],
    })
    const garage = fakeGarage([
      { id: "m", alias: mine, objects: 1 },
      { id: "t", alias: theirs, objects: 1 },
    ])
    await removeRunResources(TAG, "postgres", {
      exec: fakeDocker([]).exec,
      fetch: garage.fetch,
      s3: s3.s3,
      deadlineMs: 5_000,
    })
    expect(new Set(s3.calls.map((c) => c.bucket))).toEqual(new Set([mine]))
    // Garage видаляє бакет адмінкою, тож порожній ключовий список лишається
    expect(s3.contents).toEqual({
      [mine]: [],
      [theirs]: ["y"],
      "run-abc12": ["z"],
      "simetra-dev": ["w"],
    })
    expect(garage.buckets().map((b) => b.id)).toEqual(["t"])
  })

  it("reports a bucket it could not empty and does not delete it", async () => {
    const mine = `run-${TAG}`
    const s3 = fakeS3({ [mine]: ["a"] }, { deleteErrors: true })
    const garage = fakeGarage([{ id: "full", alias: mine, objects: 1 }])
    const result = await removeRunResources(TAG, "postgres", {
      exec: fakeDocker([]).exec,
      fetch: garage.fetch,
      s3: s3.s3,
      deadlineMs: 5_000,
    })
    expect(result.removed).toEqual([])
    expect(result.left).toEqual([expect.stringContaining(`bucket ${mine}`)])
    expect(result.left[0]).toContain("AccessDenied")
    expect(result.cleanup).toEqual([
      `bucket ${mine}: empty and delete in Garage`,
    ])
    expect(garage.buckets().map((b) => b.id)).toEqual(["full"])
    expect(s3.calls.map((c) => c.op)).not.toContain("deleteBucket")
  })

  it("a Supabase bucket is emptied and deleted over S3; an absent one is no leak", async () => {
    const mine = `run-${TAG}`
    const s3 = fakeS3({ [mine]: ["a", "b", "c"], [`run-${OTHER_TAG}`]: ["k"] })
    const run = () =>
      removeRunResources(TAG, "supabase", {
        exec: fakeDocker([]).exec,
        fetch: fakeGarage([]).fetch,
        s3: s3.s3,
        deadlineMs: 5_000,
      })
    expect(await run()).toEqual({
      removed: [`bucket ${mine}`],
      left: [],
      cleanup: [],
    })
    expect(s3.contents).toEqual({ [`run-${OTHER_TAG}`]: ["k"] })
    expect(s3.calls.at(-1)).toEqual({ op: "deleteBucket", bucket: mine })
    expect(await run()).toEqual({ removed: [], left: [], cleanup: [] })
  })

  it("an S3 failure is a report line, not a throw", async () => {
    const mine = `run-${TAG}`
    const garage = fakeGarage([{ id: "b", alias: mine, objects: 1 }])
    const s3 = {
      listObjectsV2: () => Promise.reject(new Error("connect ECONNREFUSED")),
    } as unknown as S3ClientLike
    const result = await removeRunResources(TAG, "postgres", {
      exec: fakeDocker([]).exec,
      fetch: garage.fetch,
      s3,
      deadlineMs: 5_000,
    })
    expect(result.left).toEqual([`bucket ${mine} (connect ECONNREFUSED)`])
    expect(garage.buckets()).toHaveLength(1)
  })

  it.each([
    ["every Garage call", { garage: () => true }],
    ["every S3 call", { s3Hang: true }],
  ])("sweep keeps its deadline when %s never answers", async (_, hang) => {
    const mine = `run-${TAG}`
    const docker = fakeDocker([])
    const garage = fakeGarage([{ id: "b1", alias: mine, objects: 1 }], {
      hang: "garage" in hang ? hang.garage : () => false,
    })
    const s3 = fakeS3({ [mine]: ["a"] }, { hang: "s3Hang" in hang })
    const deadlineMs = 500
    const started = Date.now()
    const result = await removeRunResources(TAG, "postgres", {
      exec: docker.exec,
      fetch: garage.fetch,
      s3: s3.s3,
      deadlineMs,
    })
    expect(Date.now() - started).toBeLessThan(deadlineMs + 1_000)
    expect(result.left).toEqual([expect.stringContaining(`bucket ${mine}`)])
  })
})

describe("createRunBucket", () => {
  it("creates the bucket and lets the dev key use it", async () => {
    const garage = fakeGarage([])
    expect(await createRunBucket(TAG, postgres, garage.fetch)).toBe("new-id")
    const [create, allow] = garage.requests
    expect(new URL(create!.url).pathname).toBe("/v2/CreateBucket")
    expect(await create!.json()).toEqual({ globalAlias: `run-${TAG}` })
    expect(new URL(allow!.url).pathname).toBe("/v2/AllowBucketKey")
    expect(await allow!.json()).toEqual({
      bucketId: "new-id",
      accessKeyId: expect.stringMatching(/^GK/),
      permissions: { read: true, write: true, owner: false },
    })
  })
})

describe("emptyAndDeleteRunBucket", () => {
  it("returns false for a bucket that is not there", async () => {
    const s3 = fakeS3({})
    expect(
      await emptyAndDeleteRunBucket(TAG, TEST_STACKS.supabase, {
        fetch: fakeGarage([]).fetch,
        s3: s3.s3,
      })
    ).toBe(false)
  })
})

describe("sweepRun", () => {
  const sweep = (docker: ReturnType<typeof fakeDocker>, deadlineMs: number) => {
    vi.stubEnv(PROVIDER_ENV, "postgres")
    return sweepRun(TAG, {
      deadlineMs,
      exec: docker.exec,
      fetch: fakeGarage([]).fetch,
    })
  }

  it("DB unreachable still removes containers", async () => {
    const docker = fakeDocker([{ name: "mine", tag: TAG, stack: "postgres" }])
    const result = await sweep(docker, 10_000)
    expect(result.dropped).toContain("container mine")
    expect(docker.alive()).toEqual([])
    // Невдала DB-фаза не мовчить: її причина — у `left`, ручний SQL — у `cleanup`
    expect(result.left).toEqual([expect.stringMatching(/ECONNREFUSED/)])
    expect(result.cleanup).toEqual([expect.stringContaining("DROP DATABASE")])
  })

  // DB-фаза отримує дедлайн мінус 5 с бюджету зовнішніх ресурсів: з
  // дедлайном 6 с зависла база тримає прибиральника ~1 с, а не 6
  it("a query that never returns does not take the external budget", async () => {
    db.mode = "hang"
    const docker = fakeDocker([{ name: "mine", tag: TAG, stack: "postgres" }])
    const started = Date.now()
    const result = await sweep(docker, 6_000)
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect(elapsed).toBeLessThan(2_000)
    expect(result.dropped).toEqual(["container mine"])
    expect(result.left).toEqual([expect.stringMatching(/database phase/)])
  })

  it("removes containers after the database pass finds nothing", async () => {
    db.mode = "empty"
    const docker = fakeDocker([{ name: "mine", tag: TAG, stack: "postgres" }])
    expect(await sweep(docker, 10_000)).toEqual({
      dropped: ["container mine"],
      left: [],
      cleanup: [],
    })
  })
})
