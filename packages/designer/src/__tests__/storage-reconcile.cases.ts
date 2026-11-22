import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { fileObjectKey } from "simetra/model"
import {
  createCommandRuntime,
  fromPgPool,
  type CommandRuntime,
  type ReconcileLogEntry,
} from "simetra/server"
import {
  TICKET_WRITER_ID,
  reconcileFilesAged,
} from "../../../simetra/test/support"
import { seedRuntimeActor, seedUnderMaintenance, sessionOf } from "./support/db"
import { LIMIT } from "./storage-sql.support"
import type { Env } from "./storage-env.support"

/**
 * Звірка бакета з базою на справжньому Postgres і S3 стека (ПГ-5, І10, І12):
 * спільні кейси файлів `storage-reconcile.postgres.db.test.ts` (Garage) і
 * `storage.supabase.db.test.ts` (S3 Supabase). Вік 24 год міряє годинник
 * бази, тож тест не підміняє його: правило з типовим віком перевіряється
 * публічним шляхом рантайму на свіжому об'єкті, а прибирання сироти — тестовим
 * швом `reconcileFilesAged` з віком 0 (публічного параметра віку немає).
 */

const TICKET = { kind: "Catalog" as const, name: "Ticket" }
const MARKER = "simetra-instance"
const bodyOf = (text: string) => new Blob([text]).stream()
const bytesOf = (text: string) => new TextEncoder().encode(text)

export function defineReconcileCases(env: () => Env): void {
  const runtime = (): Promise<CommandRuntime> =>
    createCommandRuntime({
      database: fromPgPool(env().pool),
      catalog: env().catalog,
    })
  const objectId = () =>
    env().catalog.objects.find((o) => o.name === "Ticket")!.id

  /** Байти в бакеті без рядка: сирота. */
  const putOrphan = async (
    rt: CommandRuntime,
    object = objectId()
  ): Promise<string> => {
    const key = fileObjectKey(object, randomUUID())
    await env().files.put(key, bodyOf("x"), {
      contentType: "text/plain",
      maxBytes: LIMIT,
      instance: await rt.fileInstance(),
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
        instance: await rt.fileInstance(),
      })
    await rt.attachFile(sessionOf(actor.user), {
      object: TICKET,
      scope: actor.org,
      id,
      name: "a.txt",
      size: 5,
      contentType: "text/plain",
    })
    return { id, key }
  }
  const exists = async (key: string) => (await env().files.get(key)) !== null
  /** Публічний шлях рантайму (вік 24 год) або, з `aged`, шов тесту з віком 0. */
  const reconcile = async (
    rt: CommandRuntime,
    options: { aged?: true } = {}
  ) => {
    const log: ReconcileLogEntry[] = []
    const sink = { log: (e: ReconcileLogEntry) => log.push(e) }
    const report =
      options.aged === true
        ? await reconcileFilesAged(rt, env().files, sink, 0)
        : await rt.reconcileFiles(env().files, sink)
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
      const actor = await seedRuntimeActor(env().owner, [TICKET_WRITER_ID])
      const { key } = await putFile(rt, true, actor)
      const usage = async () =>
        (
          await env().owner.query<{ bytes: string }>(
            "SELECT bytes FROM simetra.storage_usage WHERE scope = $1",
            [actor.org]
          )
        ).rows.map((r) => Number(r.bytes))
      expect(await usage()).toEqual([5])
      // Модель не фіксує дію зовнішнього ключа скоупу: тест задає каскад
      // сам, щоб шлях «рядок зник не командою» був справжнім
      const column = env().catalog.objects.find(
        (o) => o.name === "Ticket"
      )!.scopeColumn!
      const { rows: fks } = await env().owner.query<{ conname: string }>(
        `SELECT c.conname FROM pg_constraint c
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          WHERE c.conrelid = 'public.ticket'::regclass AND c.contype = 'f' AND a.attname = $1`,
        [column]
      )
      for (const { conname } of fks)
        await env().owner.query(
          `ALTER TABLE public.ticket DROP CONSTRAINT "${conname}"`
        )
      await env().owner.query(
        `ALTER TABLE public.ticket ADD CONSTRAINT ticket_scope_cascade_test FOREIGN KEY ("${column}") REFERENCES public.organization (id) ON DELETE CASCADE`
      )
      await seedUnderMaintenance(env().owner, async () => {
        await env().owner.query(
          "DELETE FROM public.org_role_assignments WHERE org_id = $1",
          [actor.org]
        )
        await env().owner.query(
          "DELETE FROM public.org_member WHERE org_id = $1",
          [actor.org]
        )
        await env().owner.query(
          "DELETE FROM public.organization WHERE id = $1",
          [actor.org]
        )
      })
      const left = await env().owner.query(
        `SELECT 1 FROM public.ticket WHERE "${column}" = $1`,
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
      const instance = await rt.fileInstance()
      const key = await putOrphan(rt)
      try {
        await setMarker(randomUUID())
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
