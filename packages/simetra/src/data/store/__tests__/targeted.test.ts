import { afterEach, describe, expect, it, vi } from "vitest"
import { inspectCore } from "../core"
import { TASK, id, setup, watch } from "./support"

/** Цільові тести поряд з модельним (огляд Codex, рішення архітекторки). */

const K1 = id(1)
const K2 = id(2)
const L1 = id(101)
const L2 = id(102)

async function two() {
  const ctx = setup()
  ctx.server.seed(TASK, [
    { id: K1, title: "A", rank: 1, body: "long" },
    { id: K2, title: "B", rank: 2 },
  ])
  const w = watch(
    ctx.session.view({ kind: "keys", object: TASK, keys: [K1, K2] })
  )
  await ctx.transport.drain()
  return { ...ctx, w, row: () => w.last.rows[0] }
}

describe("core targeted", () => {
  it("Рд24: a stale replica answer never lowers the version", async () => {
    const { server, transport, session } = setup()
    server.seed(TASK, [{ id: K1, title: "A", rank: 1 }])
    const w = watch(session.view({ kind: "keys", object: TASK, keys: [K1] }))
    await transport.settle()
    const load = transport.take() // знімок сервера v1
    server.edit(TASK, K1, { title: "B" })
    void session.refetchKeys(TASK, [K1])
    await transport.settle()
    transport.take().answer() // v2 — але ключа ще немає, refetch його не вставляє
    await transport.settle()
    load.answer() // v2
    await transport.settle()
    expect(inspectCore(session).row(TASK, K1)?.version).toBe(2)
    // Тепер застаріла відповідь перечитування (знімок v2 → після чужої правки v3).
    void session.refetchKeys(TASK, [K1])
    await transport.settle()
    const late = transport.take()
    server.edit(TASK, K1, { title: "C" })
    void session.refetchKeys(TASK, [K1])
    await transport.settle()
    transport.take().answer()
    await transport.settle()
    expect(w.last.rows[0]?.version).toBe(3)
    late.answerStale()
    await transport.settle()
    expect(w.last.rows[0]?.version).toBe(3)
    expect(w.last.rows[0]?.values.title).toBe("C")
  })

  it("criterion 4: a newer signal during pending does not bounce; settle has no extra frame", async () => {
    const { server, transport, session, w, row } = await two()
    session
      .begin({ policy: "predict" })
      .update(TASK, K1, { title: "X" })
      .commit()
    await transport.settle()
    const run = transport.take()
    // Чужа зміна іншого поля, сигнал і перечитування — поки наша в польоті.
    server.edit(TASK, K1, { rank: 9 })
    void session.refetchKeys(TASK, [K1])
    await transport.settle()
    transport.take().answer()
    await transport.settle()
    expect(row()?.values).toMatchObject({ title: "X", rank: 9 })
    expect(row()?.status.state).toBe("pending")
    // Сервер відмовляє версією (ми слали v1, там v2): поля не розійшлись —
    // `predict` перебазовується й шле знову; показ не змінюється.
    const shown = row()?.values
    run.answer()
    await transport.settle()
    // Ядро перечитує ключ перед перебазуванням.
    transport.take().answer()
    await transport.settle()
    expect(row()?.values).toBe(shown)
    expect(row()?.status.state).toBe("pending")
    const resend = transport.take()
    expect(resend.operations?.[0]).toMatchObject({
      expectedVersion: 2,
      values: { title: "X" },
    })
    const before = w.frames.length
    resend.answer()
    await transport.settle()
    expect(w.frames.length - before).toBe(1)
    expect(row()?.values).toBe(shown)
    expect(row()?.status.state).toBe("synced")
  })

  it("criterion 4: diverged field during pending gives conflict, local change kept", async () => {
    const { server, transport, session, row } = await two()
    const m = session
      .begin({ policy: "predict" })
      .update(TASK, K1, { title: "X" })
      .commit()
    await transport.settle()
    const run = transport.take()
    server.edit(TASK, K1, { title: "Z" })
    void session.refetchKeys(TASK, [K1])
    await transport.settle()
    transport.take().answer()
    await transport.settle()
    expect(row()?.values.title).toBe("X")
    run.answer()
    await transport.drain()
    expect((await m.settled).ok).toBe(false)
    expect(row()?.status.state).toBe("conflict")
    expect(row()?.values.title).toBe("X")
    expect(row()?.status.server?.values.title).toBe("Z")
  })

  describe("two edits of one key", () => {
    it("same field: the second wins, one run each, no rollback frame", async () => {
      const { transport, session, w, row } = await two()
      session
        .begin({ policy: "predict" })
        .update(TASK, K1, { title: "X" })
        .commit()
      session
        .begin({ policy: "predict" })
        .update(TASK, K1, { title: "Y" })
        .commit()
      await transport.settle()
      const start = w.frames.length
      transport.take().answer()
      await transport.settle()
      expect(row()?.values.title).toBe("Y")
      transport.take().answer()
      await transport.settle()
      // Жоден кадр після правок не показав ні старого, ні проміжного значення.
      expect(
        w.frames.slice(start - 1).map((f) => f.rows[0]?.values.title)
      ).toEqual(w.frames.slice(start - 1).map(() => "Y"))
      expect(row()?.values.title).toBe("Y")
      expect(row()?.version).toBe(3)
      expect(row()?.status.state).toBe("synced")
    })

    it("different fields: both apply, the second takes the version after the first", async () => {
      const { transport, session, row } = await two()
      session
        .begin({ policy: "predict" })
        .update(TASK, K1, { title: "X" })
        .commit()
      session
        .begin({ policy: "predict" })
        .update(TASK, K1, { rank: 5 })
        .commit()
      await transport.settle()
      transport.take().answer()
      await transport.settle()
      const second = transport.take()
      expect(second.operations?.[0]).toMatchObject({
        expectedVersion: 2,
        values: { rank: 5 },
      })
      second.answer()
      await transport.settle()
      expect(row()?.values).toMatchObject({ title: "X", rank: 5 })
    })

    it("base version changed by another user between the edits (await): conflict", async () => {
      const { server, transport, session, row } = await two()
      const m = session
        .begin({ policy: "await" })
        .update(TASK, K1, { rank: 5 })
        .commit()
      await transport.settle()
      const run = transport.take()
      server.edit(TASK, K1, { title: "Z" })
      run.answer()
      await transport.drain()
      // `await` без автоповтору: зміна версії — конфлікт.
      expect((await m.settled).ok).toBe(false)
      expect(row()?.status.state).toBe("conflict")
      expect(row()?.values.rank).toBe(1)
    })

    it("first refused, second conflicts: both kept, each with its own state", async () => {
      const { server, transport, session, row } = await two()
      const m1 = session
        .begin({ policy: "predict" })
        .update(TASK, K1, { title: "X" })
        .commit()
      const m2 = session
        .begin({ policy: "predict" })
        .update(TASK, K1, { rank: 5 })
        .commit()
      await transport.settle()
      // Поки перша в польоті, хтось змінив поле другої.
      server.edit(TASK, K1, { rank: 8 })
      void session.refetchKeys(TASK, [K1])
      await transport.settle()
      transport.take(1).answer()
      await transport.settle()
      transport.take().fail({ code: "command.forbidden" })
      await transport.settle()
      // Друга правка поля, яке сервер змінив інакше, — конфлікт до відправки.
      expect((await m2.settled).ok).toBe(false)
      const states = row()?.status.mutations.map((m) => [m.id, m.state])
      expect(states).toEqual([
        [m1.id, "failed"],
        [m2.id, "conflict"],
      ])
      expect(row()?.values).toMatchObject({ title: "X", rank: 5 })
      expect(row()?.status.server?.values.rank).toBe(8)
      expect(row()?.status.state).toBe("conflict")
    })
  })

  it("unknown: outcome unknown, then resolved to synced by re-read", async () => {
    const { transport, session, row } = await two()
    const m = session
      .begin({ policy: "predict" })
      .update(TASK, K1, { title: "X" })
      .commit()
    await transport.settle()
    transport.take().applyThenFail({ code: "command.unavailable" })
    await transport.settle()
    expect(row()?.status.state).toBe("unknown")
    expect(row()?.values.title).toBe("X")
    transport.take().answer()
    await transport.settle()
    expect((await m.settled).ok).toBe(true)
    expect(row()?.status.state).toBe("synced")
    expect(row()?.values.title).toBe("X")
  })

  it("unknown: not applied on the server — failed, change kept", async () => {
    const { transport, session, row } = await two()
    const m = session
      .begin({ policy: "predict" })
      .update(TASK, K1, { title: "X" })
      .commit()
    await transport.settle()
    transport.take().fail({ code: "command.timeout" })
    await transport.drain()
    expect((await m.settled).ok).toBe(false)
    expect(row()?.status.state).toBe("failed")
    expect(row()?.values.title).toBe("X")
  })

  it("stale with an expected minimum version: an older re-read does not clear it", async () => {
    const { server, transport, session, row } = await two()
    const v = server.edit(TASK, K1, { title: "B2" })
    session.commit((w) => w.markStale(TASK, [K1], v), session.token())
    expect(row()?.status.state).toBe("stale")
    // Репліка ще віддає стару версію.
    void session.refetchKeys(TASK, [K1])
    await transport.settle()
    const early = transport.take()
    early.answer()
    await transport.settle()
    expect(row()?.status.state).toBe("synced")
  })

  it("stale is kept by a re-read below the minimum version", async () => {
    const { server, transport, session, row } = await two()
    void session.refetchKeys(TASK, [K1])
    await transport.settle()
    const old = transport.take() // знімок v1
    const v = server.edit(TASK, K1, { title: "B2" })
    session.commit((w) => w.markStale(TASK, [K1], v), session.token())
    old.answerStale()
    await transport.settle()
    expect(row()?.status.state).toBe("stale")
    expect(row()?.values.title).toBe("A")
  })

  it("removed by another user: stays in place with `removed` until refresh", async () => {
    const { server, transport, session, w } = await two()
    server.remove(TASK, K1)
    void session.refetchKeys(TASK, [K1])
    await transport.drain()
    expect(w.last.rows.map((r) => [r.key, r.status.state])).toEqual([
      [K1, "removed"],
      [K2, "synced"],
    ])
    session.view({ kind: "keys", object: TASK, keys: [K1, K2] }).refresh()
    await transport.drain()
    expect(w.last.rows.map((r) => r.key)).toEqual([K2])
    expect(inspectCore(session).violations()).toEqual([])
  })

  it("purge (lost access) drops rows at once, outside the stability rule", async () => {
    const { session, w } = await two()
    session.commit((wr) => wr.purge(TASK, [K1]), session.token())
    expect(w.last.rows.map((r) => r.key)).toEqual([K2])
    expect(inspectCore(session).row(TASK, K1)).toBeUndefined()
  })

  it("own delete: pending in place, gone after confirmation; refusal — failed in place", async () => {
    const { transport, session, w } = await two()
    session.begin({ policy: "predict" }).delete(TASK, K1).commit()
    await transport.settle()
    expect(w.last.rows[0]?.status).toMatchObject({
      state: "pending",
      deleting: true,
    })
    transport.take().fail({ code: "command.forbidden" })
    await transport.drain()
    expect(w.last.rows[0]?.status).toMatchObject({
      state: "failed",
      deleting: true,
    })
    session.begin({ policy: "predict" }).delete(TASK, K2).commit()
    await transport.drain()
    expect(w.last.rows.map((r) => r.key)).toEqual([K1])
  })

  it("section delta: run without lines keeps the optimistic lines until the re-read, one commit", async () => {
    const { server, transport, session } = setup()
    server.seed(TASK, [{ id: K1, title: "A", rank: 1 }])
    server.seedLines(TASK, K1, "items", [{ id: L1, qty: 1 }])
    const header = watch(session.view({ kind: "card", object: TASK, key: K1 }))
    const lines = watch(
      session.view({
        kind: "section",
        object: TASK,
        owner: K1,
        section: "items",
      })
    )
    await transport.drain()
    expect(lines.last.section?.ownerVersion).toBe(1)
    session
      .begin({ policy: "predict" })
      .addLine(TASK, K1, "items", { key: L2, values: { qty: 2 } })
      .commit()
    await transport.settle()
    const run = transport.take()
    expect(run.operations?.[0]).toMatchObject({
      action: "update",
      expectedVersion: 1,
      tabularSections: {
        items: [
          { id: L1, qty: 1 },
          { id: L2, qty: 2 },
        ],
      },
    })
    run.answer()
    await transport.settle()
    // `run` відповів без рядків ТЧ: ядро перечитує «ТЧ власника» й осідає
    // разом з нею; до того оптимістичний рядок лишається видимим.
    expect(lines.last.section?.lines.map((l) => l.key)).toEqual([L1, L2])
    transport.take().answer()
    await transport.settle()
    for (const frame of lines.frames.slice(2)) {
      expect(frame.section?.lines.map((l) => l.key)).toEqual([L1, L2])
    }
    expect(lines.last.section?.ownerVersion).toBe(2)
    expect(lines.last.section?.lines.every((l) => !l.pending)).toBe(true)
    expect(header.last.rows[0]?.version).toBe(2)
  })

  it("section freshness: a newer header version re-reads a visible section", async () => {
    const { server, transport, session } = setup()
    server.seed(TASK, [{ id: K1, title: "A", rank: 1 }])
    server.seedLines(TASK, K1, "items", [{ id: L1, qty: 1 }])
    watch(session.view({ kind: "card", object: TASK, key: K1 }))
    const lines = watch(
      session.view({
        kind: "section",
        object: TASK,
        owner: K1,
        section: "items",
      })
    )
    await transport.drain()
    server.editLines(TASK, K1, "items", [{ id: L1, qty: 7 }])
    void session.refetchKeys(TASK, [K1])
    await transport.drain()
    expect(lines.last.section?.lines[0]?.values.qty).toBe(7)
    expect(lines.last.section?.ownerVersion).toBe(2)
  })

  describe("lifecycle", () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it("remount within the release delay takes the same subset without a request", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const { server, transport, session } = setup({ releaseDelayMs: 1_000 })
      server.seed(TASK, [{ id: K1, title: "A", rank: 1 }])
      const handle = session.view({ kind: "keys", object: TASK, keys: [K1] })
      expect(session.view({ kind: "keys", object: TASK, keys: [K1] })).toBe(
        handle
      )
      const a = watch(handle)
      await transport.drain()
      a.unsubscribe()
      const sent = transport.sent
      const b = watch(handle)
      await transport.settle()
      expect(transport.sent).toBe(sent)
      expect(b.last.rows[0]?.values.title).toBe("A")
      b.unsubscribe()
      vi.advanceTimersByTime(1_000)
      expect(inspectCore(session).rows(TASK).size).toBe(0)
      expect(handle.getSnapshot().status).toBe("loading")
    })

    it("preload holds until the first subscription and shares the load", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const { server, transport, session } = setup({ releaseDelayMs: 0 })
      server.seed(TASK, [{ id: K1, title: "A", rank: 1 }])
      const spec = { kind: "keys", object: TASK, keys: [K1] } as const
      const done = session.preload(spec, { ttlMs: 5_000 })
      await transport.drain()
      await done
      const w = watch(session.view(spec))
      expect(w.last.status).toBe("ready")
      expect(transport.sent).toBe(1)
      w.unsubscribe()
      expect(inspectCore(session).rows(TASK).size).toBe(0)
    })

    it("an unused preload expires", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const { server, transport, session } = setup({ releaseDelayMs: 0 })
      server.seed(TASK, [{ id: K1, title: "A", rank: 1 }])
      void session.preload(
        { kind: "keys", object: TASK, keys: [K1] },
        { ttlMs: 5_000 }
      )
      await transport.drain()
      expect(inspectCore(session).rows(TASK).size).toBe(1)
      vi.advanceTimersByTime(5_000)
      expect(inspectCore(session).rows(TASK).size).toBe(0)
    })
  })

  describe("SSR", () => {
    it("hydrate gives the server frame with no notification and no request", async () => {
      const a = setup()
      a.server.seed(TASK, [{ id: K1, title: "A", rank: 1 }])
      watch(a.session.view({ kind: "keys", object: TASK, keys: [K1] }))
      await a.transport.drain()
      const snapshot = JSON.parse(JSON.stringify(a.session.dehydrate()))
      const b = setup()
      const notified: number[] = []
      b.session.subscribe(() => notified.push(1))
      b.session.hydrate(snapshot)
      const handle = b.session.view({ kind: "keys", object: TASK, keys: [K1] })
      const first = handle.getSnapshot()
      expect(first.status).toBe("ready")
      expect(first.rows[0]?.values.title).toBe("A")
      const w = watch(handle)
      await b.transport.settle()
      b.session.endHydration()
      await b.transport.settle()
      expect(b.transport.sent).toBe(0)
      expect(notified).toEqual([])
      expect(w.frames).toHaveLength(1)
      expect(w.last).toBe(first)
    })

    it("a snapshot of another subject is refused", () => {
      const a = setup()
      const b = setup({ subject: "user-2" })
      expect(() => b.session.hydrate(a.session.dehydrate())).toThrow()
    })
  })
})
