import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ZERO_UUID, fileObjectKey, CommandFailure } from "simetra/model"
import {
  FileAttachFailure,
  createCommandRuntime,
  fromPgPool,
  type CommandDatabase,
  type CommandRuntime,
} from "simetra/server"
import { LIMIT, STORAGE, TYPES } from "./storage-sql.support"
import { heldStorageEnv, type Env } from "./storage-env.support"

/**
 * Сховище файлів через T3 на справжньому Postgres і Garage (ПГ-5, І3, І11 і
 * повний цикл): `checkUpload` → `put` → `attachFile` → `read`. Відмови вирішує
 * база, байти — бакет `run-<тег>` прогону. Тест лише для стека `postgres` (суфікс файла):
 * його Garage — єдиний, який піднімає цей проєкт; `supabase` проходить цикл у
 * `storage.supabase.db.test.ts`.
 */

const TICKET = { kind: "Catalog" as const, name: "Ticket" }

/** Порт, що першому оператору за `pattern` дає `40001` замість виконання: відкат і повтор спроби. */
function failingOnce(
  base: CommandDatabase,
  pattern: RegExp
): { database: CommandDatabase; fired: () => boolean } {
  let failed = false
  const database: CommandDatabase = {
    async connect() {
      const client = await base.connect()
      return {
        async query(text, params) {
          if (!failed && pattern.test(text)) {
            failed = true
            throw Object.assign(new Error("serialization failure"), {
              code: "40001",
            })
          }
          return client.query(text, params)
        },
        release: (destroy) => client.release(destroy),
      }
    },
  }
  return { database, fired: () => failed }
}

const bodyOf = (text: string) => new Blob([text]).stream()

const target = heldStorageEnv()

describe("file storage over the runtime and the byte store", () => {
  let env: Env
  beforeAll(async () => {
    env = await target.open()
  }, 180_000)
  afterAll(() => target.close(), 60_000)

  const runtimeOf = (database: CommandDatabase = fromPgPool(env.pool)) =>
    createCommandRuntime({ database, catalog: env.catalog })
  const ticket = () => env.catalog.objects.find((o) => o.name === "Ticket")!
  const objectId = () => ticket().id
  const nameOf = (column: string) =>
    ticket().attributes.find((a) => a.column === column)!.name

  const rowsOf = async (id: string) =>
    (
      await env.owner.query<{
        file_name: string
        file_size: string
        file_content_type: string
      }>(
        "SELECT file_name, file_size, file_content_type FROM public.ticket WHERE id = $1",
        [id]
      )
    ).rows
  const usage = async (org: string) =>
    (
      await env.owner.query<{ bytes: string }>(
        "SELECT bytes FROM simetra.storage_usage WHERE scope = $1",
        [org]
      )
    ).rows.map((r) => Number(r.bytes))
  const pendingLeft = async () =>
    Number(
      (
        await env.owner.query<{ n: string }>(
          "SELECT count(*) AS n FROM simetra.storage_pending"
        )
      ).rows[0]!.n
    )
  const attach = (
    rt: CommandRuntime,
    id: string,
    patch: Partial<Parameters<CommandRuntime["attachFile"]>[1]> = {}
  ) =>
    rt.attachFile(env.writer.session, {
      object: TICKET,
      scope: env.writer.org,
      id,
      name: "a.txt",
      size: 5,
      contentType: "text/plain",
      ...patch,
    })

  it("runs checkUpload → put → attachFile → read and keeps the bytes", async () => {
    const rt = await runtimeOf()
    expect(
      await rt.checkUpload(env.writer.session, {
        object: TICKET,
        scope: env.writer.org,
      })
    ).toEqual({ maxBytes: STORAGE.maxBytes, mediaTypes: TYPES })
    const instance = await rt.fileInstance()
    const id = randomUUID()
    const key = fileObjectKey(objectId(), id)
    const put = await env.files.put(key, bodyOf("hello"), {
      contentType: "text/plain",
      maxBytes: LIMIT,
      instance,
    })
    expect(put).toEqual({ size: 5 })
    const before = await usage(env.writer.org)
    const result = await attach(rt, id, { size: put.size })
    expect(result.changes).toEqual([
      expect.objectContaining({ id, operation: "create" }),
    ])
    expect(await rowsOf(id)).toEqual([
      { file_name: "a.txt", file_size: "5", file_content_type: "text/plain" },
    ])
    expect(await usage(env.writer.org)).toEqual([(before[0] ?? 0) + 5])
    expect(await pendingLeft()).toBe(0)
    const read = await rt.read(env.writer.session, { object: TICKET, id })
    expect(read.rows).toHaveLength(1)
    const stored = await env.files.get(key)
    expect(await new Response(stored!.body).text()).toBe("hello")
  })

  it("checkUpload answers null for no right, a foreign scope and a guest", async () => {
    const rt = await runtimeOf()
    expect(
      await rt.checkUpload(env.reader.session, {
        object: TICKET,
        scope: env.reader.org,
      })
    ).toBeNull()
    expect(
      await rt.checkUpload(env.writer.session, {
        object: TICKET,
        scope: env.reader.org,
      })
    ).toBeNull()
    expect(
      await rt.checkUpload(
        { ...env.writer.session, is_anonymous: true },
        { object: TICKET, scope: env.writer.org }
      )
    ).toBeNull()
  })

  it("a retried attempt leaves one row and one accounting step", async () => {
    const injected = failingOnce(fromPgPool(env.pool), /ticket_save/)
    const rt = await runtimeOf(injected.database)
    const before = (await usage(env.writer.org))[0] ?? 0
    const id = randomUUID()
    await attach(rt, id)
    // Без цього тест зеленів би й без жодного повтору
    expect(injected.fired()).toBe(true)
    expect(await rowsOf(id)).toHaveLength(1)
    expect(await usage(env.writer.org)).toEqual([before + 5])
    expect(await pendingLeft()).toBe(0)
  })

  it("a refusal of file_attach leaves no row, no accounting and no record", async () => {
    const rt = await runtimeOf()
    const before = await usage(env.writer.org)
    const id = randomUUID()
    const error = await attach(rt, id, {
      contentType: "application/zip",
    }).then(
      () => {
        throw new Error("expected a refusal")
      },
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(FileAttachFailure)
    expect((error as FileAttachFailure).error).toEqual({
      code: "command.rejected",
      reason: "storage.attach-invalid",
    })
    expect((error as FileAttachFailure).commitUnknown).toBe(false)
    expect(await rowsOf(id)).toEqual([])
    expect(await usage(env.writer.org)).toEqual(before)
    expect(await pendingLeft()).toBe(0)
  })

  describe("І3: a file row needs file_attach in the same transaction", () => {
    const values = (name: string) => ({
      [nameOf("file_name")]: name,
      [nameOf(ticket().scopeColumn!)]: env.writer.org,
    })

    it("a client create is command.rejected storage.attach-missing", async () => {
      const rt = await runtimeOf()
      const id = randomUUID()
      const before = await usage(env.writer.org)
      const error = await rt
        .run(env.writer.session, {
          action: "create",
          object: TICKET,
          id,
          values: values("b.txt"),
        })
        .then(
          () => {
            throw new Error("expected a refusal")
          },
          (e: unknown) => e
        )
      expect(error).toBeInstanceOf(CommandFailure)
      expect((error as CommandFailure).error).toEqual({
        code: "command.rejected",
        reason: "storage.attach-missing",
      })
      expect(await rowsOf(id)).toEqual([])
      expect(await usage(env.writer.org)).toEqual(before)
    })

    it("a ctx.run create does not take the record of attachFile: the whole transaction rolls back", async () => {
      const first = randomUUID()
      const second = randomUUID()
      const rt = await createCommandRuntime({
        database: fromPgPool(env.pool),
        catalog: env.catalog,
        objectModules: {
          "Catalog.Ticket": {
            async onWrite({ ctx }) {
              await ctx.run({
                action: "create",
                object: TICKET,
                id: second,
                values: values("c.txt"),
              })
            },
          },
        },
      })
      const before = await usage(env.writer.org)
      const error = await attach(rt, first).then(
        () => {
          throw new Error("expected a refusal")
        },
        (e: unknown) => e
      )
      expect((error as FileAttachFailure).error).toEqual({
        code: "command.rejected",
        reason: "storage.attach-missing",
      })
      expect(await rowsOf(first)).toEqual([])
      expect(await rowsOf(second)).toEqual([])
      expect(await usage(env.writer.org)).toEqual(before)
      expect(await pendingLeft()).toBe(0)
    })
  })

  describe("І11: markDeletion keeps the file", () => {
    it("the row and the bytes stay and the accounting is unchanged; a delete is refused", async () => {
      const rt = await runtimeOf()
      const id = randomUUID()
      const key = fileObjectKey(objectId(), id)
      const instance = await rt.fileInstance()
      await env.files.put(key, bodyOf("keep"), {
        contentType: "text/plain",
        maxBytes: LIMIT,
        instance,
      })
      const created = await attach(rt, id, { size: 4 })
      const version = created.changes[0]!.version
      const before = await usage(env.writer.org)
      await rt.run(env.writer.session, {
        action: "markDeletion",
        object: TICKET,
        id,
        expectedVersion: version,
        mark: true,
      })
      expect(await rowsOf(id)).toHaveLength(1)
      expect(await usage(env.writer.org)).toEqual(before)
      expect(await env.files.get(key)).not.toBeNull()
      // Ядра `delete` у довідника зі `storage` немає
      const error = await rt
        .run(env.writer.session, {
          action: "delete",
          object: TICKET,
          id,
          expectedVersion: version + 1,
        })
        .then(
          () => {
            throw new Error("expected a refusal")
          },
          (e: unknown) => e
        )
      expect((error as CommandFailure).error.code).toBe("command.invalid")
      expect(await env.files.get(key)).not.toBeNull()
    })
  })

  it("fileInstance is the uuid of simetra.storage_instance and needs no write by the caller", async () => {
    const rt = await runtimeOf()
    const instance = await rt.fileInstance()
    const { rows } = await env.owner.query<{ id: string }>(
      "SELECT id FROM simetra.storage_instance"
    )
    expect(rows).toEqual([{ id: instance }])
    expect(instance).not.toBe(ZERO_UUID)
  })
})
