import { describe, expect, it } from "vitest"
import { inspectCore } from "../core"
import { TASK, id, setup, watch } from "./support"

const K1 = id(1)
const K2 = id(2)

async function loaded() {
  const ctx = setup()
  ctx.server.seed(TASK, [
    { id: K1, title: "A", rank: 1, body: "long text" },
    { id: K2, title: "B", rank: 2, body: "other" },
  ])
  const w = watch(
    ctx.session.view({ kind: "keys", object: TASK, keys: [K1, K2] })
  )
  await ctx.transport.drain()
  return { ...ctx, w }
}

describe("core v0", () => {
  it("loads a keys view and owns its rows", async () => {
    const { session, w } = await loaded()
    expect(w.last.status).toBe("ready")
    expect(w.last.rows.map((r) => r.values.title)).toEqual(["A", "B"])
    expect(inspectCore(session).violations()).toEqual([])
  })

  it("criterion 2: confirming an equal value flips only the state, one notification", async () => {
    const { session, transport, w } = await loaded()
    session
      .begin({ policy: "predict" })
      .update(TASK, K1, { title: "X" })
      .commit()
    await transport.settle()
    const pending = w.last.rows[0]
    expect(pending?.status.state).toBe("pending")
    expect(pending?.values.title).toBe("X")
    const before = w.frames.length
    transport.take().answer()
    await transport.settle()
    expect(w.frames.length - before).toBe(1)
    const synced = w.last.rows[0]
    expect(synced?.status.state).toBe("synced")
    expect(synced?.values).toBe(pending?.values)
    expect(synced?.version).toBe(2)
  })

  it("criterion 3: first of two edits refused — second stays, first is failed", async () => {
    const { session, transport, w } = await loaded()
    const m1 = session
      .begin({ policy: "predict" })
      .update(TASK, K1, { title: "X" })
      .commit()
    const m2 = session
      .begin({ policy: "predict" })
      .update(TASK, K1, { rank: 7 })
      .commit()
    await transport.settle()
    expect(transport.calls).toHaveLength(1)
    transport.take().fail({ code: "command.forbidden" })
    await transport.settle()
    expect((await m1.settled).ok).toBe(false)
    let row = w.last.rows[0]
    expect(row?.values).toMatchObject({ title: "X", rank: 7 })
    expect(row?.status.state).toBe("failed")
    transport.take().answer()
    expect((await m2.settled).ok).toBe(true)
    await transport.settle()
    row = w.last.rows[0]
    // Друга не відкотилась; перша лишається видимою до дії користувача.
    expect(row?.values).toMatchObject({ title: "X", rank: 7 })
    expect(row?.status.state).toBe("failed")
    expect(row?.status.mutations.map((m) => m.id)).toEqual([m1.id])
    session.cancel(m1.id)
    expect(w.last.rows[0]?.values).toMatchObject({ title: "A", rank: 7 })
    expect(w.last.rows[0]?.status.state).toBe("synced")
  })

  it("await: the shown value does not change between the action and the commit", async () => {
    const { session, transport, w } = await loaded()
    const before = w.last.rows[0]
    session.begin().update(TASK, K1, { title: "Y" }).commit()
    await transport.settle()
    const pending = w.last.rows[0]
    expect(pending?.values).toBe(before?.values)
    expect(pending?.status.state).toBe("pending")
    expect(pending?.status.pendingFields).toEqual(["title"])
    transport.take().answer()
    await transport.settle()
    expect(w.last.rows[0]?.values.title).toBe("Y")
    expect(w.last.rows[0]?.status.state).toBe("synced")
  })

  it("write-back keeps lazy fields the run response does not carry", async () => {
    const ctx = setup()
    ctx.server.seed(TASK, [{ id: K1, title: "A", rank: 1, body: "long text" }])
    const card = watch(
      ctx.session.view({ kind: "card", object: TASK, key: K1 })
    )
    await ctx.transport.drain()
    expect(card.last.rows[0]?.values.body).toBe("long text")
    ctx.session
      .begin({ policy: "predict" })
      .update(TASK, K1, { title: "Z" })
      .commit()
    await ctx.transport.drain()
    for (const frame of card.frames.slice(1)) {
      expect(frame.rows[0]?.values.body).toBe("long text")
    }
  })

  it("criterion 6: write-back after dispose writes nothing", async () => {
    const { session, transport, w } = await loaded()
    const m = session
      .begin({ policy: "predict" })
      .update(TASK, K1, { title: "X" })
      .commit()
    await transport.settle()
    const call = transport.take()
    const frames = w.frames.length
    session.dispose()
    call.answer()
    await transport.settle()
    expect(w.frames.length).toBe(frames)
    expect((await m.settled).ok).toBe(false)
    expect(inspectCore(session).rows(TASK).size).toBe(0)
  })

  it("criterion 6: a late load of a released view writes nothing", async () => {
    const ctx = setup()
    ctx.server.seed(TASK, [{ id: K1, title: "A", rank: 1 }])
    const w = watch(
      ctx.session.view({ kind: "keys", object: TASK, keys: [K1] })
    )
    await ctx.transport.settle()
    const call = ctx.transport.take()
    w.unsubscribe()
    call.answer()
    await ctx.transport.settle()
    expect(inspectCore(ctx.session).rows(TASK).size).toBe(0)
    expect(inspectCore(ctx.session).subsetCount()).toBe(0)
  })

  it("session-changed disposes the session", async () => {
    const { session, transport } = await loaded()
    session.view({ kind: "card", object: TASK, key: K1 }).subscribe(() => {})
    await transport.settle()
    transport
      .take()
      .fail({ code: "command.unauthenticated", reason: "session-changed" })
    await transport.settle()
    expect(session.closed).toBe(true)
  })
})
