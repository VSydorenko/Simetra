import {
  CommandFailure,
  fileObjectKey,
  PLATFORM_ROLES,
  runtimeCatalogSchema,
  type RuntimeCatalog,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import { FileStoreError, fromS3Client, type S3ClientLike } from "../file-store"
import { FileAttachFailure } from "../transaction"
import { commandObject, COMPANY, ID, OTHER } from "./fixtures"
import {
  BEGIN,
  COMMIT,
  CURRENT_USER,
  EPOCH,
  ROLE,
  ROLLBACK,
  SAVE,
  call,
  commandClaims,
  context,
  session,
  setup,
  type Override,
} from "./harness"

/** Об'єкт зі `storage`: довідник з іменем файлу, скоупом і `delete`. */
const DOC_ID = "00000000-0000-4000-8000-0000000000d0"
const DOC = { kind: "Catalog" as const, name: "Document" }
const attribute = (name: string, column: string, extra = {}) => ({
  name,
  column,
  type: "Text" as const,
  pgType: "text",
  castType: "text" as const,
  required: false,
  insert: true,
  update: true,
  ...extra,
})
const document = (storage = true) =>
  commandObject({
    id: DOC_ID,
    name: "Document",
    table: "document",
    ...(storage
      ? { storage: { maxBytes: 1000, mediaTypes: ["text/plain"] } }
      : {}),
    attributes: [
      attribute("fileName", "file_name", { required: true }),
      attribute("note", "note"),
      // Пише лише тригер вкладення: команда їх не вставляє (Р8).
      attribute("fileSize", "file_size", { insert: false, update: false }),
      attribute("fileContentType", "file_content_type", {
        insert: false,
        update: false,
      }),
      attribute("company", "company_id", {
        type: "Ref" as const,
        pgType: "uuid",
        castType: "uuid" as const,
        update: false,
      }),
    ],
  })
const storageCatalog: RuntimeCatalog = runtimeCatalogSchema.parse({
  format: 1,
  snapshotHash: "hash-1",
  provider: "supabase",
  objects: [document()],
})

const docRow = (id = ID, version = 1) =>
  JSON.stringify({ id, version, file_name: "a.txt", company_id: COMPANY })

const BOUND = "77777777-7777-4777-8777-777777777777:1:2:3"
const FILES_ROLE = {
  text: `SET LOCAL ROLE "${PLATFORM_ROLES.files}"`,
  params: [],
}
const PENDING_LEFT = {
  text: 'SELECT "simetra"."storage_pending_left"() AS pending',
  params: [],
}
const attachCall = (size = "5", type = "text/plain") => ({
  text: 'SELECT "simetra"."file_attach"($1::uuid, $2::uuid, $3::bigint, $4::text)',
  params: [DOC_ID, ID, size, type],
})
const saveCall = call("document_save", SAVE, [
  JSON.stringify({
    id: ID,
    file_name: "a.txt",
    note: "n",
    company_id: COMPANY,
  }),
  null,
])
const OPEN = [
  { connect: true },
  BEGIN,
  commandClaims(),
  ROLE,
  CURRENT_USER,
] as const

const input = {
  object: DOC,
  scope: COMPANY,
  id: ID,
  name: "a.txt",
  fields: { note: "n" },
  size: 5,
  contentType: "text/plain",
}

/** Відповіді бази для об'єкта: ядро `document_save` і `document_delete`. */
const base: Override = (text) => {
  if (text.includes("document_save")) return { rows: [{ r: docRow() }] }
  if (text.includes("storage_pending_left")) return { rows: [{ pending: "f" }] }
  if (text.includes("storage_headroom")) return { rows: [{ ok: "t" }] }
  if (text.includes("storage_instance_id")) return { rows: [{ id: BOUND }] }
  return undefined
}
const over =
  (extra: Override): Override =>
  (text, params) =>
    extra(text, params) ?? base(text, params)
const make = (extra: Override = () => undefined) =>
  setup(over(extra), { catalog: storageCatalog })

async function failureOf(
  promise: Promise<unknown>
): Promise<FileAttachFailure> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected a failure")
    },
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(FileAttachFailure)
  return error as FileAttachFailure
}

describe("attachFile", () => {
  it("runs file_attach under the storage role, create under the command role, then the leftover check", async () => {
    const { db, runtime } = await make()
    const result = await runtime.attachFile(session, input)
    expect(result.changes).toEqual([
      expect.objectContaining({ id: ID, operation: "create" }),
    ])
    expect(db.calls).toEqual([
      ...OPEN,
      FILES_ROLE,
      attachCall(),
      ROLE,
      context("create", "document", ID),
      saveCall,
      FILES_ROLE,
      PENDING_LEFT,
      ROLE,
      EPOCH,
      COMMIT,
      { release: false },
    ])
  })

  it("never lets the client set size or type: they come only from file_attach", async () => {
    const { db, runtime } = await make()
    for (const key of ["fileSize", "fileContentType"]) {
      const error = await failureOf(
        runtime.attachFile(session, {
          ...input,
          fields: { [key]: "x", note: "n" },
        })
      )
      expect(error.error.code).toBe("command.invalid")
    }
    expect(db.calls).toEqual([])
  })

  it.each([
    ["an unknown object", { object: { kind: "Catalog" as const, name: "X" } }],
    ["a negative size", { size: -1 }],
    ["a fractional size", { size: 1.5 }],
    ["a scope that is not a uuid", { scope: "x" }],
    ["no scope for a scoped object", { scope: null }],
    ["an id that is not a uuid", { id: "x" }],
  ])("refuses %s before the database", async (_, patch) => {
    const { db, runtime } = await make()
    const error = await failureOf(
      runtime.attachFile(session, { ...input, ...patch })
    )
    expect(error.error.code).toBe("command.invalid")
    expect(error.commitUnknown).toBe(false)
    expect(db.calls).toEqual([])
  })

  it("maps a storage refusal of file_attach and rolls back without the create phase", async () => {
    const { db, runtime } = await make((text) =>
      text.includes("file_attach")
        ? {
            error: {
              code: "SF001",
              message: "storage.rejected",
              detail: "attach-invalid",
            },
          }
        : undefined
    )
    const error = await failureOf(runtime.attachFile(session, input))
    expect(error.error).toEqual({
      code: "command.rejected",
      reason: "storage.attach-invalid",
    })
    expect(error.commitUnknown).toBe(false)
    expect(db.calls).toEqual([
      ...OPEN,
      FILES_ROLE,
      attachCall(),
      ROLLBACK,
      { release: false },
    ])
  })

  it("rolls back when the attach record was not consumed", async () => {
    const { db, runtime } = await make((text) =>
      text.includes("storage_pending_left")
        ? { rows: [{ pending: "t" }] }
        : undefined
    )
    const error = await failureOf(runtime.attachFile(session, input))
    expect(error.error).toEqual({
      code: "command.rejected",
      reason: "storage.attach-invalid",
    })
    expect(db.calls.at(-2)).toEqual(ROLLBACK)
    expect(db.calls).not.toContainEqual(COMMIT)
  })

  it("rolls back on a leftover answer that is no boolean", async () => {
    const { runtime, log } = await make((text) =>
      text.includes("storage_pending_left") ? { rows: [] } : undefined
    )
    const error = await failureOf(runtime.attachFile(session, input))
    expect(error.error).toEqual({ code: "command.internal" })
    expect(log).toHaveBeenCalled()
  })

  it("retries 40001 as a new transaction with the same id, one file_attach per attempt", async () => {
    let saves = 0
    const { db, runtime } = await make((text) =>
      text.includes("document_save") && saves++ === 0
        ? { error: { code: "40001", message: "retry" } }
        : undefined
    )
    await runtime.attachFile(session, input)
    const attaches = db.calls.filter(
      (c) => "text" in c && c.text.includes("file_attach")
    )
    expect(attaches).toEqual([attachCall(), attachCall()])
    expect(db.calls.filter((c) => "connect" in c)).toHaveLength(2)
    expect(
      db.calls.filter(
        (c) => "text" in c && c.text === "BEGIN ISOLATION LEVEL READ COMMITTED"
      )
    ).toHaveLength(2)
    expect(db.calls).toContainEqual(ROLLBACK)
  })

  it("exhausts the retries with command.retry-exhausted and commitUnknown false", async () => {
    const { runtime } = await make((text) =>
      text.includes("document_save")
        ? { error: { code: "40001", message: "retry" } }
        : undefined
    )
    const error = await failureOf(runtime.attachFile(session, input))
    expect(error.error).toEqual({ code: "command.retry-exhausted" })
    expect(error.commitUnknown).toBe(false)
  })

  it("flags commitUnknown when the session closes after COMMIT was sent", async () => {
    let commits = 0
    const { runtime } = await make((text) =>
      text === "COMMIT" && commits++ > 0
        ? { error: new Error("ECONNRESET") }
        : undefined
    )
    const error = await failureOf(runtime.attachFile(session, input))
    expect(error.error).toEqual({ code: "command.unavailable" })
    expect(error.commitUnknown).toBe(true)
  })

  it("does not flag commitUnknown on a database refusal at COMMIT", async () => {
    let commits = 0
    const { runtime } = await make((text) =>
      text === "COMMIT" && commits++ > 0
        ? { error: { code: "23505", message: "dup" } }
        : undefined
    )
    const error = await failureOf(runtime.attachFile(session, input))
    expect(error.commitUnknown).toBe(false)
  })

  it("does not flag commitUnknown on an unavailable database before COMMIT", async () => {
    const { runtime } = await make((text) =>
      text.includes("file_attach")
        ? { error: new Error("ECONNRESET") }
        : undefined
    )
    const error = await failureOf(runtime.attachFile(session, input))
    expect(error.error).toEqual({ code: "command.unavailable" })
    expect(error.commitUnknown).toBe(false)
  })

  it("refuses a session without a user before file_attach", async () => {
    const { db, runtime } = await make((text) =>
      text.includes("current_user_id")
        ? { rows: [{ user_id: null }] }
        : undefined
    )
    const error = await failureOf(runtime.attachFile(session, input))
    expect(error.error).toEqual({ code: "command.unauthenticated" })
    expect(db.calls).toEqual([...OPEN, ROLLBACK, { release: false }])
  })
})

describe("checkUpload", () => {
  const check = { object: DOC, scope: COMPANY }

  it("asks storage_headroom in a READ ONLY transaction under the request role", async () => {
    const { db, runtime } = await make()
    expect(await runtime.checkUpload(session, check)).toEqual({
      maxBytes: 1000,
      mediaTypes: ["text/plain"],
      instance: BOUND,
    })
    expect(db.calls).toEqual([
      { connect: true },
      { text: "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY", params: [] },
      expect.objectContaining({
        params: expect.arrayContaining(["authenticated"]),
      }),
      {
        text: 'SELECT "simetra"."storage_headroom"($1::uuid, $2::uuid) AS ok',
        params: [DOC_ID, COMPANY],
      },
      FILES_ROLE,
      { text: 'SELECT "simetra"."storage_instance_id"() AS id', params: [] },
      COMMIT,
      { release: false },
    ])
  })

  it("answers null on a refusal of headroom and does not read the binding", async () => {
    const { db, runtime } = await make((text) =>
      text.includes("storage_headroom") ? { rows: [{ ok: "f" }] } : undefined
    )
    expect(await runtime.checkUpload(session, check)).toBeNull()
    expect(
      db.calls.some((c) => "text" in c && c.text.includes("instance_id"))
    ).toBe(false)
  })

  it("reads the binding on every call, with no cache of the runtime", async () => {
    let binding = BOUND
    const { runtime } = await make((text) =>
      text.includes("storage_instance_id")
        ? { rows: [{ id: binding }] }
        : undefined
    )
    expect((await runtime.checkUpload(session, check))?.instance).toBe(BOUND)
    binding = "77777777-7777-4777-8777-777777777777:1:2:4"
    expect((await runtime.checkUpload(session, check))?.instance).toBe(binding)
  })

  it("refuses an answer that is not a binding (a bare uuid)", async () => {
    const { runtime } = await make((text) =>
      text.includes("storage_instance_id")
        ? { rows: [{ id: "77777777-7777-4777-8777-777777777777" }] }
        : undefined
    )
    await expect(runtime.checkUpload(session, check)).rejects.toBeInstanceOf(
      CommandFailure
    )
  })

  it("the binding of the check is what put judges: a promotion of a live process is refused, a rebind lets the next upload pass", async () => {
    let binding = BOUND
    const { runtime } = await make((text) =>
      text.includes("storage_instance_id")
        ? { rows: [{ id: binding }] }
        : text.includes("pg_is_in_recovery")
          ? { rows: [{ recovery: "f" }] }
          : undefined
    )
    const objects = new Map<string, Uint8Array>()
    const client: S3ClientLike = {
      putObject: async (i) => void objects.set(i.Key, i.Body),
      getObject: async (i) => {
        const o = objects.get(i.Key)
        if (o === undefined)
          throw Object.assign(new Error("no key"), { name: "NoSuchKey" })
        return {
          Body: {
            transformToWebStream: () =>
              new ReadableStream({
                start(c) {
                  c.enqueue(o)
                  c.close()
                },
              }),
          },
          ContentLength: o.byteLength,
        }
      },
      deleteObject: async (i) => void objects.delete(i.Key),
      listObjectsV2: async () => ({ Contents: [], IsTruncated: false }),
    }
    const store = fromS3Client(client, "b")
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(1))
          c.close()
        },
      })
    const upload = async (key: string) => {
      const limits = (await runtime.checkUpload(session, check))!
      return store.put(key, body(), {
        contentType: "text/plain",
        maxBytes: limits.maxBytes,
        instance: limits.instance,
      })
    }
    await upload(fileObjectKey(DOC_ID, ID))
    binding = "77777777-7777-4777-8777-777777777777:1:2:4"
    // Той самий процес: відбиток іншого timeline береться свіжим, а маркер
    // бакета ще несе старий.
    await expect(upload(fileObjectKey(DOC_ID, OTHER))).rejects.toMatchObject({
      reason: "binding-changed",
    })
    await runtime.rebindFileStore(store)
    await expect(upload(fileObjectKey(DOC_ID, OTHER))).resolves.toEqual({
      size: 1,
    })
  })

  it.each([
    ["a guest", { ...session, is_anonymous: true }, check],
    [
      "an unknown object",
      session,
      { object: { kind: "Catalog" as const, name: "X" } },
    ],
    ["a bad scope", session, { object: DOC, scope: OTHER.slice(1) }],
    ["no scope", session, { object: DOC }],
  ])("answers null for %s without the database", async (_, who, what) => {
    const { db, runtime } = await make()
    expect(await runtime.checkUpload(who, what)).toBeNull()
    expect(db.calls).toEqual([])
  })

  it("answers null for an object without storage", async () => {
    const { db, runtime } = await setup(undefined, {
      catalog: runtimeCatalogSchema.parse({
        ...storageCatalog,
        objects: [document(false)],
      }),
    })
    expect(await runtime.checkUpload(session, check)).toBeNull()
    expect(db.calls).toEqual([])
  })
})

describe("attachFile input", () => {
  it("lets the server name and scope win over fields of the same attributes", async () => {
    const { db, runtime } = await make()
    await runtime.attachFile(session, {
      ...input,
      fields: { fileName: "evil.txt", company: OTHER, note: "n" },
    })
    const core = db.calls.find(
      (c) => "text" in c && c.text.includes("document_save")
    )
    expect(core).toEqual(saveCall)
  })

  it("refuses an invalid session with FileAttachFailure, without the database", async () => {
    const { db, runtime } = await make()
    const error = await failureOf(
      runtime.attachFile({ role: "authenticated" } as never, input)
    )
    expect(error.commitUnknown).toBe(false)
    expect(db.calls).toEqual([])
  })

  it("wraps a throwing getter in fields into FileAttachFailure", async () => {
    const { db, runtime } = await make()
    const fields = {
      get note(): string {
        throw new Error("boom")
      },
    }
    const error = await failureOf(
      runtime.attachFile(session, { ...input, fields })
    )
    expect(error.error.code).toBe("command.invalid")
    expect(db.calls).toEqual([])
  })
})

describe("reconcileFiles", () => {
  const INSTANCE = "77777777-7777-4777-8777-777777777777:1:2:3"
  const ORPHAN = "55555555-5555-4555-8555-555555555555"
  const DB_MS = Date.UTC(2026, 10, 22)
  const answers: Override = (text) => {
    if (text.includes("pg_is_in_recovery")) return { rows: [{ recovery: "f" }] }
    if (text.includes("storage_pending_sweep")) return { rows: [{ n: "2" }] }
    if (text.includes("storage_instance_id"))
      return { rows: [{ id: INSTANCE }] }
    if (text.includes("extract(epoch")) return { rows: [{ ms: String(DB_MS) }] }
    if (text.includes("storage_row_page")) return { rows: [] }
    if (text.includes("storage_rows_exist")) return { rows: [] }
    return undefined
  }
  const key = `o/${DOC_ID}/${ORPHAN}`
  const store = (lastModified: Date) => {
    const deleted: string[] = []
    return {
      deleted,
      store: {
        put: () => Promise.reject(new Error("unused")),
        get: () => Promise.reject(new Error("unused")),
        delete: async (k: string) => void deleted.push(k),
        async *list() {
          yield { key, lastModified }
        },
        async *listPrefixes() {
          yield `o/${DOC_ID}/`
        },
        checkInstance: async () => undefined,
        rebind: async () => undefined,
      },
    }
  }

  it("asks the database clock and the row functions under the storage role", async () => {
    const { db, runtime } = await make(answers)
    // Об'єкт старший за 24 год за годинником БАЗИ, а не host-а
    const s = store(new Date(DB_MS - 25 * 3600 * 1000))
    const report = await runtime.reconcileFiles(s.store, { log: () => {} })
    expect(report).toMatchObject({ listed: 1, deleted: 1, refused: null })
    expect(s.deleted).toEqual([key])
    const texts = db.calls.flatMap((c) => ("text" in c ? [c.text] : []))
    expect(texts.filter((t) => t === FILES_ROLE.text).length).toBeGreaterThan(0)
    expect(texts.some((t) => t.includes("extract(epoch FROM now())"))).toBe(
      true
    )
  })

  it("keeps an object younger than 24 h by the database clock", async () => {
    const { runtime } = await make(answers)
    const s = store(new Date(DB_MS - 23 * 3600 * 1000))
    expect(
      (await runtime.reconcileFiles(s.store, { log: () => {} })).deleted
    ).toBe(0)
    expect(s.deleted).toEqual([])
  })
  it("sweeps the attach records of finished transactions under the storage role and reports the count", async () => {
    const { db, runtime } = await make(answers)
    const s = store(new Date(DB_MS))
    const report = await runtime.reconcileFiles(s.store, { log: () => {} })
    expect(report.pendingSwept).toBe(2)
    const at = db.calls.findIndex(
      (c) => "text" in c && c.text.includes("storage_pending_sweep")
    )
    expect(db.calls.slice(0, at).filter((c) => "text" in c)).toContainEqual(
      FILES_ROLE
    )
    expect(
      db.calls.filter(
        (c) => "text" in c && c.text === "BEGIN ISOLATION LEVEL READ COMMITTED"
      ).length
    ).toBeGreaterThan(0)
  })

  it("deletes nothing, sweeps nothing and reads no binding while the database is in recovery", async () => {
    const { db, runtime } = await make((text, params) =>
      text.includes("pg_is_in_recovery")
        ? { rows: [{ recovery: "t" }] }
        : answers(text, params)
    )
    const s = store(new Date(DB_MS - 25 * 3600 * 1000))
    const log: unknown[] = []
    const report = await runtime.reconcileFiles(s.store, {
      log: (e) => log.push(e),
    })
    expect(report).toMatchObject({
      deleted: 0,
      refused: "recovery",
      pendingSwept: 0,
    })
    expect(s.deleted).toEqual([])
    const texts = db.calls.flatMap((c) => ("text" in c ? [c.text] : []))
    expect(texts.some((t) => t.includes("storage_pending_sweep"))).toBe(false)
    expect(texts.some((t) => t.includes("storage_instance_id"))).toBe(false)
    expect(log).toMatchObject([{ kind: "refused", reason: "recovery" }])
  })

  it("stops before the deletion when a promotion happens during the listing", async () => {
    let asked = 0
    const { runtime } = await make((text, params) =>
      text.includes("pg_is_in_recovery")
        ? { rows: [{ recovery: asked++ === 0 ? "f" : "t" }] }
        : answers(text, params)
    )
    const s = store(new Date(DB_MS - 25 * 3600 * 1000))
    const report = await runtime.reconcileFiles(s.store, { log: () => {} })
    expect(report.refused).toBe("recovery")
    expect(s.deleted).toEqual([])
  })

  it("reads the binding fresh on every run", async () => {
    let binding = INSTANCE
    const { runtime } = await make((text, params) =>
      text.includes("storage_instance_id")
        ? { rows: [{ id: binding }] }
        : answers(text, params)
    )
    const seen: string[] = []
    const s = store(new Date(DB_MS))
    const checking = {
      ...s.store,
      checkInstance: async (i: string) => void seen.push(i),
    }
    binding = "77777777-7777-4777-8777-777777777777:1:2:4"
    await runtime.reconcileFiles(checking, { log: () => {} })
    expect(seen).toEqual([binding])
  })

  it("reports a changed binding as its own refusal, with no deletion", async () => {
    const { runtime } = await make(answers)
    const s = store(new Date(DB_MS - 25 * 3600 * 1000))
    const changed = {
      ...s.store,
      checkInstance: async () => {
        throw new FileStoreError("binding-changed", "copy")
      },
    }
    const report = await runtime.reconcileFiles(changed, { log: () => {} })
    expect(report).toMatchObject({ refused: "binding", deleted: 0 })
    expect(s.deleted).toEqual([])
  })
})

describe("rebindFileStore", () => {
  const INSTANCE = "77777777-7777-4777-8777-777777777777:1:2:3"
  const answers =
    (recovery: "t" | "f"): Override =>
    (text) => {
      if (text.includes("pg_is_in_recovery")) return { rows: [{ recovery }] }
      if (text.includes("storage_instance_id"))
        return { rows: [{ id: INSTANCE }] }
      return undefined
    }
  const store = () => {
    const rebound: string[] = []
    return {
      rebound,
      store: { rebind: async (i: string) => void rebound.push(i) } as never,
    }
  }

  it("rewrites the marker with the binding read from the database", async () => {
    const { runtime } = await make(answers("f"))
    const s = store()
    await runtime.rebindFileStore(s.store)
    expect(s.rebound).toEqual([INSTANCE])
  })

  it("is refused on a standby, nothing is rewritten", async () => {
    const { runtime } = await make(answers("t"))
    const s = store()
    await expect(runtime.rebindFileStore(s.store)).rejects.toMatchObject({
      reason: "in-recovery",
    })
    expect(s.rebound).toEqual([])
  })
})
