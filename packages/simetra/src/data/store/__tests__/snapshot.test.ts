import { describe, expect, it } from "vitest"
import { computeRowView } from "../snapshot"
import type { RowMutation } from "../types"
import { harness, K1, row } from "./store-support"

const EA = "a".repeat(64)
const EB = "b".repeat(64)

const put = (h: ReturnType<typeof harness>, versionEpoch: string | null) =>
  h.write((s) =>
    h.store.put(
      s,
      { ...row(K1, 1, { notes: "n" }), versionEpoch },
      h.now(),
      true
    )
  )

describe("computeRowView staleFields", () => {
  it("a lazy field read in the epoch of the row is not stale", () => {
    const h = harness()
    put(h, EA)
    const view = computeRowView(K1, h.store.get(K1)!, ["notes"], undefined)
    expect(view).toMatchObject({ staleFields: [] })
  })

  it("a lazy field of an old epoch is stale although its version is not lower", () => {
    const h = harness()
    put(h, EA)
    h.write((s) =>
      h.store.put(s, { ...row(K1, 1), versionEpoch: EB }, h.now(), false)
    )
    const view = computeRowView(K1, h.store.get(K1)!, ["notes"], undefined)
    expect(view).toMatchObject({ version: 1, staleFields: ["notes"] })
  })

  it("a null epoch compares by version as usual", () => {
    const h = harness()
    put(h, null)
    const view = computeRowView(K1, h.store.get(K1)!, ["notes"], undefined)
    expect(view).toMatchObject({ staleFields: [] })
  })
})

describe("computeRowView with an own mutation (plan B3-4-Л Р5, Р7)", () => {
  const pending: RowMutation = Object.freeze({ id: "m1", state: "pending" })
  const failed: RowMutation = Object.freeze({
    id: "m1",
    state: "failed" as const,
    error: { code: "command.busy" as const },
    cancel: () => {},
  })

  const stored = () => {
    const h = harness()
    put(h, EA)
    return h
  }

  it("takes the state of the mutation and keeps the confirmed values", () => {
    const h = stored()
    const view = computeRowView(K1, h.store.get(K1)!, [], undefined, pending)
    expect(view).toMatchObject({
      state: "pending",
      version: 1,
      values: { title: "t1" },
      mutation: pending,
    })
  })

  it("a mutation state outranks stale", () => {
    const h = stored()
    h.write((s) => h.store.markStale(s, [K1], 5))
    const e = h.store.get(K1)!
    expect(computeRowView(K1, e, [], undefined).state).toBe("stale")
    expect(computeRowView(K1, e, [], undefined, failed).state).toBe("failed")
  })

  it("an epoch mark under failed or conflict shows stale; a read proving the current epoch clears it", () => {
    const conflict: RowMutation = Object.freeze({
      id: "m1",
      state: "conflict" as const,
      error: { code: "command.conflict" as const },
      cancel: () => {},
    })
    const h = harness()
    const accept = (epoch: string) =>
      h.write(() => h.session.acceptEpoch(epoch, h.now()))
    accept(EA)
    put(h, EA)
    accept(EB)
    // Лише епохова половина: нижньої межі версії немає.
    expect(h.store.get(K1)!.stale).toEqual({ epoch: true })
    for (const mutation of [failed, conflict])
      expect(
        computeRowView(K1, h.store.get(K1)!, [], undefined, mutation)
      ).toMatchObject({ state: mutation.state, stale: true })
    h.write((s) =>
      h.store.put(s, { ...row(K1, 1), versionEpoch: EB }, h.now(), false)
    )
    for (const mutation of [failed, conflict]) {
      const view = computeRowView(K1, h.store.get(K1)!, [], undefined, mutation)
      expect(view).toMatchObject({ state: mutation.state })
      expect("stale" in view).toBe(false)
    }
  })

  it("a gap mark under failed shows stale; clearing the channel lifts it", () => {
    const h = stored()
    h.write((s) => h.store.markDisconnected(s, () => "c1"))
    expect(
      computeRowView(K1, h.store.get(K1)!, [], undefined, failed)
    ).toMatchObject({ state: "failed", stale: true })
    h.write((s) => h.store.clearDisconnected(s, "c1"))
    const view = computeRowView(K1, h.store.get(K1)!, [], undefined, failed)
    expect(view).toMatchObject({ state: "failed" })
    expect("stale" in view).toBe(false)
  })

  it("a hide mark under failed shows stale; a read started after it lifts it", () => {
    const h = stored()
    h.write((s) => h.store.hideKeys(s, [K1]))
    expect(
      computeRowView(K1, h.store.get(K1)!, [], undefined, failed)
    ).toMatchObject({ hidden: true, stale: true })
    h.write((s) => h.store.put(s, row(K1, 1), h.now(), false))
    const view = computeRowView(K1, h.store.get(K1)!, [], undefined, failed)
    expect(view).toMatchObject({ state: "failed" })
    expect("stale" in view).toBe(false)
    expect("hidden" in view).toBe(false)
  })

  it("hidden outranks the mutation state, and the view keeps the mutation", () => {
    const h = stored()
    h.write((s) => h.store.hideKeys(s, [K1]))
    const view = computeRowView(K1, h.store.get(K1)!, [], undefined, failed)
    expect(view).toMatchObject({
      state: "stale",
      hidden: true,
      values: {},
      mutation: failed,
    })
  })

  it("a removed row carries the mutation", () => {
    const h = stored()
    h.write((s) => h.store.remove(s, K1, h.now()))
    const view = computeRowView(K1, h.store.get(K1)!, [], undefined, failed)
    expect(view).toEqual({ key: K1, state: "removed", mutation: failed })
    expect(computeRowView(K1, h.store.get(K1)!, [], view, failed)).toBe(view)
    expect(computeRowView(K1, h.store.get(K1)!, [], view)).toEqual({
      key: K1,
      state: "removed",
    })
  })

  it("shares the previous view only while the mutation is the same object", () => {
    const h = stored()
    const e = h.store.get(K1)!
    const first = computeRowView(K1, e, [], undefined, pending)
    expect(computeRowView(K1, e, [], first, pending)).toBe(first)
    const next = computeRowView(K1, e, [], first, failed)
    expect(next).not.toBe(first)
    expect(next).toMatchObject({ state: "failed", mutation: failed })
    // Зняття мутації — новий вигляд без поля `mutation`.
    const settled = computeRowView(K1, e, [], next)
    expect(settled.state).toBe("synced")
    expect("mutation" in settled).toBe(false)
    // Значення ті самі: посилка значень спільна.
    expect(settled).toMatchObject({ values: { title: "t1" } })
    expect((settled as { values: unknown }).values).toBe(
      (next as { values: unknown }).values
    )
  })
})
