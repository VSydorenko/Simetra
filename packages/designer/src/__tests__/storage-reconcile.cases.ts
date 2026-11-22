import { randomUUID } from "node:crypto"
import pg from "pg"
import { describe, expect, it } from "vitest"
import { fileObjectKey } from "simetra/model"
import {
  createCommandRuntime,
  fromPgPool,
  type CommandDatabase,
  type CommandRuntime,
  type ReconcileLogEntry,
} from "simetra/server"
import { seedRuntimeActor, seedUnderMaintenance, sessionOf } from "./support/db"
import { ATTACHMENT_WRITER_ID, LIMIT } from "./storage-sql.support"
import type { Env } from "./storage-env.support"

/**
 * Звірка бакета з базою на справжньому Postgres і S3 стека (ПГ-5, І10, І12):
 * спільні кейси файлів `storage-reconcile.postgres.db.test.ts` (Garage) і
 * `storage.supabase.db.test.ts` (S3 Supabase). Вік 24 год міряє годинник
 * бази, тож тест не підміняє його: правило з типовим віком перевіряється
 * публічним шляхом рантайму на свіжому об'єкті, а прибирання сироти — рантаймом,
 * чий порт бази зсуває відповідь `now()` звірки на добу вперед (годинник «бази»
 * з погляду рантайму; виробничий код ручки віку не має).
 */

const DAY_MS = 24 * 60 * 60 * 1000
const DB_NOW_TEXT = "extract(epoch FROM now())"

/** Порт бази, що зсуває відповідь запиту `now()` звірки; решту не чіпає. */
function withClockShift(
  inner: CommandDatabase,
  shiftMs: number
): CommandDatabase {
  return {
    async connect() {
      const client = await inner.connect()
      return {
        release: (destroy) => client.release(destroy),
        query: async (text, params) => {
          const res = await client.query(text, params)
          if (!text.includes(DB_NOW_TEXT)) return res
          return {
            ...res,
            rows: res.rows.map((row) => ({
              ...row,
              ms: String(Number(row.ms) + shiftMs),
            })),
          }
        },
      }
    },
  }
}

const ATTACHMENT = { kind: "Catalog" as const, name: "Attachment" }
const MARKER = "simetra-instance"
const bodyOf = (text: string) => new Blob([text]).stream()
const bytesOf = (text: string) => new TextEncoder().encode(text)

/** Середовище кейсів збирають із `ORG_ROOT_CASCADE`: перший кейс спирається на каскад кореня. */
export function defineReconcileCases(env: () => Env): void {
  const runtime = (shiftMs = 0): Promise<CommandRuntime> =>
    createCommandRuntime({
      database: withClockShift(fromPgPool(env().pool), shiftMs),
      catalog: env().catalog,
    })
  /** Відбиток прив'язки: його віддає `checkUpload` у тій самій транзакції. */
  const instanceOf = async (rt: CommandRuntime): Promise<string> =>
    (await rt.checkUpload(env().writer.session, {
      object: ATTACHMENT,
      scope: env().writer.org,
    }))!.instance
  const objectId = () =>
    env().catalog.objects.find((o) => o.name === "Attachment")!.id

  /** Байти в бакеті без рядка: сирота. */
  const putOrphan = async (
    rt: CommandRuntime,
    object = objectId()
  ): Promise<string> => {
    const key = fileObjectKey(object, randomUUID())
    await env().files.put(key, bodyOf("x"), {
      contentType: "text/plain",
      maxBytes: LIMIT,
      instance: await instanceOf(rt),
    })
    return key
  }
  /** Байти й рядок файлу за вхідним шляхом: `put` і `attachFile`. */
  const putFile = async (
    rt: CommandRuntime,
    withBytes = true,
    actor: { org: string; user: string } = env().writer
  ) => {
    const id = randomUUID()
    const key = fileObjectKey(objectId(), id)
    if (withBytes)
      await env().files.put(key, bodyOf("hello"), {
        contentType: "text/plain",
        maxBytes: LIMIT,
        instance: await instanceOf(rt),
      })
    await rt.attachFile(sessionOf(actor.user), {
      object: ATTACHMENT,
      scope: actor.org,
      id,
      name: "a.txt",
      size: 5,
      contentType: "text/plain",
    })
    return { id, key }
  }
  const exists = async (key: string) => (await env().files.get(key)) !== null
  /** Публічний шлях рантайму (вік 24 год) або, з `aged`, рантайм із годинником бази на добу вперед. */
  const reconcile = async (
    rt: CommandRuntime,
    options: { aged?: true } = {}
  ) => {
    const log: ReconcileLogEntry[] = []
    const sink = { log: (e: ReconcileLogEntry) => log.push(e) }
    const runner = options.aged === true ? await runtime(2 * DAY_MS) : rt
    const report = await runner.reconcileFiles(env().files, sink)
    return { report, log }
  }
  const setMarker = (value: string) =>
    env().s3.putObject({
      Bucket: env().bucket,
      Key: MARKER,
      Body: bytesOf(value),
      ContentLength: bytesOf(value).byteLength,
    })

  describe("reconcileFiles", () => {
    it("removes the bytes of a row that went with its scope row by cascade, after the age and by the database clock", async () => {
      const rt = await runtime()
      // Своя організація й свій писач: каскад знесе лише її рядок
      const actor = await seedRuntimeActor(env().owner, [ATTACHMENT_WRITER_ID])
      const { key } = await putFile(rt, true, actor)
      const usage = async () =>
        (
          await env().owner.query<{ bytes: string }>(
            "SELECT bytes FROM simetra.storage_usage WHERE scope = $1",
            [actor.org]
          )
        ).rows.map((r) => Number(r.bytes))
      expect(await usage()).toEqual([5])
      // Кореневий каскад дає модель (`onRootDelete: "cascade"` виду `org`,
      // `ORG_ROOT_CASCADE`): корінь знімає членів, призначення й рядок файлу
      const column = env().catalog.objects.find(
        (o) => o.name === "Attachment"
      )!.scopeColumn!
      await seedUnderMaintenance(env().owner, async () => {
        await env().owner.query(
          "DELETE FROM public.organization WHERE id = $1",
          [actor.org]
        )
      })
      const left = await env().owner.query(
        `SELECT 1 FROM public.attachment WHERE "${column}" = $1`,
        [actor.org]
      )
      expect(left.rows).toEqual([])
      // Тригер обліку відпрацював на каскаді
      expect((await usage()).every((bytes) => bytes === 0)).toBe(true)
      // Публічний шлях (24 год): свіжі байти лишаються
      const fresh = await reconcile(rt)
      expect(fresh.report.deleted).toBe(0)
      expect(await exists(key)).toBe(true)
      const aged = await reconcile(rt, { aged: true })
      expect(aged.report).toMatchObject({ deleted: 1, refused: null })
      expect(await exists(key)).toBe(false)
    })

    it("keeps the bytes of a live row that only a read without RLS sees", async () => {
      const rt = await runtime()
      // Звірка не має користувача: рядок їй видно лише повз RLS, а не
      // «як тенанту»; сироту визначає наявність рядка в таблиці
      const { key } = await putFile(rt)
      const { report } = await reconcile(rt, { aged: true })
      expect(report.deleted).toBe(0)
      expect(await exists(key)).toBe(true)
    })

    it("reports a row without bytes", async () => {
      const rt = await runtime()
      const { id } = await putFile(rt, false)
      const { report, log } = await reconcile(rt, { aged: true })
      expect(report.rowsWithoutBytes).toBeGreaterThanOrEqual(1)
      expect(log).toContainEqual(
        expect.objectContaining({ kind: "row-without-bytes", id })
      )
    })

    it("only logs the prefix of an unknown object and does not delete under it", async () => {
      const rt = await runtime()
      const stranger = randomUUID()
      const key = await putOrphan(rt, stranger)
      try {
        const { report, log } = await reconcile(rt, { aged: true })
        expect(report.unknownPrefixes).toContain(`o/${stranger}/`)
        expect(log).toContainEqual({
          kind: "unknown-prefix",
          prefix: `o/${stranger}/`,
        })
        expect(report.deleted).toBe(0)
        expect(await exists(key)).toBe(true)
      } finally {
        await env().files.delete(key)
      }
    })

    it("refuses a bucket with another marker, and one with files but no marker: nothing is deleted", async () => {
      const rt = await runtime()
      const instance = await instanceOf(rt)
      const key = await putOrphan(rt)
      try {
        await setMarker(`${randomUUID()}:1:2:3`)
        const other = await reconcile(rt, { aged: true })
        expect(other.report).toMatchObject({ deleted: 0, refused: "instance" })
        expect(await exists(key)).toBe(true)

        await env().s3.deleteObject({ Bucket: env().bucket, Key: MARKER })
        const none = await reconcile(rt, { aged: true })
        expect(none.report).toMatchObject({ deleted: 0, refused: "instance" })
        expect(await exists(key)).toBe(true)
      } finally {
        await setMarker(instance)
        await env().files.delete(key)
      }
    })

    it("bindFileStore: a no-op on its own marker, foreign-bucket for another marker and for files without a marker", async () => {
      const rt = await runtime()
      const instance = await instanceOf(rt)
      const key = await putOrphan(rt)
      try {
        await expect(rt.bindFileStore(env().files)).resolves.toBeUndefined()
        await setMarker(`${randomUUID()}:1:2:3`)
        await expect(rt.bindFileStore(env().files)).rejects.toMatchObject({
          reason: "foreign-bucket",
        })
        await env().s3.deleteObject({ Bucket: env().bucket, Key: MARKER })
        await expect(rt.bindFileStore(env().files)).rejects.toMatchObject({
          reason: "foreign-bucket",
        })
      } finally {
        await setMarker(instance)
        await env().files.delete(key)
      }
    })

    it("refuses the marker of a restored or copied database by naming the changed part, and works again after the rebind", async () => {
      const rt = await runtime()
      const instance = await instanceOf(rt)
      const [uuid, system, database, timeline] = instance.split(":")
      const key = await putOrphan(rt)
      try {
        for (const changed of [
          `${uuid}:${system}1:${database}:${timeline}`,
          `${uuid}:${system}:${database}1:${timeline}`,
          `${uuid}:${system}:${database}:${timeline}1`,
        ]) {
          await setMarker(changed)
          const { report, log } = await reconcile(rt, { aged: true })
          expect(report).toMatchObject({ deleted: 0, refused: "binding" })
          expect(log).toContainEqual(
            expect.objectContaining({ kind: "refused", reason: "binding" })
          )
          expect(await exists(key)).toBe(true)
          // `put` теж відмовляє: байти не пишуться у бакет чужої копії
          await expect(
            env().files.put(
              fileObjectKey(objectId(), randomUUID()),
              bodyOf("x"),
              { contentType: "text/plain", maxBytes: LIMIT, instance }
            )
          ).rejects.toMatchObject({ reason: "binding-changed" })
        }
        await rt.rebindFileStore(env().files)
        const { report } = await reconcile(rt, { aged: true })
        expect(report).toMatchObject({ deleted: 1, refused: null })
        expect(await exists(key)).toBe(false)
      } finally {
        await setMarker(instance)
        await env().files.delete(key)
      }
    })

    it("put judges the binding of the same runtime's latest checkUpload: refused after the marker moved, passes after the rebind without a restart", async () => {
      const rt = await runtime()
      const instance = await instanceOf(rt)
      const [uuid, system, database, timeline] = instance.split(":")
      const key = fileObjectKey(objectId(), randomUUID())
      const put = async () =>
        env().files.put(key, bodyOf("x"), {
          contentType: "text/plain",
          maxBytes: LIMIT,
          instance: await instanceOf(rt),
        })
      try {
        // Маркер бакета іншої копії: той самий живий рантайм, інший відбиток
        await setMarker(`${uuid}:${system}1:${database}:${timeline}`)
        await expect(put()).rejects.toMatchObject({
          reason: "binding-changed",
        })
        await rt.rebindFileStore(env().files)
        const written = await put()
        expect(written).toEqual({ size: 1 })
      } finally {
        await setMarker(instance)
        await env().files.delete(key)
      }
    })

    it("sweeps the attach records of finished transactions and leaves those of a running one", async () => {
      const rt = await runtime()
      const live = new pg.Client({ connectionString: env().url })
      await live.connect()
      const record = (xact: string) =>
        `INSERT INTO simetra.storage_pending (xact, object, id, size, content_type) VALUES (${xact}, $1, $2, 1, 'text/plain')`
      const liveId = randomUUID()
      try {
        await env().owner.query(record("'1'::xid8"), [objectId(), randomUUID()])
        await live.query("BEGIN")
        await live.query(record("pg_current_xact_id()"), [objectId(), liveId])
        const { report } = await reconcile(rt)
        expect(report.pendingSwept).toBeGreaterThanOrEqual(1)
        await live.query("COMMIT")
        const left = await env().owner.query<{ id: string }>(
          "SELECT id FROM simetra.storage_pending WHERE xact = '1'::xid8 OR id = $1",
          [liveId]
        )
        expect(left.rows).toEqual([{ id: liveId }])
      } finally {
        await live.query("ROLLBACK").catch(() => undefined)
        await live.end()
        await env().owner.query(
          "DELETE FROM simetra.storage_pending WHERE xact = '1'::xid8 OR id = $1",
          [liveId]
        )
      }
    })

    it("stops at more than 5 % and more than 20 orphans and deletes nothing", async () => {
      const rt = await runtime()
      const keys: string[] = []
      try {
        for (let i = 0; i < 21; i++) keys.push(await putOrphan(rt))
        const { report, log } = await reconcile(rt, { aged: true })
        expect(report).toMatchObject({ deleted: 0, refused: "guard" })
        expect(log).toContainEqual(
          expect.objectContaining({ kind: "refused", reason: "guard" })
        )
        for (const key of keys) expect(await exists(key)).toBe(true)
      } finally {
        for (const key of keys) await env().files.delete(key)
      }
    })
  })
}
