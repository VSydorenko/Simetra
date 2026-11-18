import {
  CommandFailure,
  type DataRequest,
  type DataResponse,
  type DataTransport,
  type WireCommandError,
} from "simetra/model"
import { failed, ok } from "../../data/__tests__/support"
import type { FakeSource } from "../../data/store/testing/fake-source"

/*
 * Міст транспорту рантайму до фейкового сервера ядра для тестів хостів:
 * читання йдуть адаптером-перевизначенням, а запис (`run`) і `version` —
 * справжньою обгорткою `send` рантайму, як у застосунку. Тест сам вирішує,
 * коли сервер відповідає (`hold`), і може підставити відповідь (`replies`).
 */
export function serverTransport(fake: FakeSource) {
  const calls: DataRequest[] = []
  const replies: DataResponse[] = []
  const held: (() => void)[] = []
  const state = { hold: false }
  const answer = async (body: DataRequest): Promise<DataResponse> => {
    const reply = replies.shift()
    if (reply !== undefined) return reply
    try {
      const { request } = body
      const value =
        request.type === "run"
          ? await fake.server.run(
              request as Parameters<FakeSource["server"]["run"]>[0]
            )
          : await fake.server.version()
      return ok(value)
    } catch (error) {
      if (error instanceof CommandFailure)
        return failed(error.error as WireCommandError)
      throw error
    }
  }
  const transport: DataTransport = (body) => {
    calls.push(body)
    if (!state.hold) return answer(body)
    return new Promise((resolve, reject) =>
      held.push(() => void answer(body).then(resolve, reject))
    )
  }
  return {
    transport,
    calls,
    replies,
    /** Holds every request until {@link release}. */
    set hold(value: boolean) {
      state.hold = value
    },
    release() {
      state.hold = false
      for (const go of held.splice(0)) go()
    },
  }
}

/** The next `version` answers a foreign kernel hash for `objectId`: the object turns stale-client. */
export function staleKernel(fake: FakeSource, objectId: string) {
  const real = fake.server.version
  fake.server.version = async () => {
    const answer = (await real()) as {
      items: { value: { objects: Record<string, string> } }[]
    }
    answer.items[0]!.value.objects[objectId] = "1".repeat(64)
    return answer
  }
}
