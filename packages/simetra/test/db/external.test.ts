import { afterEach, describe, expect, it, vi } from "vitest"
import {
  type Exec,
  type Fetch,
  removeRunResources,
  runBuckets,
  runContainers,
} from "./external"
import { garageAdminToken, PROVIDER_ENV, TEST_STACKS } from "./profile"
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
  o: { hang?: (endpoint: string) => boolean; status?: number } = {}
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
      state.splice(state.indexOf(bucket), 1)
      return json(null)
    }
    return json({ code: "NotFound" }, 404)
  }
  return { fetch, requests, buckets: () => state }
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

  // Р5: спорожнення бакета з об'єктами — у ПГ-5
  it("leaves a bucket with objects", async () => {
    const garage = fakeGarage([{ id: "full", alias: `run-${TAG}`, objects: 3 }])
    const result = await removeRunResources(TAG, "postgres", {
      exec: fakeDocker([]).exec,
      fetch: garage.fetch,
      deadlineMs: 5_000,
    })
    expect(result.removed).toEqual([])
    expect(result.left).toEqual([expect.stringContaining(`bucket run-${TAG}`)])
    expect(result.cleanup).toEqual([
      `bucket run-${TAG}: empty and delete in Garage`,
    ])
    expect(garage.buckets().map((b) => b.id)).toEqual(["full"])
  })

  it.each([
    ["every Garage call", () => true],
    ["the bucket info", (endpoint: string) => endpoint === "GetBucketInfo"],
  ])("sweep keeps its deadline when %s never answers", async (_, hang) => {
    const docker = fakeDocker([])
    const garage = fakeGarage([{ id: "b1", alias: `run-${TAG}`, objects: 0 }], {
      hang,
    })
    const deadlineMs = 500
    const started = Date.now()
    const result = await removeRunResources(TAG, "postgres", {
      exec: docker.exec,
      fetch: garage.fetch,
      deadlineMs,
    })
    expect(Date.now() - started).toBeLessThan(deadlineMs + 1_000)
    expect(result.left).toEqual([expect.stringContaining(`bucket run-${TAG}`)])
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
