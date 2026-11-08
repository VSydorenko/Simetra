import { describe, expect, it } from "vitest"
import { inspectCore } from "../core"
import { TASK, id, setup, watch } from "./support"

/*
 * Регресії з незалежного рев'ю ядра (лінза «після dispose / старе
 * покоління») і з вимог спайку 3. Кожен тест падав на коді до виправлення.
 */

const K1 = id(1)
const K2 = id(2)
const L1 = id(101)
const L2 = id(102)

describe("core regressions", () => {
  it("pump does not skip a mutation after a noop settlement", async () => {
    const { server, transport, session } = setup()
    server.seed(TASK, [{ id: K1, title: "A", rank: 1 }])
    watch(session.view({ kind: "keys", object: TASK, keys: [K1] }))
    await transport.drain()
    session
      .begin({ policy: "predict" })
      .update(TASK, K1, { title: "X" })
      .commit()
    session
      .begin({ policy: "predict" })
      .update(TASK, K1, { title: "X" })
      .commit()
    const m3 = session
      .begin({ policy: "predict" })
      .update(TASK, K1, { rank: 7 })
      .commit()
    await transport.drain()
    expect((await m3.settled).ok).toBe(true)
    expect(server.row(TASK, K1)?.values.rank).toBe(7)
  })

  it("a late load read before a confirmed own delete does not resurrect it", async () => {
    const { server, transport, session } = setup()
    server.seed(TASK, [
      { id: K1, title: "A", rank: 1 },
      { id: K2, title: "B", rank: 2 },
    ])
    const keys = watch(session.view({ kind: "keys", object: TASK, keys: [K1] }))
    const fullH = session.view({ kind: "full", object: TASK })
    const full = watch(fullH)
    await transport.drain()
    fullH.refresh()
    await transport.settle()
    const late = transport.take()
    session.begin({ policy: "predict" }).delete(TASK, K1).commit()
    await transport.settle()
    transport.take().answer()
    await transport.settle()
    late.answerStale()
    await transport.settle()
    expect(keys.last.rows).toEqual([])
    expect(full.last.rows.map((r) => r.key)).toEqual([K2])
    expect(inspectCore(session).violations()).toEqual([])
  })

  it("a late load read before purge does not bring the purged row back", async () => {
    const { server, transport, session } = setup()
    server.seed(TASK, [{ id: K1, title: "secret", rank: 1 }])
    const fullH = session.view({ kind: "full", object: TASK })
    const full = watch(fullH)
    await transport.drain()
    fullH.refresh()
    await transport.settle()
    const late = transport.take()
    session.commit((w) => w.purge(TASK, [K1]), session.token())
    late.answerStale()
    await transport.settle()
    expect(full.last.rows).toEqual([])
    expect(inspectCore(session).row(TASK, K1)).toBeUndefined()
  })

  it("purge clears ownership of subsets that hold the key outside their layout", async () => {
    const { server, transport, session } = setup()
    server.seed(TASK, [{ id: K1, title: "A", rank: 1, done: true }])
    const fullH = session.view({
      kind: "full",
      object: TASK,
      where: { attribute: "done", op: "eq", value: false },
    })
    watch(fullH)
    await transport.drain()
    session.commit((w) => w.purge(TASK, [K1]), session.token())
    const keys = watch(session.view({ kind: "keys", object: TASK, keys: [K1] }))
    await transport.drain()
    expect(inspectCore(session).violations()).toEqual([])
    server.remove(TASK, K1)
    server.seed(TASK, [{ id: K2, title: "B", rank: 2, done: true }])
    fullH.refresh()
    await transport.drain()
    expect(keys.last.rows).toHaveLength(1)
    expect(inspectCore(session).violations()).toEqual([])
  })

  it("a section held by a delta is collected when the delta settles after release", async () => {
    const { server, transport, session } = setup()
    server.seed(TASK, [{ id: K1, title: "A", rank: 1 }])
    server.seedLines(TASK, K1, "items", [{ id: L1, n: 1 }])
    const card = watch(session.view({ kind: "card", object: TASK, key: K1 }))
    const lines = watch(
      session.view({
        kind: "section",
        object: TASK,
        owner: K1,
        section: "items",
      })
    )
    await transport.drain()
    session
      .begin({ policy: "predict" })
      .addLine(TASK, K1, "items", { key: L2, values: { n: 2 } })
      .commit()
    await transport.settle()
    lines.unsubscribe()
    card.unsubscribe()
    await transport.drain()
    const insp = inspectCore(session)
    expect([insp.subsetCount(), insp.sectionCount(), insp.logLength()]).toEqual(
      [0, 0, 0]
    )
  })

  it("a failed section re-read after a confirmed delta keeps the sent lines and re-reads", async () => {
    const { server, transport, session } = setup()
    server.seed(TASK, [{ id: K1, title: "A", rank: 1 }])
    server.seedLines(TASK, K1, "items", [{ id: L1, n: 1 }])
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
    session
      .begin({ policy: "predict" })
      .addLine(TASK, K1, "items", { key: L2, values: { n: 2 } })
      .commit()
    await transport.settle()
    transport.take().answer()
    await transport.settle()
    transport.take().fail({ code: "command.unavailable" })
    await transport.settle()
    for (const frame of lines.frames.slice(2)) {
      expect(frame.section?.lines.map((l) => l.key)).toEqual([L1, L2])
    }
    expect(lines.last.section?.ownerVersion).toBe(2)
    await transport.drain()
    expect(lines.last.needsRefresh).toBe(false)
    expect(lines.last.section?.lines.map((l) => l.key)).toEqual([L1, L2])
  })

  it("a listener that disposes the session stops further notifications", async () => {
    const { server, transport, session } = setup()
    server.seed(TASK, [{ id: K1, title: "A", rank: 1 }])
    const handle = session.view({ kind: "keys", object: TASK, keys: [K1] })
    const calls: string[] = []
    handle.subscribe(() => {
      calls.push("first")
      session.dispose()
    })
    handle.subscribe(() => calls.push("second"))
    await transport.drain()
    expect(calls).toEqual(["first"])
  })

  describe("spike 3 requirements", () => {
    it("stale after a disconnect clears on a re-read of the same version", async () => {
      const { server, transport, session } = setup()
      server.seed(TASK, [{ id: K1, title: "A", rank: 1 }])
      const w = watch(session.view({ kind: "card", object: TASK, key: K1 }))
      await transport.drain()
      session.commit((wr) => wr.markStale(TASK, [K1]), session.token())
      expect(w.last.rows[0]?.status.state).toBe("stale")
      void session.refetchKeys(TASK, [K1])
      await transport.drain()
      expect(w.last.rows[0]?.status.state).toBe("synced")
    })

    it("activeViews lists form, keys and visibility, visible first", async () => {
      const { server, transport, session } = setup({ releaseDelayMs: 1_000 })
      server.seed(TASK, [{ id: K1, title: "A", rank: 1 }])
      const hidden = watch(
        session.view({ kind: "keys", object: TASK, keys: [K1] })
      )
      watch(session.view({ kind: "card", object: TASK, key: K1 }))
      await transport.drain()
      hidden.unsubscribe()
      const views = session.activeViews(TASK)
      expect(views.map((v) => [v.spec.kind, v.keys, v.visible])).toEqual([
        ["card", [K1], true],
        ["keys", [K1], false],
      ])
      session.dispose()
    })

    it("markViews on one spec flags only that view", async () => {
      const { server, transport, session } = setup()
      server.seed(TASK, [{ id: K1, title: "A", rank: 1 }])
      const spec = { kind: "full", object: TASK } as const
      const a = watch(session.view(spec))
      const b = watch(session.view({ kind: "keys", object: TASK, keys: [K1] }))
      await transport.drain()
      session.commit(
        (w) => w.markViews(TASK, { needsRefresh: true }, spec),
        session.token()
      )
      expect(a.last.needsRefresh).toBe(true)
      expect(b.last.needsRefresh).toBe(false)
    })

    it("revalidate re-reads all views in one commit without reordering or removing", async () => {
      const { server, transport, session } = setup()
      server.seed(TASK, [
        { id: K1, title: "A", rank: 1 },
        { id: K2, title: "B", rank: 2 },
      ])
      const fullW = watch(
        session.view({
          kind: "full",
          object: TASK,
          orderBy: [{ attribute: "title", direction: "asc" }],
        })
      )
      const keysW = watch(
        session.view({ kind: "keys", object: TASK, keys: [K2] })
      )
      await transport.drain()
      server.edit(TASK, K1, { title: "Z" }) // поле сортування змінилось
      server.remove(TASK, K2)
      const before = [fullW.frames.length, keysW.frames.length]
      void session.revalidate(TASK)
      await transport.drain()
      expect(transport.sent).toBe(3)
      expect(
        fullW.last.rows.map((r) => [r.key, r.status.state, r.values.title])
      ).toEqual([
        [K1, "synced", "Z"],
        [K2, "removed", "B"],
      ])
      expect(fullW.last.needsRefresh).toBe(true)
      expect([
        fullW.frames.length - (before[0] ?? 0),
        keysW.frames.length - (before[1] ?? 0),
      ]).toEqual([1, 1])
    })
  })
})
