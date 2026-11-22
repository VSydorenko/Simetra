import {
  CommandFailure,
  runtimeCatalogSchema,
  type RuntimeCatalog,
} from "simetra/model"
import { describe, expect, it, vi } from "vitest"
import { FileAttachFailure } from "../transaction"
import type { FileStore } from "../file-store"
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
const deleted = (id = ID) =>
  JSON.stringify({ id, version: 2, company_id: COMPANY })

const FILES_ROLE = { text: 'SET LOCAL ROLE "simetra_files"', params: [] }
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
  if (text.includes("document_delete")) return { rows: [{ r: deleted() }] }
  if (text.includes("storage_pending_left")) return { rows: [{ pending: "f" }] }
  if (text.includes("storage_headroom")) return { rows: [{ ok: "t" }] }
  return undefined
}
const over =
  (extra: Override): Override =>
  (text, params) =>
    extra(text, params) ?? base(text, params)
const make = (extra: Override = () => undefined, files?: FileStore) =>
  setup(over(extra), { catalog: storageCatalog, ...(files ? { files } : {}) })

const fakeFiles = () => {
  const store = {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(async () => undefined),
    list: vi.fn(),
    checkInstance: vi.fn(),
  }
  return { store: store as unknown as FileStore, remove: store.delete }
}

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
    await failureOf(
      runtime.attachFile(session, {
        ...input,
        fields: { fileSize: 1, note: "n" },
      })
    )
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
      COMMIT,
      { release: false },
    ])
  })

  it("answers null on a refusal of headroom", async () => {
    const { runtime } = await make((text) =>
      text.includes("storage_headroom") ? { rows: [{ ok: "f" }] } : undefined
    )
    expect(await runtime.checkUpload(session, check)).toBeNull()
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

describe("fileInstance", () => {
  const INSTANCE = "77777777-7777-4777-8777-777777777777"
  const answerId: Override = (text) =>
    text.includes("storage_instance_id")
      ? { rows: [{ id: INSTANCE }] }
      : undefined

  it("resolves the uuid in a read-write transaction under the storage role and caches it", async () => {
    const { db, runtime } = await make(answerId)
    expect(await runtime.fileInstance()).toBe(INSTANCE)
    expect(await runtime.fileInstance()).toBe(INSTANCE)
    expect(db.calls).toEqual([
      { connect: true },
      BEGIN,
      FILES_ROLE,
      { text: 'SELECT "simetra"."storage_instance_id"() AS id', params: [] },
      COMMIT,
      { release: false },
    ])
  })

  it("does not cache a failure", async () => {
    let n = 0
    const { runtime } = await make((text, params) =>
      text.includes("storage_instance_id") && n++ === 0
        ? { error: { code: "XX000", message: "x" } }
        : answerId(text, params)
    )
    await expect(runtime.fileInstance()).rejects.toBeInstanceOf(CommandFailure)
    expect(await runtime.fileInstance()).toBe(INSTANCE)
  })
})

describe("deleting bytes after the commit", () => {
  const remove = {
    action: "delete",
    object: DOC,
    id: ID,
    expectedVersion: 1,
  } as const
  const deleteCall = call("document_delete", "$1::uuid, $2::bigint", [ID, "1"])

  it("deletes the key from the confirmed row after COMMIT of a client command", async () => {
    const { store, remove: del } = fakeFiles()
    const { db, runtime } = await make(undefined, store)
    await runtime.run(session, remove)
    expect(del).toHaveBeenCalledExactlyOnceWith(`o/${DOC_ID}/${ID}`)
    expect(db.calls).toContainEqual(deleteCall)
  })

  it("takes the key from the row the core returned, not from the input id", async () => {
    const { store, remove: del } = fakeFiles()
    const { runtime } = await make(
      (text) =>
        text.includes("document_delete")
          ? { rows: [{ r: deleted(OTHER) }] }
          : undefined,
      store
    )
    await runtime.run(session, remove)
    expect(del).toHaveBeenCalledExactlyOnceWith(`o/${DOC_ID}/${OTHER}`)
  })

  it("does not delete before COMMIT and never after a rollback", async () => {
    const { store, remove: del } = fakeFiles()
    let commits = 0
    const { runtime } = await make((text) => {
      // Перший `COMMIT` — створення рантайму.
      if (text === "COMMIT" && commits++ > 0) {
        return { error: { code: "23505", message: "x" } }
      }
      return undefined
    }, store)
    del.mockImplementation(async () => {
      throw new Error("must not run")
    })
    await expect(runtime.run(session, remove)).rejects.toBeInstanceOf(
      CommandFailure
    )
    expect(del).not.toHaveBeenCalled()
  })

  it("a retry deletes once, for the committed attempt only", async () => {
    const { store, remove: del } = fakeFiles()
    let n = 0
    const { runtime } = await make(
      (text) =>
        text.includes("document_delete") && n++ === 0
          ? { error: { code: "40001", message: "retry" } }
          : undefined,
      store
    )
    await runtime.run(session, remove)
    expect(del).toHaveBeenCalledTimes(1)
  })

  it("does not touch bytes on markDeletion", async () => {
    const { store, remove: del } = fakeFiles()
    const { runtime } = await make(
      (text) =>
        text.includes("document_mark_deletion")
          ? { rows: [{ r: docRow() }] }
          : undefined,
      store
    )
    await runtime.run(session, {
      action: "markDeletion",
      object: DOC,
      id: ID,
      expectedVersion: 1,
      mark: true,
    })
    expect(del).not.toHaveBeenCalled()
  })

  it("does nothing without the files option", async () => {
    const { runtime } = await make()
    await expect(runtime.run(session, remove)).resolves.toBeDefined()
  })

  it("logs a failed deletion and still returns the result", async () => {
    const { store, remove: del } = fakeFiles()
    const failure = new Error("s3 down")
    del.mockImplementation(async () => {
      throw failure
    })
    const { runtime, log } = await make(undefined, store)
    await expect(runtime.run(session, remove)).resolves.toBeDefined()
    expect(log).toHaveBeenCalledWith({ kind: "afterCommit", error: failure })
  })

  it("deletes bytes of a ctx.run delete phase too", async () => {
    const { store, remove: del } = fakeFiles()
    const { runtime } = await setup(
      over(() => undefined),
      {
        catalog: runtimeCatalogSchema.parse({
          ...storageCatalog,
          objects: [
            ...storageCatalog.objects,
            commandObject({ name: "Client", table: "client" }),
          ],
        }),
        files: store,
        objectModules: {
          "Catalog.Client": {
            async onWrite({ ctx }) {
              await ctx.run(remove)
            },
          },
        },
      }
    )
    await runtime.run(session, {
      action: "create",
      object: { kind: "Catalog", name: "Client" },
      id: OTHER,
      values: { code: "A", company: COMPANY },
    })
    expect(del).toHaveBeenCalledExactlyOnceWith(`o/${DOC_ID}/${ID}`)
  })
})
