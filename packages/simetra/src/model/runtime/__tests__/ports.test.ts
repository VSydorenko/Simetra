import { describe, expect, expectTypeOf, it } from "vitest"
import type { DataRequest, DataResponse } from "../envelope"
import type {
  DataTransport,
  SignalErrorKind,
  SignalTransport,
  SourceAdapter,
  Unsubscribe,
  WireRowsQuery,
  WireRowsResult,
} from "../ports"

const OBJECT = "11111111-1111-4111-8111-111111111111"

// Фейкові реалізації мають компілюватися проти портів: порт — лише тип,
// тож перевірка йде на рівні типів.
const adapter: SourceAdapter = {
  capabilities: { include: false },
  read: async () => ({ rows: [] }),
}

const transport: SignalTransport = {
  subscribe: () => () => {},
  onSubscribed: () => () => {},
}

describe("ports", () => {
  it("accept a fake implementation of both ports", async () => {
    expectTypeOf(adapter).toExtend<SourceAdapter>()
    expectTypeOf(transport).toExtend<SignalTransport>()
    expectTypeOf<SignalErrorKind>().toEqualTypeOf<"auth" | "transport">()
    expectTypeOf<Unsubscribe>().toEqualTypeOf<() => void>()
    expect(await adapter.read({ object: OBJECT, limit: 10 })).toEqual({
      rows: [],
    })
  })

  it("keep both count forms out of the adapter query", () => {
    expectTypeOf<WireRowsQuery>().not.toExtend<{ count: true }>()
    const objectCount = { object: OBJECT, count: true } as const
    const sectionCount = {
      object: OBJECT,
      tabularSection: OBJECT,
      count: true,
    } as const
    // @ts-expect-error лічильник об'єкта йде через DataTransport, не адаптер
    void adapter.read(objectCount)
    // @ts-expect-error лічильник ТЧ теж
    void adapter.read(sectionCount)
  })

  it("keep the count result out of the adapter result", () => {
    expectTypeOf<WireRowsResult>().not.toExtend<{ count: number }>()
    const bad: SourceAdapter = {
      capabilities: { include: false },
      // @ts-expect-error адаптер не повертає лічильник
      read: async () => ({ count: 1 }),
    }
    expect(bad).toBeDefined()
  })
})

describe("DataTransport", () => {
  it("maps a request to a response", () => {
    expectTypeOf<DataTransport>().toEqualTypeOf<
      (request: DataRequest) => Promise<DataResponse>
    >()
  })
})
