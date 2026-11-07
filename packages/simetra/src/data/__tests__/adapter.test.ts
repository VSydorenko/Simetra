import { describe, expect, it } from "vitest"
import {
  CommandFailure,
  DATABASE_PROVIDERS,
  type SourceAdapter,
  type WireRowsQuery,
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
const QUERY: WireRowsQuery = { object: OBJECT_ID, id: ID }

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
  it("sends a read with the subject and returns the rows unchanged", async () => {
    const value = { rows: [{ id: ID }], more: true }
    const { adapter, calls } = adapterOver(ok(value))
    await expect(adapter.read(QUERY)).resolves.toEqual(value)
    expect(calls).toEqual([
      { subject: SUBJECT, request: { type: "read", query: QUERY } },
    ])
  })

  it("maps a failed response to a logical CommandFailure by the catalog", async () => {
    const { adapter } = adapterOver(
      failed({ code: "command.forbidden", object: OBJECT_ID, path: "org_id" })
    )
    expect(await failureOf(adapter.read(QUERY))).toEqual({
      code: "command.forbidden",
      object: { kind: "Catalog", name: "Task" },
      path: "org",
    })
  })

  it("refuses a count result for a rows query as command.internal", async () => {
    const { adapter } = adapterOver(ok({ count: 3 }))
    expect((await failureOf(adapter.read(QUERY))).code).toBe("command.internal")
  })

  it("declares include support (Р5)", () => {
    expect(adapterOver(ok(null)).adapter.capabilities.include).toBe(true)
  })
})

describe("selectSource", () => {
  const serverFunction: SourceAdapter = {
    read: () => Promise.resolve({ rows: [] }),
    capabilities: { include: true },
  }
  const override: SourceAdapter = {
    read: () => Promise.resolve({ rows: [] }),
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
    const code: DataErrorCode = "data.unbounded-subset"
    const error = new DataError(code)
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe(code)
    expect(error.name).toBe("DataError")
  })
})
