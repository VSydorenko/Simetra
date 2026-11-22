import { STORAGE_MAX_BYTES } from "simetra/model"

/** Object key of the database binding marker (platform spec §8.2). */
export const INSTANCE_MARKER_KEY = "simetra-instance"

/** Prefix of every file object key (`fileObjectKey` in `simetra/model`). */
const FILE_PREFIX = "o/"

/** The file store port of the server tier (platform spec §8.4). */
export interface FileStore {
  /**
   * Reads the body, counts the bytes itself and aborts past `maxBytes`
   * (nothing is written then). `instance` is the database `storage_instance`
   * uuid: the bucket must be empty or carry the same marker.
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
   * Refuses (throws {@link FileStoreError}) a bucket that is not this
   * database's: a different marker, or objects without a marker. An empty
   * bucket passes. Used by the reconciliation before any deletion.
   */
  checkInstance(instance: string): Promise<void>
}

/** Refusal of the store itself; `reason` is a closed list. */
export class FileStoreError extends Error {
  constructor(
    readonly reason: "too-large" | "foreign-bucket" | "bad-limit",
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
    StartAfter?: string
    ContinuationToken?: string
    MaxKeys?: number
  }): Promise<{
    Contents?: { Key?: string; LastModified?: Date }[]
    IsTruncated?: boolean
    NextContinuationToken?: string
  }>
}

// Відсутність ключа SDK повідомляє помилкою з іменем або статусом 404
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const e = error as {
    name?: unknown
    $metadata?: { httpStatusCode?: unknown }
  }
  return (
    e.name === "NoSuchKey" ||
    e.name === "NotFound" ||
    e.$metadata?.httpStatusCode === 404
  )
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

  // Повертає, чи треба писати маркер: лише порожній бакет без маркера
  const checkBinding = async (instance: string): Promise<"write" | "ok"> => {
    const marker = await readMarker()
    if (marker !== null) {
      if (marker === instance) return "ok"
      throw new FileStoreError(
        "foreign-bucket",
        "bucket belongs to another database (instance marker differs)"
      )
    }
    const any = await client.listObjectsV2({
      Bucket: bucket,
      Prefix: FILE_PREFIX,
      MaxKeys: 1,
    })
    if ((any.Contents?.length ?? 0) > 0)
      throw new FileStoreError(
        "foreign-bucket",
        "bucket holds files but no instance marker"
      )
    return "write"
  }

  return {
    async put(key, body, { contentType, maxBytes, instance }) {
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
      // наперед, а перевищення обриває потік, коли в бакеті ще нічого немає
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
      for (const chunk of chunks) {
        bytes.set(chunk, at)
        at += chunk.byteLength
      }
      if ((await checkBinding(instance)) === "write") {
        const marker = new TextEncoder().encode(instance)
        await client.putObject({
          Bucket: bucket,
          Key: INSTANCE_MARKER_KEY,
          Body: marker,
          ContentLength: marker.byteLength,
          ContentType: "text/plain",
        })
      }
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
      try {
        const res = await client.getObject({ Bucket: bucket, Key: key })
        if (res.Body === undefined) return null
        return {
          body: res.Body.transformToWebStream(),
          size: res.ContentLength ?? 0,
          contentType: res.ContentType ?? "application/octet-stream",
        }
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async delete(key) {
      await client.deleteObject({ Bucket: bucket, Key: key })
    },

    async *list(prefix, after) {
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
        token = res.IsTruncated === true ? res.NextContinuationToken : undefined
      } while (token !== undefined)
    },

    async checkInstance(instance) {
      await checkBinding(instance)
    },
  }
}
