import {
  isFileObjectKey,
  isFileObjectPrefix,
  STORAGE_MAX_BYTES,
} from "simetra/model"

/** Object key of the database binding marker (platform spec §8.2). */
export const INSTANCE_MARKER_KEY = "simetra-instance"

const BINDING =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(-?\d+):(\d+):([0-9A-Fa-f]+)$/

/**
 * Parts of the database binding string `<uuid>:<system_identifier>:<database
 * oid>:<timeline_id>` (platform spec §8.2): the `storage_instance` uuid and the
 * facts that change when the database is copied or promoted. `null` for any
 * other shape.
 */
export function parseBinding(binding: string): {
  instance: string
  system: string
  database: string
  timeline: string
} | null {
  const m = BINDING.exec(binding)
  return m === null
    ? null
    : { instance: m[1]!, system: m[2]!, database: m[3]!, timeline: m[4]! }
}

/** Prefix of every file object key (`fileObjectKey` in `simetra/model`). */
const FILE_PREFIX = "o/"

/** The file store port of the server tier (platform spec §8.4). */
export interface FileStore {
  /**
   * Reads the body, counts the bytes itself and aborts past `maxBytes`
   * (nothing is written then). `instance` is the database binding string
   * (`parseBinding`): the bucket must carry the same marker. `put` never
   * writes the marker: an unbound empty bucket is `no-binding`, a bucket with
   * objects but no marker or another database's marker is `foreign-bucket`.
   */
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: { contentType: string; maxBytes: number; instance: string }
  ): Promise<{ size: number }>
  /** `null` when the key has no object. */
  get(key: string): Promise<{
    body: ReadableStream<Uint8Array>
    size: number
    contentType: string
  } | null>
  delete(key: string): Promise<void>
  /** Objects under `prefix` in key order, after the key `after` when given. */
  list(
    prefix: string,
    after?: string
  ): AsyncIterable<{ key: string; lastModified: Date }>
  /**
   * The object prefixes `o/<uuid>/` present in the bucket, in key order.
   * Lets the reconciliation name a prefix of an object the catalog does not
   * know, which it only logs.
   */
  listPrefixes(): AsyncIterable<string>
  /**
   * Refuses (throws {@link FileStoreError}) a bucket that is not this
   * database's: a different marker (`foreign-bucket`), the same marker
   * written for another cluster, database or timeline (`binding-changed`: a
   * copy or a restore), or objects without a marker. An empty unbound bucket
   * passes (nothing to delete).
   * Used by the reconciliation before any deletion.
   */
  checkInstance(instance: string): Promise<void>
  /**
   * The first binding of a bucket, an explicit operator step (the S3 servers
   * of the profiles have no conditional write, so `put` cannot bind safely).
   * Writes the marker only into a completely empty bucket and reads it back;
   * the same marker already there is a no-op. Objects without a marker or
   * another database's marker are `foreign-bucket`, the same uuid with another
   * cluster state is `binding-changed` (use `rebind`).
   */
  bind(instance: string): Promise<void>
  /**
   * Rewrites the marker with `instance` after a legitimate restore. Only a
   * marker of the same `storage_instance` uuid is rewritten; anything else
   * (no marker, another uuid) is `foreign-bucket`.
   */
  rebind(instance: string): Promise<void>
}

/** Refusal of the store itself; `reason` is a closed list. */
export class FileStoreError extends Error {
  constructor(
    readonly reason:
      | "too-large"
      | "foreign-bucket"
      | "binding-changed"
      | "no-binding"
      | "in-recovery"
      | "bad-limit"
      | "bad-key"
      | "bad-listing",
    message: string
  ) {
    super(message)
    this.name = "FileStoreError"
  }
}

/**
 * The slice of the aggregate AWS SDK `S3` client the adapter uses. Структурний
 * тип замість імпорту SDK: серверний ярус не тягне його в бандл, host
 * передає будь-який клієнт з такою формою (як `PgPoolLike`).
 */
export interface S3ClientLike {
  putObject(input: {
    Bucket: string
    Key: string
    Body: Uint8Array
    ContentLength: number
    ContentType?: string
  }): Promise<unknown>
  getObject(input: { Bucket: string; Key: string }): Promise<{
    Body?: { transformToWebStream(): ReadableStream<Uint8Array> }
    ContentLength?: number
    ContentType?: string
  }>
  deleteObject(input: { Bucket: string; Key: string }): Promise<unknown>
  listObjectsV2(input: {
    Bucket: string
    Prefix?: string
    Delimiter?: string
    StartAfter?: string
    ContinuationToken?: string
    MaxKeys?: number
  }): Promise<{
    Contents?: { Key?: string; LastModified?: Date }[]
    CommonPrefixes?: { Prefix?: string }[]
    IsTruncated?: boolean
    NextContinuationToken?: string
  }>
}

// Відсутність ключа SDK повідомляє помилкою з іменем або статусом 404;
// відсутній бакет — теж 404, але це помилка, а не «немає файлу»
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const e = error as {
    name?: unknown
    $metadata?: { httpStatusCode?: unknown }
  }
  if (e.name === "NoSuchKey" || e.name === "NotFound") return true
  return e.name !== "NoSuchBucket" && e.$metadata?.httpStatusCode === 404
}

// Обрізана сторінка без токена — відповідь, якій не можна вірити: тихий кінець
// переліку дав би звірці неповну картину (запобіжник рахував би від неї)
function nextToken(res: {
  IsTruncated?: boolean
  NextContinuationToken?: string
}): string | undefined {
  if (res.IsTruncated !== true) return undefined
  if (res.NextContinuationToken === undefined)
    throw new FileStoreError(
      "bad-listing",
      "object store answered a truncated listing without a continuation token"
    )
  return res.NextContinuationToken
}

// Ключ і префікс — лише форми `o/<uuid>/…`: інакше `put`/`delete` дісталися б
// маркера `simetra-instance`, а `list("")` віддав би його звірці
function assertKey(key: string): void {
  if (!isFileObjectKey(key))
    throw new FileStoreError("bad-key", "key must be o/<uuid>/<uuid>")
}

/** Adapts an S3 client to the port; the bucket is fixed by the server. */
export function fromS3Client(client: S3ClientLike, bucket: string): FileStore {
  const readMarker = async (): Promise<string | null> => {
    try {
      const res = await client.getObject({
        Bucket: bucket,
        Key: INSTANCE_MARKER_KEY,
      })
      if (res.Body === undefined) return null
      return (await new Response(res.Body.transformToWebStream()).text()).trim()
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  const writeMarker = async (instance: string): Promise<void> => {
    const marker = new TextEncoder().encode(instance)
    await client.putObject({
      Bucket: bucket,
      Key: INSTANCE_MARKER_KEY,
      Body: marker,
      ContentLength: marker.byteLength,
      ContentType: "text/plain",
    })
  }

  // Прив'язка — не лише uuid: копія бази (dump, TEMPLATE, PITR, репліка)
  // несе той самий uuid, але має інший кластер, oid бази чи timeline
  const compare = (marker: string, instance: string): "ok" | never => {
    if (marker === instance) return "ok"
    const have = parseBinding(marker)
    const want = parseBinding(instance)
    if (want === null) throw new Error("instance is not a database binding")
    if (have === null || have.instance !== want.instance)
      throw new FileStoreError(
        "foreign-bucket",
        "bucket belongs to another database (instance marker differs)"
      )
    const changed = (["system", "database", "timeline"] as const).filter(
      (part) => have[part] !== want[part]
    )
    throw new FileStoreError(
      "binding-changed",
      `bucket marker was written for another cluster state (${changed.join(", ")} differ): a restored or copied database; rebind the store if it is legitimate`
    )
  }

  // «empty» — ПОВНІСТЮ порожній бакет без маркера (без `Prefix`): чужий
  // об'єкт поза `o/` теж означає, що бакет не наш
  const checkBinding = async (instance: string): Promise<"empty" | "ok"> => {
    if (parseBinding(instance) === null)
      throw new Error("instance is not a database binding")
    const marker = await readMarker()
    if (marker !== null) return compare(marker, instance)
    const any = await client.listObjectsV2({
      Bucket: bucket,
      MaxKeys: 1,
    })
    if ((any.Contents?.length ?? 0) > 0)
      throw new FileStoreError(
        "foreign-bucket",
        "bucket holds objects but no instance marker"
      )
    return "empty"
  }

  return {
    async put(key, body, { contentType, maxBytes, instance }) {
      assertKey(key)
      if (
        !Number.isInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > STORAGE_MAX_BYTES
      )
        throw new FileStoreError(
          "bad-limit",
          `maxBytes must be an integer in 1..${STORAGE_MAX_BYTES}`
        )
      // Буферизуємо весь файл до першого запису: `ContentLength` відомий
      // наперед, а перевищення обриває потік, коли в бакеті ще нічого немає.
      // Пам'ять: на склеюванні шматки звільняються по одному, тож пік
      // не більший за 2 × maxBytes (≤ 2 × STORAGE_MAX_BYTES)
      const EMPTY = new Uint8Array(0)
      const chunks: Uint8Array[] = []
      let size = 0
      const reader = body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maxBytes) {
            await reader.cancel().catch(() => undefined)
            throw new FileStoreError("too-large", "file exceeds maxBytes")
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      const bytes = new Uint8Array(size)
      let at = 0
      for (let i = 0; i < chunks.length; i++) {
        bytes.set(chunks[i]!, at)
        at += chunks[i]!.byteLength
        chunks[i] = EMPTY
      }
      // Маркер `put` не пише: першу прив'язку робить лише оператор (`bind`)
      if ((await checkBinding(instance)) === "empty")
        throw new FileStoreError(
          "no-binding",
          "bucket is not bound to a database: run bindFileStore first"
        )
      await client.putObject({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentLength: size,
        ContentType: contentType,
      })
      // Розмір — наш підрахунок, а не заголовок клієнта (І9)
      return { size }
    },

    async get(key) {
      assertKey(key)
      try {
        const res = await client.getObject({ Bucket: bucket, Key: key })
        if (res.Body === undefined) return null
        // Невідомий розмір не підміняємо нулем: неправильний розмір гірший
        if (res.ContentLength === undefined)
          throw new Error("object store gave no ContentLength")
        return {
          body: res.Body.transformToWebStream(),
          size: res.ContentLength,
          contentType: res.ContentType ?? "application/octet-stream",
        }
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async delete(key) {
      assertKey(key)
      await client.deleteObject({ Bucket: bucket, Key: key })
    },

    async *list(prefix, after) {
      if (!isFileObjectPrefix(prefix))
        throw new FileStoreError("bad-key", "prefix must be o/<uuid>/")
      let token: string | undefined
      do {
        const res = await client.listObjectsV2({
          Bucket: bucket,
          Prefix: prefix,
          ...(token === undefined ? { StartAfter: after } : {}),
          ...(token === undefined ? {} : { ContinuationToken: token }),
        })
        for (const o of res.Contents ?? []) {
          if (o.Key !== undefined && o.LastModified !== undefined)
            yield { key: o.Key, lastModified: o.LastModified }
        }
        token = nextToken(res)
      } while (token !== undefined)
    },

    async *listPrefixes() {
      let token: string | undefined
      do {
        const res = await client.listObjectsV2({
          Bucket: bucket,
          Prefix: FILE_PREFIX,
          Delimiter: "/",
          ...(token === undefined ? {} : { ContinuationToken: token }),
        })
        // Чужі форми (не `o/<uuid>/`) звірці не потрібні: вона їх не торкається
        for (const p of res.CommonPrefixes ?? []) {
          if (p.Prefix !== undefined && isFileObjectPrefix(p.Prefix))
            yield p.Prefix
        }
        token = nextToken(res)
      } while (token !== undefined)
    },

    async checkInstance(instance) {
      await checkBinding(instance)
    },

    async bind(instance) {
      if ((await checkBinding(instance)) === "ok") return
      await writeMarker(instance)
      // Без умовного запису S3 два оператори на порожньому бакеті можуть обоє
      // пройти перевірку: після запису читаємо маркер знову
      if ((await readMarker()) !== instance)
        throw new FileStoreError(
          "foreign-bucket",
          "bucket belongs to another database (instance marker differs)"
        )
    },

    async rebind(instance) {
      const want = parseBinding(instance)
      if (want === null) throw new Error("instance is not a database binding")
      const have = parseBinding((await readMarker()) ?? "")
      if (have === null || have.instance !== want.instance)
        throw new FileStoreError(
          "foreign-bucket",
          "bucket belongs to another database (instance marker differs)"
        )
      await writeMarker(instance)
    },
  }
}
