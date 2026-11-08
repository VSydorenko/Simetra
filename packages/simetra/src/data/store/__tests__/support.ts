import { createCoreSession } from "../core"
import { FakeServer, controlledSource } from "../testing/fake-source"
import type {
  CoreOptions,
  ObjectSpec,
  ViewHandle,
  ViewSnapshot,
} from "../types"

/** Спільні фікстури тестів ядра: один довідник з лінивим полем і ТЧ. */

export const TASK = "Catalog.Task"

export const taskSpec: ObjectSpec = {
  ref: { kind: "Catalog", name: "Task" },
  fields: { title: "string", rank: "number", done: "boolean" },
  lazy: ["body"],
  sections: ["items"],
}

/** Детермінований UUID за номером. */
export const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

export function setup(options: Partial<CoreOptions> = {}) {
  const server = new FakeServer([taskSpec])
  const transport = controlledSource(server)
  const session = createCoreSession({
    subject: "user-1",
    source: transport.source,
    objects: [taskSpec],
    releaseDelayMs: 0,
    ...options,
  })
  return { server, transport, session }
}

/** Підписаний вигляд: журнал знімків, по одному на сповіщення. */
export function watch(handle: ViewHandle) {
  const frames: ViewSnapshot[] = [handle.getSnapshot()]
  const unsubscribe = handle.subscribe(() => frames.push(handle.getSnapshot()))
  frames[0] = handle.getSnapshot()
  return {
    frames,
    unsubscribe,
    get last(): ViewSnapshot {
      return frames[frames.length - 1] as ViewSnapshot
    },
  }
}
