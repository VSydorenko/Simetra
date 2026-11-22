import { describe, expect, expectTypeOf, it } from "vitest"
import type { DataRequest, DataResponse } from "../envelope"
import type {
  DataTransport,
  SignalError,
  SignalTransport,
  SourceAdapter,
  Unsubscribe,
  WireRowsQuery,
} from "../ports"

const OBJECT = "11111111-1111-4111-8111-111111111111"

// Фейкові реалізації мають компілюватися проти портів: порт — лише тип,
// тож перевірка йде на рівні типів.
const adapter: SourceAdapter = {
  capabilities: { include: false },
  read: async () => ({ epoch: null, items: [] }),
}

const transport: SignalTransport = {
  subscribe: () => () => {},
  onSubscribed: () => () => {},
  refreshTokens: async () => {},
  close: () => {},
}

describe("ports", () => {
  it("accept a fake implementation of both ports", async () => {
    expectTypeOf(adapter).toExtend<SourceAdapter>()
    expectTypeOf(transport).toExtend<SignalTransport>()
    expectTypeOf<SignalError>().toEqualTypeOf<{
      kind: "auth" | "transport"
      channel?: string
      final?: true
    }>()
    expectTypeOf<SignalTransport["onSubscribed"]>().toEqualTypeOf<
      (
        handler: (event: { channel: string; recovered: boolean }) => void
      ) => Unsubscribe
    >()
    expectTypeOf<SignalTransport["refreshTokens"]>().toEqualTypeOf<
      (channels?: readonly string[]) => Promise<void>
    >()
    expectTypeOf<SignalTransport["close"]>().toEqualTypeOf<() => void>()
    expectTypeOf<Unsubscribe>().toEqualTypeOf<() => void>()
    expect(
      await adapter.read([
        { type: "query", query: { object: OBJECT, limit: 10 } },
      ])
    ).toEqual({ epoch: null, items: [] })
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
    void adapter.read([{ type: "query", query: objectCount }])
    // @ts-expect-error лічильник ТЧ теж
    void adapter.read([{ type: "query", query: sectionCount }])
  })
})

describe("DataTransport", () => {
  it("maps a request to a response", () => {
    expectTypeOf<DataTransport>().toEqualTypeOf<
      (request: DataRequest) => Promise<DataResponse>
    >()
  })
})
