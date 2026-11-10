import { describe, expect, it } from "vitest"
import {
  CommandFailure,
  DATABASE_PROVIDERS,
  type SourceAdapter,
  type WireQueryPart,
} from "simetra/model"
import {
  DataError,
  createDataRuntime,
  createServerFunctionAdapter,
  selectSource,
  type DataErrorCode,
} from "../index"
import {
  OBJECT_ID,
  SUBJECT,
  answeringTransport,
  clientCatalog,
  failed,
  ok,
} from "./support"

const ID = "11111111-1111-4111-8111-111111111111"
const PART: WireQueryPart = {
  type: "query",
  query: { object: OBJECT_ID, id: ID },
}
const OTHER: WireQueryPart = {
  type: "query",
  query: { object: OBJECT_ID, limit: 5 },
}

function adapterOver(response: Parameters<typeof answeringTransport>[0]) {
  const { transport, calls } = answeringTransport(response)
  const runtime = createDataRuntime({
    catalog: clientCatalog(),
    transport,
    subject: SUBJECT,
  })
  return { adapter: createServerFunctionAdapter(runtime), calls }
}

async function failureOf(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(CommandFailure)
  return (error as CommandFailure).error
}

describe("createServerFunctionAdapter", () => {
  it("sends every part in one read request with the subject and returns the answer unchanged", async () => {
    const answer = {
      epoch: null,
      items: [
        { ok: true, value: { rows: [{ id: ID }], more: true } },
        {
          ok: false,
          error: { code: "command.unavailable", reason: "batch-aborted" },
        },
      ],
    }
    const { adapter, calls } = adapterOver(ok(answer))
    await expect(adapter.read([PART, OTHER])).resolves.toEqual(answer)
    expect(calls).toEqual([
      {
        subject: SUBJECT,
        request: { type: "read", items: [PART, OTHER] },
      },
    ])
  })

  it("passes the epoch of the answer on", async () => {
    const epoch = "c".repeat(64)
    const { adapter } = adapterOver(
      ok({ epoch, items: [{ ok: true, value: { rows: [] } }] })
    )
    expect((await adapter.read([PART])).epoch).toBe(epoch)
  })

  it("rejects with the logical CommandFailure of a failed response", async () => {
    const { adapter } = adapterOver(
      failed({ code: "command.forbidden", object: OBJECT_ID, path: "org_id" })
    )
    expect(await failureOf(adapter.read([PART]))).toEqual({
      code: "command.forbidden",
      object: { kind: "Catalog", name: "Task" },
      path: "org",
    })
  })

  it("rejects with command.unavailable when the transport fails", async () => {
    const runtime = createDataRuntime({
      catalog: clientCatalog(),
      transport: () => Promise.reject(new Error("offline")),
      subject: SUBJECT,
      log: () => {},
    })
    const adapter = createServerFunctionAdapter(runtime)
    expect(await failureOf(adapter.read([PART, OTHER]))).toEqual({
      code: "command.unavailable",
    })
  })

  it.each([
    ["null", null],
    ["a string", "rows"],
    ["an object without items", { epoch: null }],
    ["no items", { epoch: null, items: [] }],
    ["an item that is not an object", { epoch: null, items: [null] }],
    [
      "an item whose value is not an object",
      { epoch: null, items: [{ ok: true, value: 3 }] },
    ],
    [
      "an epoch that is not a hash",
      { epoch: "x", items: [{ ok: true, value: { rows: [] } }] },
    ],
  ])("refuses %s as command.internal", async (_name, value) => {
    const { adapter } = adapterOver(ok(value))
    expect((await failureOf(adapter.read([PART]))).code).toBe(
      "command.internal"
    )
  })

  it("declares include support (Р5)", () => {
    expect(adapterOver(ok(null)).adapter.capabilities.include).toBe(true)
  })
})

describe("selectSource", () => {
  const serverFunction: SourceAdapter = {
    read: () => Promise.resolve({ epoch: null, items: [] }),
    capabilities: { include: true },
  }
  const override: SourceAdapter = {
    read: () => Promise.resolve({ epoch: null, items: [] }),
    capabilities: { include: false },
  }

  it.each(DATABASE_PROVIDERS)("%s: Server Function by default", (profile) => {
    expect(selectSource({ profile, serverFunction })).toBe(serverFunction)
  })

  it.each(DATABASE_PROVIDERS)(
    "%s: the application override wins",
    (profile) => {
      expect(selectSource({ profile, override, serverFunction })).toBe(override)
    }
  )
})

describe("DataError", () => {
  it("carries its code and is an Error", () => {
    const code: DataErrorCode = "data.views-limit"
    const error = new DataError(code)
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe(code)
    expect(error.name).toBe("DataError")
  })
})
