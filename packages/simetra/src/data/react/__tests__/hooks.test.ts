// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { Component, StrictMode, createElement, type ReactNode } from "react"
import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { SUBJECT, clientCatalog } from "../../__tests__/support"
import { runtimeHandleOf } from "../../runtime/handle"
import { createRuntimeHolder, type RuntimeHolder } from "../../runtime/holder"
import { createDataRuntime, type DataRuntime } from "../../runtime/runtime"
import {
  OBJECTS,
  TASK,
  key,
  seed,
  settle,
  taskValues,
} from "../../store/__tests__/core-support"
import { createFakeSource } from "../../store/testing/fake-source"
import {
  DataRuntimeProvider,
  useRow,
  useRows,
  type UseRowResult,
  type UseRowsResult,
} from "../index"

// Хуки тестуються над справжнім рантаймом і фейковим сервером: перевіряється
// публічний шлях `createDataRuntime` → тримач → хук, без підміни ядра.

const runtimes: DataRuntime[] = []

function makeRuntime(
  options: { residency?: Record<string, "full" | "window"> } = {}
) {
  const fake = createFakeSource({ objects: OBJECTS })
  const runtime = createDataRuntime({
    catalog: { ...clientCatalog(), objects: OBJECTS },
    transport: () => Promise.reject(new Error("unused")),
    subject: SUBJECT,
    log: () => {},
    sources: { override: { [TASK]: () => fake.adapter } },
    ...options,
  })
  runtimes.push(runtime)
  return { fake, runtime, core: runtimeHandleOf(runtime).core }
}

afterEach(() => {
  cleanup()
  for (const runtime of runtimes.splice(0)) runtime.dispose()
})

const flush = () => act(async () => void (await settle()))

/** Рендерить хук під провайдером і складає кожен кадр його результату. */
function mount<T>(
  holder: RuntimeHolder,
  useIt: () => T,
  options: { strict?: boolean } = {}
) {
  const frames: T[] = []
  const Probe = () => {
    frames.push(useIt())
    return null
  }
  const tree = () => {
    const inner = createElement(DataRuntimeProvider, {
      holder,
      children: createElement(Probe),
    })
    return options.strict === true
      ? createElement(StrictMode, null, inner)
      : inner
  }
  const view = render(tree())
  return {
    frames,
    last: () => frames[frames.length - 1]!,
    rerender: () => view.rerender(tree()),
  }
}

const rowsOf = (result: UseRowsResult) =>
  result.rows.map((r) => (r.state === "removed" ? undefined : r.values.title))

describe("runtime holder", () => {
  it("replaces the runtime, disposes the previous and notifies", () => {
    const a = makeRuntime().runtime
    const b = makeRuntime().runtime
    const holder = createRuntimeHolder(a)
    let calls = 0
    const off = holder.subscribe(() => calls++)
    expect(holder.current()).toBe(a)
    holder.replace(b)
    expect(a.disposed).toBe(true)
    expect(holder.current()).toBe(b)
    expect(holder.closed()).toBeUndefined()
    holder.replace(undefined, "subject-changed")
    expect(b.disposed).toBe(true)
    expect(holder.current()).toBeUndefined()
    expect(holder.closed()).toBe("subject-changed")
    off()
    holder.replace(undefined)
    expect(calls).toBe(2)
  })
})

describe("hooks without a provider", () => {
  it("throws an Error", () => {
    const Bare = () => {
      useRows({ object: TASK })
      return null
    }
    const quiet = console.error
    console.error = () => {}
    try {
      expect(() => render(createElement(Bare))).toThrow(Error)
    } finally {
      console.error = quiet
    }
  })
})

describe("useRows", () => {
  it("loads a window and keeps the result while the view is unchanged", async () => {
    const { fake, runtime } = makeRuntime()
    seed(fake, 1, 3)
    const holder = createRuntimeHolder(runtime)
    const view = mount(holder, () => useRows({ object: TASK }))
    expect(view.last().status).toBe("loading")
    expect(view.last().rows).toEqual([])
    await flush()
    expect(view.last().status).toBe("ready")
    expect(rowsOf(view.last())).toEqual(["t1", "t2", "t3"])
    expect(view.last().strategy).toBe("window")
    const settled = view.last()
    view.rerender()
    expect(view.last()).toBe(settled)
  })

  it("picks full or window by the runtime residency", async () => {
    const { fake, runtime } = makeRuntime({ residency: { [TASK]: "full" } })
    seed(fake, 1, 2)
    const view = mount(createRuntimeHolder(runtime), () =>
      useRows({ object: TASK })
    )
    await flush()
    expect(view.last().strategy).toBe("full")
    expect(rowsOf(view.last())).toEqual(["t1", "t2"])
  })

  it("renders the first frame on the server from the same snapshot", () => {
    const { runtime } = makeRuntime()
    const html = renderToString(
      createElement(DataRuntimeProvider, {
        holder: createRuntimeHolder(runtime),
        children: createElement(() => {
          const { status, rows } = useRows({ object: TASK })
          return createElement("p", null, `${status}:${rows.length}`)
        }),
      })
    )
    expect(html).toBe("<p>loading:0</p>")
  })

  it("StrictMode reads once and never shows an empty frame after rows", async () => {
    const plain = makeRuntime()
    seed(plain.fake, 1, 2)
    mount(createRuntimeHolder(plain.runtime), () => useRows({ object: TASK }))
    await flush()
    const strict = makeRuntime()
    seed(strict.fake, 1, 2)
    const view = mount(
      createRuntimeHolder(strict.runtime),
      () => useRows({ object: TASK }),
      { strict: true }
    )
    await flush()
    expect(strict.fake.log.length).toBe(plain.fake.log.length)
    const shown = view.frames.findIndex((f) => f.rows.length > 0)
    expect(shown).toBeGreaterThan(-1)
    expect(view.frames.slice(shown).every((f) => f.rows.length > 0)).toBe(true)
  })

  it("shows hidden, purged and removed in the frame of the core commit", async () => {
    const { fake, runtime, core } = makeRuntime()
    seed(fake, 1, 3)
    const view = mount(createRuntimeHolder(runtime), () =>
      useRows({ object: TASK })
    )
    await flush()
    const handle = core.view({ kind: "window", object: TASK })

    const before = view.frames.length
    act(() => {
      core.commit((w) => w.hide(TASK, [key(1)]), core.token())
    })
    // Один `commit` ядра — один новий кадр, і він збігається зі знімком ядра.
    expect(view.frames.length).toBe(before + 1)
    expect(view.last().rows).toBe(handle.getSnapshot().rows)
    const hidden = view.last().rows.find((r) => r.key === key(1))
    expect(
      hidden !== undefined && hidden.state !== "removed" && hidden.hidden
    ).toBe(true)

    act(() => {
      core.commit(
        (w) =>
          w.apply(TASK, { rows: [], absent: [key(2)] }, core.readEpoch(), null),
        core.token()
      )
    })
    expect(view.last().rows).toBe(handle.getSnapshot().rows)
    expect(view.last().rows.find((r) => r.key === key(2))?.state).toBe(
      "removed"
    )

    act(() => {
      core.commit((w) => w.purge(TASK, { keys: [key(3)] }), core.token())
    })
    expect(view.last().rows).toBe(handle.getSnapshot().rows)
    expect(view.last().rows.some((r) => r.key === key(3))).toBe(false)
  })

  it("keeps a closed runtime as a stable snapshot with the reason", async () => {
    const { fake, runtime } = makeRuntime()
    seed(fake, 1, 2)
    const view = mount(createRuntimeHolder(runtime), () =>
      useRows({ object: TASK })
    )
    await flush()
    act(() => runtime.dispose())
    expect(view.last().status).toBe("purged")
    expect(view.last().reason).toBe("disposed")
    expect(view.last().rows).toEqual([])
    const stable = view.last()
    view.rerender()
    expect(view.last()).toBe(stable)
  })

  it("shows a stable closed snapshot when the holder has no runtime", () => {
    const holder = createRuntimeHolder()
    const view = mount(holder, () => useRows({ object: TASK }))
    expect(view.last().status).toBe("loading")
    act(() => holder.replace(undefined, "signed-out"))
    expect(view.last().status).toBe("purged")
    expect(view.last().reason).toBe("signed-out")
    const stable = view.last()
    view.rerender()
    expect(view.last()).toBe(stable)
  })

  it("moves a mounted hook to the new runtime without the previous rows", async () => {
    const first = makeRuntime()
    seed(first.fake, 1, 2)
    const second = makeRuntime()
    second.fake.insert(TASK, taskValues(9))
    const holder = createRuntimeHolder(first.runtime)
    const view = mount(holder, () => useRows({ object: TASK }))
    await flush()
    expect(rowsOf(view.last())).toEqual(["t1", "t2"])
    act(() => holder.replace(second.runtime))
    expect(view.last().rows).toEqual([])
    await flush()
    expect(rowsOf(view.last())).toEqual(["t9"])
    expect(
      view.frames.some((f) => f.rows.some((r) => r.key === key(1))) &&
        view.last().rows.some((r) => r.key === key(1))
    ).toBe(false)
  })

  it("passes a synchronous refusal of the filter to the error boundary", () => {
    const { runtime } = makeRuntime()
    const caught: unknown[] = []
    class Boundary extends Component<
      { children?: ReactNode },
      { failed: boolean }
    > {
      override state = { failed: false }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      override componentDidCatch(error: unknown) {
        caught.push(error)
      }
      override render() {
        return this.state.failed ? "failed" : this.props.children
      }
    }
    const Bad = () => {
      useRows({
        object: TASK,
        where: { attribute: "nope", op: "eq", value: 1 },
      })
      return null
    }
    const quiet = console.error
    console.error = () => {}
    try {
      render(
        createElement(DataRuntimeProvider, {
          holder: createRuntimeHolder(runtime),
          children: createElement(Boundary, null, createElement(Bad)),
        })
      )
    } finally {
      console.error = quiet
    }
    expect(caught.length).toBe(1)
  })

  it("acts on the view: showNew and refresh are bound to the handle", async () => {
    const { fake, runtime } = makeRuntime()
    seed(fake, 1, 2)
    const view = mount(createRuntimeHolder(runtime), () =>
      useRows({ object: TASK })
    )
    await flush()
    const chain = view.last().chain
    fake.insert(TASK, taskValues(3))
    act(() => view.last().refresh())
    await flush()
    expect(view.last().chain).not.toBe(chain)
    expect(rowsOf(view.last())).toEqual(["t1", "t2", "t3"])
  })
})

describe("useRow", () => {
  it("shows a row the list already read at once, without a skeleton", async () => {
    const { fake, runtime } = makeRuntime()
    seed(fake, 1, 2)
    const holder = createRuntimeHolder(runtime)
    const list = mount(holder, () => useRows({ object: TASK }))
    await flush()
    expect(list.last().status).toBe("ready")
    const card = mount(holder, () => useRow({ object: TASK, id: key(2) }))
    const first = card.frames[0]!
    expect(first.row?.state).toBe("synced")
    expect(first.version).toBeGreaterThan(0)
  })

  it("reads the header and a tabular section; editable when versions match", async () => {
    const { fake, runtime } = makeRuntime()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", [
      { ref: key(11), qty: 1 },
      { ref: key(12), qty: 2 },
    ])
    const card = mount(createRuntimeHolder(runtime), () =>
      useRow({ object: TASK, id: key(1), tabularSections: ["lines"] })
    )
    expect(card.last().editable).toBe(false)
    await flush()
    const result: UseRowResult = card.last()
    expect(result.status).toBe("ready")
    expect(result.tabularSections.lines?.lines.length).toBe(2)
    expect(result.tabularSections.lines?.complete).toBe(true)
    expect(result.editable).toBe(true)
    expect(result.isStale).toBe(false)
    const stable = card.last()
    card.rerender()
    expect(card.last()).toBe(stable)
  })

  it("is not editable while the header version differs from the lines version", async () => {
    const { fake, runtime, core } = makeRuntime()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", [{ ref: key(11), qty: 1 }])
    const card = mount(createRuntimeHolder(runtime), () =>
      useRow({ object: TASK, id: key(1), tabularSections: ["lines"] })
    )
    await flush()
    expect(card.last().editable).toBe(true)
    // Шапку оновив зовнішній запис (сигнал), а рядки ТЧ ще старої версії.
    fake.edit(TASK, key(1), { title: "changed" })
    const row = fake.row(TASK, key(1))!
    act(() => {
      core.commit(
        (w) =>
          w.apply(TASK, { rows: [row], absent: [] }, core.readEpoch(), null),
        core.token()
      )
    })
    expect(card.last().row?.state).toBe("synced")
    expect(card.last().version).toBe(row.version)
    expect(card.last().editable).toBe(false)
  })

  it("is not editable while the values are hidden", async () => {
    const { fake, runtime, core } = makeRuntime()
    seed(fake, 1, 1)
    const card = mount(createRuntimeHolder(runtime), () =>
      useRow({ object: TASK, id: key(1) })
    )
    await flush()
    expect(card.last().editable).toBe(true)
    // Читання, почате після позначки, її знімає; до відповіді ключ схований.
    fake.mode = "manual"
    act(() => {
      core.commit((w) => w.hide(TASK, [key(1)]), core.token())
    })
    expect(card.last().editable).toBe(false)
  })

  it("is closed with the reason when the runtime is disposed", async () => {
    const { fake, runtime } = makeRuntime()
    seed(fake, 1, 1)
    const card = mount(createRuntimeHolder(runtime), () =>
      useRow({ object: TASK, id: key(1) })
    )
    await flush()
    act(() => runtime.dispose())
    expect(card.last().status).toBe("purged")
    expect(card.last().reason).toBe("disposed")
    expect(card.last().editable).toBe(false)
  })
})
