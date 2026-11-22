import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fileObjectKey } from "simetra/model"
import { createCommandRuntime, fromPgPool } from "simetra/server"
import { defineReconcileCases } from "./storage-reconcile.cases"
import {
  ORG_ROOT_CASCADE,
  heldStorageEnv,
  type Env,
} from "./storage-env.support"
import { LIMIT, STORAGE, TYPES } from "./storage-sql.support"

/**
 * Повний цикл файлів і звірка через S3 Supabase Storage (ПГ-5, Р1): ті самі
 * кроки, що на Garage (`storage-runtime.postgres.db.test.ts`), але бакет
 * `run-<тег>` створено S3-протоколом Supabase, а ключ діє на весь проєкт.
 */

const ATTACHMENT = { kind: "Catalog" as const, name: "Attachment" }
const target = heldStorageEnv(ORG_ROOT_CASCADE)
let env: Env
beforeAll(async () => {
  env = await target.open()
}, 180_000)
afterAll(() => target.close(), 60_000)

describe("file storage over the runtime and S3 of Supabase", () => {
  it("runs checkUpload → put → attachFile → read and keeps the bytes", async () => {
    const rt = await createCommandRuntime({
      database: fromPgPool(env.pool),
      catalog: env.catalog,
    })
    const limits = await rt.checkUpload(env.writer.session, {
      object: ATTACHMENT,
      scope: env.writer.org,
    })
    expect(limits).toEqual({
      maxBytes: STORAGE.maxBytes,
      mediaTypes: TYPES,
      instance: expect.stringMatching(/^[0-9a-f-]{36}:\d+:\d+:[0-9A-F]{8}$/),
    })
    const id = randomUUID()
    const object = env.catalog.objects.find((o) => o.name === "Attachment")!.id
    const key = fileObjectKey(object, id)
    const put = await env.files.put(key, new Blob(["hello"]).stream(), {
      contentType: "text/plain",
      maxBytes: LIMIT,
      instance: limits!.instance,
    })
    expect(put).toEqual({ size: 5 })
    await rt.attachFile(env.writer.session, {
      object: ATTACHMENT,
      scope: env.writer.org,
      id,
      name: "a.txt",
      size: put.size,
      contentType: "text/plain",
    })
    const read = await rt.read(env.writer.session, { object: ATTACHMENT, id })
    expect(read.rows).toHaveLength(1)
    const stored = await env.files.get(key)
    expect(await new Response(stored!.body).text()).toBe("hello")
    expect(stored!.size).toBe(5)
  })

  defineReconcileCases(() => env)
})
