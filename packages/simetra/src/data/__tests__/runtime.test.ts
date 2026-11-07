import { describe, expect, it, vi } from "vitest"
import {
  CommandFailure,
  PAYLOAD_MAX_BYTES,
  jsonBytes,
  type DataRequest,
} from "simetra/model"
import { createDataRuntime, type DataLogEntry } from "../index"
import { facadeOf } from "../facade/handle"
import {
  OBJECT_ID,
  SUBJECT,
  answeringTransport,
  clientCatalog,
  controlledTransport,
  ok,
  sessionChanged,
} from "./support"

const ID = "11111111-1111-4111-8111-111111111111"
const DISPOSED = { code: "command.unavailable", reason: "disposed" }
const SESSION_CHANGED = {
  code: "command.unauthenticated",
  reason: "session-changed",
}

const card = (id = ID): DataRequest["request"] => ({
  type: "read",
  query: { object: OBJECT_ID, id },
})

// Відмову перевіряємо за кодом і причиною, а не за текстом.
async function failureOf(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(CommandFailure)
  return (error as CommandFailure).error
}

describe("createDataRuntime", () => {
  it("validates the catalog", () => {
    const { transport } = answeringTransport(ok(null))
    expect(() =>
      createDataRuntime({
        catalog: { ...clientCatalog(), format: 2 },
        transport,
        subject: SUBJECT,
      })
    ).toThrow()
  })

  it("exposes the subject and starts undisposed", () => {
    const { transport } = answeringTransport(ok(null))
    const runtime = createDataRuntime({
      catalog: clientCatalog(),
      transport,
      subject: SUBJECT,
    })
    expect(runtime.subject).toBe(SUBJECT)
    expect(runtime.disposed).toBe(false)
  })
})

describe("runtime transport wrapper", () => {
  it("adds the subject to every request and returns the value", async () => {
    const { transport, calls } = answeringTransport(ok({ rows: [] }))
    const runtime = createDataRuntime({
      catalog: clientCatalog(),
      transport,
      subject: SUBJECT,
    })
    const { send } = facadeOf(runtime)
    await expect(send(card())).resolves.toEqual({ rows: [] })
    await expect(send({ type: "version" })).resolves.toEqual({ rows: [] })
    expect(calls).toEqual([
      { subject: SUBJECT, request: card() },
      { subject: SUBJECT, request: { type: "version" } },
    ])
  })

  describe("payload limit", () => {
    // Тіло з кирилицею: символів менше за межу, а байтів UTF-8 — більше, тож
    // міра в символах пропустила б запит, який відкине host.
    const bodyOf = (bytes: number): DataRequest["request"] => {
      const overhead = jsonBytes({ subject: SUBJECT, request: card("") })
      const fill = bytes - overhead
      return card("ж".repeat(Math.floor(fill / 2)) + "a".repeat(fill % 2))
    }

    it("sends a body of exactly the limit", async () => {
      const { transport, calls } = answeringTransport(ok(null))
      const { send } = facadeOf(
        createDataRuntime({
          catalog: clientCatalog(),
          transport,
          subject: SUBJECT,
        })
      )
      const request = bodyOf(PAYLOAD_MAX_BYTES)
      expect(jsonBytes({ subject: SUBJECT, request })).toBe(PAYLOAD_MAX_BYTES)
      await send(request)
      expect(calls).toHaveLength(1)
    })

    it("refuses a body one UTF-8 byte over the limit without the transport", async () => {
      const { transport, calls } = answeringTransport(ok(null))
      const { send } = facadeOf(
        createDataRuntime({
          catalog: clientCatalog(),
          transport,
          subject: SUBJECT,
        })
      )
      const request = bodyOf(PAYLOAD_MAX_BYTES + 1)
      const body = { subject: SUBJECT, request }
      expect(JSON.stringify(body).length).toBeLessThan(PAYLOAD_MAX_BYTES)
      expect(await failureOf(send(request))).toEqual({
        code: "command.invalid",
        reason: "payload-too-large",
      })
      expect(calls).toHaveLength(0)
    })
  })

  describe("transport exception", () => {
    it.each([
      ["rejects", () => Promise.reject(new TypeError("network"))],
      [
        "throws",
        () => {
          throw new TypeError("network")
        },
      ],
    ] as const)(
      "%s: command.unavailable without a reason, the original to the log",
      async (_, fail) => {
        const log = vi.fn<(entry: DataLogEntry) => void>()
        const { send } = facadeOf(
          createDataRuntime({
            catalog: clientCatalog(),
            transport: fail,
            subject: SUBJECT,
            log,
          })
        )
        expect(await failureOf(send(card()))).toEqual({
          code: "command.unavailable",
        })
        expect(log).toHaveBeenCalledTimes(1)
        expect(log).toHaveBeenCalledWith({
          kind: "transport-failed",
          error: new TypeError("network"),
        })
      }
    )

    it("keeps the outcome when the log sink throws", async () => {
      const log = vi.fn(() => {
        throw new Error("sink down")
      })
      const { send } = facadeOf(
        createDataRuntime({
          catalog: clientCatalog(),
          transport: () => Promise.reject(new TypeError("network")),
          subject: SUBJECT,
          log,
        })
      )
      expect(await failureOf(send(card()))).toEqual({
        code: "command.unavailable",
      })
      expect(log).toHaveBeenCalledTimes(1)
    })
  })

  describe("session-changed", () => {
    it("calls onSessionChanged once and disposes the runtime", async () => {
      const { transport, respond } = controlledTransport()
      const onSessionChanged = vi.fn()
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
        onSessionChanged,
      })
      const { send } = facadeOf(runtime)
      const first = send(card())
      const second = send(card())
      respond(sessionChanged())
      expect(await failureOf(first)).toEqual({
        code: "command.unauthenticated",
        reason: "session-changed",
      })
      expect(runtime.disposed).toBe(true)
      respond(sessionChanged())
      expect(await failureOf(second)).toEqual({
        code: "command.unauthenticated",
        reason: "session-changed",
      })
      expect(onSessionChanged).toHaveBeenCalledTimes(1)
    })

    it("rejects with session-changed and re-raises a throwing callback asynchronously", async () => {
      // Підміна `queueMicrotask`: справжній кидок у мікрозадачі став би
      // необробленою помилкою прогону.
      const deferred: (() => void)[] = []
      const queue = vi
        .spyOn(globalThis, "queueMicrotask")
        .mockImplementation((task) => {
          deferred.push(task)
        })
      try {
        const { transport, respond } = controlledTransport()
        const thrown = new Error("callback failed")
        const runtime = createDataRuntime({
          catalog: clientCatalog(),
          transport,
          subject: SUBJECT,
          onSessionChanged: () => {
            throw thrown
          },
        })
        const request = facadeOf(runtime).send(card())
        respond(sessionChanged())
        expect(await failureOf(request)).toEqual(SESSION_CHANGED)
        expect(runtime.disposed).toBe(true)
        expect(deferred).toHaveLength(1)
        expect(() => deferred[0]!()).toThrow(thrown)
      } finally {
        queue.mockRestore()
      }
    })

    it("rejects a later success with the session-changed code", async () => {
      const { transport, respond } = controlledTransport()
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      const { send } = facadeOf(runtime)
      const first = send(card())
      const second = send(card())
      respond(sessionChanged())
      await failureOf(first)
      respond(ok({ rows: [{ id: ID }] }))
      expect((await failureOf(second)).reason).toBe("session-changed")
    })

    it("refuses a new request with session-changed without the transport", async () => {
      const { transport, calls, respond } = controlledTransport()
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      const { send } = facadeOf(runtime)
      const first = send(card())
      respond(sessionChanged())
      await failureOf(first)
      expect(await failureOf(send(card()))).toEqual(SESSION_CHANGED)
      expect(calls).toHaveLength(1)
    })
  })

  describe("dispose()", () => {
    it("clears the query cache", () => {
      const { transport } = answeringTransport(ok(null))
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      const { queryClient, keyPrefix } = facadeOf(runtime)
      queryClient.setQueryData([...keyPrefix, "seed"], { rows: [] })
      expect(queryClient.getQueryCache().getAll()).toHaveLength(1)
      runtime.dispose()
      expect(runtime.disposed).toBe(true)
      expect(queryClient.getQueryCache().getAll()).toEqual([])
    })

    it("refuses a later request without the transport", async () => {
      const { transport, calls } = answeringTransport(ok(null))
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      runtime.dispose()
      expect(await failureOf(facadeOf(runtime).send(card()))).toEqual(DISPOSED)
      expect(calls).toHaveLength(0)
    })

    it("rejects an in-flight request whose response arrives after it", async () => {
      const { transport, respond } = controlledTransport()
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      const pending = facadeOf(runtime).send(card())
      runtime.dispose()
      respond(ok({ rows: [{ id: ID }] }))
      expect(await failureOf(pending)).toEqual(DISPOSED)
    })

    it("rejects an in-flight request whose transport fails after it", async () => {
      const { transport, pending } = controlledTransport()
      const log = vi.fn()
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
        log,
      })
      const request = facadeOf(runtime).send(card())
      runtime.dispose()
      pending[0]!.fail(new TypeError("network"))
      expect(await failureOf(request)).toEqual(DISPOSED)
      expect(log).not.toHaveBeenCalled()
    })

    it("does not call onSessionChanged for a session-changed after it", async () => {
      const { transport, respond } = controlledTransport()
      const onSessionChanged = vi.fn()
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
        onSessionChanged,
      })
      const request = facadeOf(runtime).send(card())
      runtime.dispose()
      respond(sessionChanged())
      expect(await failureOf(request)).toEqual(DISPOSED)
      expect(onSessionChanged).not.toHaveBeenCalled()
    })
  })

  describe("cache isolation", () => {
    it("gives each runtime its own client and key prefix", () => {
      const { transport } = answeringTransport(ok(null))
      const one = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      const two = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      expect(facadeOf(one).queryClient).toBe(facadeOf(one).queryClient)
      expect(facadeOf(one).queryClient).not.toBe(facadeOf(two).queryClient)

      const [prefixOne, prefixTwo] = [facadeOf(one), facadeOf(two)].map(
        (f) => f.keyPrefix
      )
      expect(prefixOne).toEqual(["simetra", SUBJECT, expect.any(String)])
      expect(prefixTwo).toEqual(["simetra", SUBJECT, expect.any(String)])
      expect(prefixOne).not.toEqual(prefixTwo)

      facadeOf(one).queryClient.setQueryData([...prefixOne!, "seed"], 1)
      expect(facadeOf(two).queryClient.getQueryCache().getAll()).toEqual([])
    })
  })
})
