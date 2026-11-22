import { fileObjectKey, STORAGE_MAX_BYTES } from "simetra/model"
import { describe, expect, it } from "vitest"
import type { S3ClientLike as SdkS3 } from "../../../test/db/s3"
import {
  fromS3Client,
  FileStoreError,
  INSTANCE_MARKER_KEY,
  type S3ClientLike,
} from "../file-store"

// Клієнт SDK має підходити структурному типу порту
export const sdkFitsPort = (c: SdkS3): S3ClientLike => c

const OBJ = "11111111-1111-4111-8111-111111111111"
const ROW = "22222222-2222-4222-8222-222222222222"
const INSTANCE = "33333333-3333-4333-8333-333333333333"
const OTHER = "44444444-4444-4444-8444-444444444444"
const UPPER = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
const KEY = fileObjectKey(OBJ, ROW)

interface Stored {
  bytes: Uint8Array
  type: string
  length: number
  at: Date
}

function fakeS3(pageSize = 1000) {
  const objects = new Map<string, Stored>()
  const calls: string[] = []
  const client: S3ClientLike = {
    async putObject(i) {
      calls.push(`put ${i.Key}`)
      objects.set(i.Key, {
        bytes: i.Body,
        type: i.ContentType ?? "",
        length: i.ContentLength,
        at: new Date(0),
      })
    },
    async getObject(i) {
      calls.push(`get ${i.Key}`)
      const o = objects.get(i.Key)
      if (o === undefined)
        throw Object.assign(new Error("no key"), { name: "NoSuchKey" })
      return {
        Body: {
          transformToWebStream: () => streamOf(o.bytes),
        },
        ContentLength: o.bytes.byteLength,
        ContentType: o.type,
      }
    },
    async deleteObject(i) {
      calls.push(`delete ${i.Key}`)
      objects.delete(i.Key)
    },
    async listObjectsV2(i) {
      if (i.Delimiter !== undefined) {
        const prefixes = new Set<string>()
        for (const k of [...objects.keys()].sort()) {
          if (!k.startsWith(i.Prefix ?? "")) continue
          const cut = k.indexOf(i.Delimiter, (i.Prefix ?? "").length)
          if (cut >= 0) prefixes.add(k.slice(0, cut + 1))
        }
        return { CommonPrefixes: [...prefixes].map((Prefix) => ({ Prefix })) }
      }
      const keys = [...objects.keys()]
        .filter((k) => k.startsWith(i.Prefix ?? ""))
        .filter((k) =>
          i.ContinuationToken === undefined
            ? k > (i.StartAfter ?? "")
            : k > i.ContinuationToken
        )
        .sort()
      const limit = Math.min(i.MaxKeys ?? pageSize, pageSize)
      const page = keys.slice(0, limit)
      const more = keys.length > page.length
      return {
        Contents: page.map((Key) => ({
          Key,
          LastModified: objects.get(Key)!.at,
        })),
        IsTruncated: more,
        NextContinuationToken: more ? page.at(-1) : undefined,
      }
    },
  }
  return { client, objects, calls }
}

function streamOf(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p)
      c.close()
    },
  })
}
const bytes = (n: number) => new Uint8Array(n).fill(7)
const opts = { contentType: "text/plain", maxBytes: 10, instance: INSTANCE }

describe("fromS3Client put", () => {
  it("returns the counted size and writes it as ContentLength", async () => {
    const { client, objects } = fakeS3()
    const store = fromS3Client(client, "b")
    const out = await store.put(KEY, streamOf(bytes(3), bytes(4)), opts)
    expect(out).toEqual({ size: 7 })
    const o = objects.get(KEY)!
    expect(o.length).toBe(7)
    expect(o.bytes.byteLength).toBe(7)
    expect(o.type).toBe("text/plain")
  })

  it("accepts exactly maxBytes", async () => {
    const { client } = fakeS3()
    const out = await fromS3Client(client, "b").put(
      KEY,
      streamOf(bytes(10)),
      opts
    )
    expect(out.size).toBe(10)
  })

  it("refuses exactly maxBytes + 1 bytes", async () => {
    const { client, objects } = fakeS3()
    await expect(
      fromS3Client(client, "b").put(KEY, streamOf(bytes(11)), opts)
    ).rejects.toMatchObject({ reason: "too-large" })
    expect(objects.size).toBe(0)
  })

  it("aborts at maxBytes + 1, cancels the source and leaves nothing", async () => {
    const { client, objects, calls } = fakeS3()
    let cancelled = false
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++
        c.enqueue(bytes(6))
      },
      cancel() {
        cancelled = true
      },
    })
    const err = await fromS3Client(client, "b")
      .put(KEY, body, opts)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FileStoreError)
    expect((err as FileStoreError).reason).toBe("too-large")
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThanOrEqual(3)
    expect(objects.size).toBe(0)
    expect(calls.filter((c) => c.startsWith("put"))).toEqual([])
  })

  it.each([0, 1.5, STORAGE_MAX_BYTES + 1])("refuses maxBytes %s", async (m) => {
    const { client, calls } = fakeS3()
    await expect(
      fromS3Client(client, "b").put(KEY, streamOf(bytes(1)), {
        ...opts,
        maxBytes: m,
      })
    ).rejects.toMatchObject({ reason: "bad-limit" })
    expect(calls).toEqual([])
  })
})

describe("instance marker", () => {
  it("first put into an empty bucket writes the marker", async () => {
    const { client, objects } = fakeS3()
    await fromS3Client(client, "b").put(KEY, streamOf(bytes(1)), opts)
    expect(
      new TextDecoder().decode(objects.get(INSTANCE_MARKER_KEY)!.bytes)
    ).toBe(INSTANCE)
  })

  it("a bucket with the same marker accepts put", async () => {
    const { client, objects } = fakeS3()
    const store = fromS3Client(client, "b")
    await store.put(KEY, streamOf(bytes(1)), opts)
    await store.put(fileObjectKey(OBJ, OTHER), streamOf(bytes(1)), opts)
    expect(objects.size).toBe(3)
  })

  it("a different marker refuses put and writes nothing", async () => {
    const { client, objects } = fakeS3()
    await fromS3Client(client, "b").put(KEY, streamOf(bytes(1)), {
      ...opts,
      instance: OTHER,
    })
    const before = objects.size
    await expect(
      fromS3Client(client, "b").put(
        fileObjectKey(OBJ, INSTANCE),
        streamOf(bytes(1)),
        opts
      )
    ).rejects.toMatchObject({ reason: "foreign-bucket" })
    expect(objects.size).toBe(before)
  })

  it("a non-empty bucket without a marker refuses put and does not write one", async () => {
    const { client, objects } = fakeS3()
    objects.set(KEY, { bytes: bytes(1), type: "", length: 1, at: new Date(0) })
    await expect(
      fromS3Client(client, "b").put(
        fileObjectKey(OBJ, OTHER),
        streamOf(bytes(1)),
        opts
      )
    ).rejects.toMatchObject({ reason: "foreign-bucket" })
    expect(objects.has(INSTANCE_MARKER_KEY)).toBe(false)
    expect(objects.size).toBe(1)
  })

  it("checkInstance: empty passes, same passes, foreign and markerless refuse", async () => {
    const empty = fakeS3()
    await expect(
      fromS3Client(empty.client, "b").checkInstance(INSTANCE)
    ).resolves.toBeUndefined()
    expect(empty.objects.size).toBe(0)

    const bound = fakeS3()
    await fromS3Client(bound.client, "b").put(KEY, streamOf(bytes(1)), opts)
    const store = fromS3Client(bound.client, "b")
    await expect(store.checkInstance(INSTANCE)).resolves.toBeUndefined()
    await expect(store.checkInstance(OTHER)).rejects.toMatchObject({
      reason: "foreign-bucket",
    })

    const markerless = fakeS3()
    markerless.objects.set(KEY, {
      bytes: bytes(1),
      type: "",
      length: 1,
      at: new Date(0),
    })
    await expect(
      fromS3Client(markerless.client, "b").checkInstance(INSTANCE)
    ).rejects.toMatchObject({ reason: "foreign-bucket" })
  })
})

describe("fromS3Client get, delete, list", () => {
  it("get of a missing key is null", async () => {
    const { client } = fakeS3()
    expect(await fromS3Client(client, "b").get(KEY)).toBeNull()
  })

  it("get returns body, size and type", async () => {
    const { client } = fakeS3()
    const store = fromS3Client(client, "b")
    await store.put(KEY, streamOf(bytes(4)), opts)
    const got = (await store.get(KEY))!
    expect(got.size).toBe(4)
    expect(got.contentType).toBe("text/plain")
    expect((await new Response(got.body).arrayBuffer()).byteLength).toBe(4)
  })

  it("get does not hide other failures", async () => {
    const { client } = fakeS3()
    client.getObject = async () => {
      throw Object.assign(new Error("denied"), { name: "AccessDenied" })
    }
    await expect(fromS3Client(client, "b").get(KEY)).rejects.toThrow("denied")
  })

  it("delete removes the object", async () => {
    const { client, objects } = fakeS3()
    const store = fromS3Client(client, "b")
    await store.put(KEY, streamOf(bytes(1)), opts)
    await store.delete(KEY)
    expect(objects.has(KEY)).toBe(false)
  })

  it("list yields only the prefix, across pages, never the marker", async () => {
    const { client } = fakeS3(2)
    const store = fromS3Client(client, "b")
    const ids = [1, 2, 3, 4, 5].map(
      (n) => `00000000-0000-4000-8000-00000000000${n}`
    )
    for (const id of ids)
      await store.put(fileObjectKey(OBJ, id), streamOf(bytes(1)), opts)
    await store.put(fileObjectKey(OTHER, ids[0]!), streamOf(bytes(1)), opts)
    const seen: string[] = []
    for await (const o of store.list(`o/${OBJ}/`)) seen.push(o.key)
    expect(seen).toEqual(ids.map((id) => fileObjectKey(OBJ, id)))

    const afterSeen: string[] = []
    for await (const o of store.list(`o/${OBJ}/`, fileObjectKey(OBJ, ids[2]!)))
      afterSeen.push(o.key)
    expect(afterSeen).toEqual(ids.slice(3).map((id) => fileObjectKey(OBJ, id)))
  })
})

describe("a truncated listing without a continuation token", () => {
  // Кінець переліку без токена не можна вважати кінцем: fail-closed
  const truncated = (): S3ClientLike => ({
    ...fakeS3().client,
    async listObjectsV2() {
      return {
        Contents: [{ Key: KEY, LastModified: new Date(0) }],
        CommonPrefixes: [{ Prefix: `o/${OBJ}/` }],
        IsTruncated: true,
      }
    },
  })

  it("makes list throw instead of ending silently", async () => {
    const store = fromS3Client(truncated(), "b")
    await expect(
      (async () => {
        for await (const _ of store.list(`o/${OBJ}/`)) void _
      })()
    ).rejects.toMatchObject({ reason: "bad-listing" })
  })

  it("makes listPrefixes throw", async () => {
    const store = fromS3Client(truncated(), "b")
    await expect(
      (async () => {
        for await (const _ of store.listPrefixes()) void _
      })()
    ).rejects.toMatchObject({ reason: "bad-listing" })
  })
})

describe("listPrefixes", () => {
  it("yields the object prefixes and not the marker", async () => {
    const { client } = fakeS3()
    const store = fromS3Client(client, "b")
    await store.put(KEY, streamOf(bytes(1)), opts)
    await store.put(fileObjectKey(OTHER, ROW), streamOf(bytes(1)), opts)
    const found: string[] = []
    for await (const p of store.listPrefixes()) found.push(p)
    expect(found).toEqual([`o/${OBJ}/`, `o/${OTHER}/`])
  })
})

describe("key and prefix shape", () => {
  const bad = [
    INSTANCE_MARKER_KEY,
    `o/../${INSTANCE_MARKER_KEY}`,
    `o/${OBJ}/../${INSTANCE_MARKER_KEY}`,
    `o/${OBJ}/${UPPER}`,
    `o/${OBJ}/short`,
    `o/${OBJ}/${ROW}/x`,
    "",
  ]
  it.each(bad)("put, get, delete refuse %j before any S3 call", async (key) => {
    const { client, calls } = fakeS3()
    const store = fromS3Client(client, "b")
    const refused = { reason: "bad-key" }
    await expect(
      store.put(key, streamOf(bytes(1)), opts)
    ).rejects.toMatchObject(refused)
    await expect(store.get(key)).rejects.toMatchObject(refused)
    await expect(store.delete(key)).rejects.toMatchObject(refused)
    expect(calls).toEqual([])
  })

  it.each(["", "o/", "o", `o/${OBJ}`, "o/../", `o/${UPPER}/`])(
    "list refuses prefix %j before any S3 call",
    async (prefix) => {
      const { client, calls } = fakeS3()
      const it = fromS3Client(client, "b").list(prefix)
      await expect(it[Symbol.asyncIterator]().next()).rejects.toMatchObject({
        reason: "bad-key",
      })
      expect(calls).toEqual([])
    }
  )
})

describe("storage failures", () => {
  it("a lost marker race is refused", async () => {
    const { client, objects } = fakeS3()
    const real = client.putObject
    client.putObject = async (i) => {
      await real(i)
      // Інша база перезаписує маркер одразу після нашого запису
      if (i.Key === INSTANCE_MARKER_KEY)
        objects.get(i.Key)!.bytes = new TextEncoder().encode(OTHER)
    }
    await expect(
      fromS3Client(client, "b").put(KEY, streamOf(bytes(1)), opts)
    ).rejects.toMatchObject({ reason: "foreign-bucket" })
    expect(objects.has(KEY)).toBe(false)
  })

  it("a missing bucket is an error, not a missing key", async () => {
    const { client } = fakeS3()
    client.getObject = async () => {
      throw Object.assign(new Error("no bucket"), {
        name: "NoSuchBucket",
        $metadata: { httpStatusCode: 404 },
      })
    }
    const store = fromS3Client(client, "b")
    await expect(store.get(KEY)).rejects.toThrow("no bucket")
    await expect(store.put(KEY, streamOf(bytes(1)), opts)).rejects.toThrow(
      "no bucket"
    )
  })

  it("a bare 404 is still a missing key", async () => {
    const { client } = fakeS3()
    client.getObject = async () => {
      throw Object.assign(new Error("x"), {
        $metadata: { httpStatusCode: 404 },
      })
    }
    expect(await fromS3Client(client, "b").get(KEY)).toBeNull()
  })

  it("get without ContentLength throws instead of reporting 0", async () => {
    const { client } = fakeS3()
    client.getObject = async () => ({
      Body: { transformToWebStream: () => streamOf(bytes(1)) },
    })
    await expect(fromS3Client(client, "b").get(KEY)).rejects.toThrow(
      "ContentLength"
    )
  })
})
