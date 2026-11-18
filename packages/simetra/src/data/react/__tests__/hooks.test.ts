// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { Component, StrictMode, createElement, type ReactNode } from "react"
import { renderToString } from "react-dom/server"
import type { DataTransport } from "simetra/model"
import { afterEach, describe, expect, it } from "vitest"
import { SUBJECT, clientCatalog } from "../../__tests__/support"
import { writerOf } from "../../data-writer"
import { runtimeHandleOf } from "../../runtime/handle"
import { createRuntimeHolder, type RuntimeHolder } from "../../runtime/holder"
import { createDataRuntime, type DataRuntime } from "../../runtime/runtime"
import {
  OBJECTS,
  TASK,
  isCard,
  isSection,
  key,
  readsOf,
  S,
  seed,
  settle,
  taskValues,
} from "../../store/__tests__/core-support"
import { createFakeSource } from "../../store/testing/fake-source"
import type { RowView } from "../../store/types"
import {
  DataRuntimeProvider,
  useRow,
  useRows,
  useWriter,
  type UseRowResult,
  type UseRowsResult,
} from "../index"

// Хуки тестуються над справжнім рантаймом і фейковим сервером: перевіряється
// публічний шлях `createDataRuntime` → тримач → хук, без підміни ядра.

const runtimes: DataRuntime[] = []

function makeRuntime(
  options: {
    residency?: Record<string, "full" | "window">
    limits?: { revalidateIntervalMs: number }
    objects?: typeof OBJECTS
    transport?: DataTransport
  } = {}
) {
  const { objects = OBJECTS, transport, ...runtimeOptions } = options
  const fake = createFakeSource({ objects })
  const runtime = createDataRuntime({
    catalog: { ...clientCatalog(), objects },
    transport: transport ?? (() => Promise.reject(new Error("unused"))),
    subject: SUBJECT,
    log: () => {},
    sources: { override: { [TASK]: () => fake.adapter } },
    ...runtimeOptions,
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

/**
 * Транспорт, що відповідає лише на `version`: kernelHash задачі дає тест,
 * тож інший хеш ставить об'єкту позначку stale-client (§6.4, §10).
 */
const versionTransport =
  (kernelOfTask: () => string): DataTransport =>
  () =>
    Promise.resolve({
      ok: true,
      serverHash: "server-hash",
      value: {
        epoch: null,
        items: [
          {
            ok: true,
            value: {
              snapshotHash: "server-hash",
              objects: Object.fromEntries(
                OBJECTS.map((o) => [
                  o.id,
                  o.id === OBJECTS[0]!.id ? kernelOfTask() : o.kernelHash,
                ])
              ),
            },
          },
        ],
      },
    })

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

describe("useWriter", () => {
  it("gives the writer of the held runtime, and of the new one after replace", async () => {
    const a = makeRuntime().runtime
    const b = makeRuntime().runtime
    const holder = createRuntimeHolder(a)
    const view = mount(holder, () => useWriter())
    expect(view.last()).toBe(writerOf(a))
    act(() => holder.replace(b))
    expect(view.last()).toBe(writerOf(b))
    expect(view.last()).not.toBe(writerOf(a))
    act(() => holder.replace(undefined, "signed-out"))
    // Без рантайму мутація осідає причиною закриття й нікуди не йде.
    const mutation = view
      .last()
      .update(TASK, key(1), {}, { expectedVersion: 1 })
    expect(await mutation.settled).toEqual({
      ok: false,
      error: { code: "command.unavailable", reason: "disposed" },
    })
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

  it("throws a TypeError in render for an unknown object", () => {
    const { runtime } = makeRuntime()
    const Bad = () => {
      useRows({ object: "Catalog.Nope" })
      return null
    }
    const quiet = console.error
    console.error = () => {}
    try {
      expect(() =>
        render(
          createElement(DataRuntimeProvider, {
            holder: createRuntimeHolder(runtime),
            children: createElement(Bad),
          })
        )
      ).toThrow(TypeError)
    } finally {
      console.error = quiet
    }
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

describe("isStale", () => {
  const EA = "a".repeat(64)
  const EB = "b".repeat(64)

  it("follows the stale-client mark of the object, not the state of a row", async () => {
    let kernel = OBJECTS[0]!.kernelHash
    const { fake, runtime, core } = makeRuntime({
      transport: versionTransport(() => kernel),
    })
    seed(fake, 1, 2)
    const holder = createRuntimeHolder(runtime)
    const list = mount(holder, () => useRows({ object: TASK }))
    const card = mount(holder, () => useRow({ object: TASK, id: key(1) }))
    await flush()
    expect(list.last().isStale).toBe(false)
    expect(card.last().isStale).toBe(false)
    // Стан рядка `stale` (markStale) об'єкта застарілим не робить.
    const shown = card.last().row
    const version = shown?.state === "removed" ? 0 : shown!.version
    act(() => {
      core.commit((w) => w.markStale(TASK, [key(1)], version + 1), core.token())
    })
    expect(card.last().row).toMatchObject({ state: "stale" })
    expect(list.last().isStale).toBe(false)
    expect(card.last().isStale).toBe(false)
    // Позначка об'єкта — відповіддю `version` з іншим kernelHash.
    kernel = "1".repeat(64)
    await act(async () => {
      core.requestVersion()
      await settle()
    })
    expect(list.last().isStale).toBe(true)
    expect(card.last().isStale).toBe(true)
    kernel = OBJECTS[0]!.kernelHash
    await act(async () => {
      core.requestVersion()
      await settle()
    })
    expect(list.last().isStale).toBe(false)
    expect(card.last().isStale).toBe(false)
  })

  it("a version-epoch switch makes rows stale but not the object", async () => {
    const { fake, runtime, core } = makeRuntime({
      limits: { revalidateIntervalMs: 1 },
    })
    fake.epoch = EA
    seed(fake, 1, 2)
    const holder = createRuntimeHolder(runtime)
    const list = mount(holder, () => useRows({ object: TASK }))
    const card = mount(holder, () => useRow({ object: TASK, id: key(1) }))
    await flush()
    expect(list.last().isStale).toBe(false)
    expect(card.last().isStale).toBe(false)
    // Читання вже з іншою епохою: ядро перемикає епоху й позначає рядки
    // `stale` до власного перечитування. Сервер тримає всі читання, поки тест
    // їх не відпустить, тож перечитування не може обігнати перевірку.
    fake.epoch = EB
    fake.insert(TASK, taskValues(3))
    fake.mode = "manual"
    act(() => {
      void core.preload({ kind: "card", object: TASK, key: key(3) })
    })
    await flush()
    act(() => fake.take().answer())
    await flush()
    expect(card.last().row).toMatchObject({ state: "stale" })
    expect(list.last().isStale).toBe(false)
    expect(card.last().isStale).toBe(false)
    // Таймер системного перечитування (1 мс) спрацьовує, але відповідь тримає сервер.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
      await settle()
    })
    expect(card.last().row).toMatchObject({ state: "stale" })
    fake.mode = "auto"
    await act(async () => {
      fake.deliverAll()
      await new Promise((r) => setTimeout(r, 30))
      await settle()
    })
    expect(card.last().row).toMatchObject({ state: "synced" })
    expect(list.last().isStale).toBe(false)
    expect(card.last().isStale).toBe(false)
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
    // Задача без лінивого поля: повторно застосована шапка не робить жодного
    // поля `stale`, тож `editable` залежить лише від збігу версій.
    const task = OBJECTS[0]!
    const { fake, runtime, core } = makeRuntime({
      objects: [
        {
          ...task,
          attributes: task.attributes.filter((a) => a.name !== "notes"),
        },
        ...OBJECTS.slice(1),
      ],
    })
    fake.insert(TASK, { ref: key(1), org: S, title: "t1" })
    fake.setLines(TASK, key(1), "lines", [{ ref: key(11), qty: 1 }])
    const card = mount(createRuntimeHolder(runtime), () =>
      useRow({ object: TASK, id: key(1), tabularSections: ["lines"] })
    )
    await flush()
    expect(card.last().editable).toBe(true)
    // Шапку оновив зовнішній запис (сигнал), а рядки ТЧ ще старої версії.
    fake.edit(TASK, key(1), { title: "changed" })
    const row = fake.row(TASK, key(1))!
    // Перечитування ТЧ за новою версією шапки стартує мікрозадачею: `act`
    // його чекає, а відповідь тримає сервер.
    fake.mode = "manual"
    await act(async () => {
      core.commit(
        (w) =>
          w.apply(TASK, { rows: [row], absent: [] }, core.readEpoch(), null),
        core.token()
      )
      await settle()
    })
    const shown = card.last().row
    expect(shown?.state).toBe("synced")
    expect(shown?.state === "removed" ? [] : shown?.staleFields).toEqual([])
    expect(card.last().needsRefresh).toBe(false)
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

  /** A mounted card of task 1, editable before the case changes one fact. */
  async function editableCard(
    options: Parameters<typeof makeRuntime>[0] = {},
    tabularSections?: readonly string[]
  ) {
    const made = makeRuntime(options)
    seed(made.fake, 1, 1)
    made.fake.setLines(TASK, key(1), "lines", [{ ref: key(11), qty: 1 }])
    const card = mount(createRuntimeHolder(made.runtime), () =>
      useRow({
        object: TASK,
        id: key(1),
        ...(tabularSections === undefined ? {} : { tabularSections }),
      })
    )
    await flush()
    expect(card.last().editable).toBe(true)
    // Перечитування, яке позначка запускає, тримає сервер: перевіряється
    // стан саме з позначкою.
    made.fake.mode = "manual"
    return { ...made, card }
  }

  const versionOf = (row: RowView | undefined) =>
    row === undefined || row.state === "removed" ? 0 : row.version

  it("is not editable while the row carries a stale mark, and nothing else", async () => {
    const { core, card } = await editableCard()
    const version = versionOf(card.last().row)
    act(() => {
      core.commit((w) => w.markStale(TASK, [key(1)], version + 1), core.token())
    })
    const shown = card.last()
    expect(shown.row).toMatchObject({ stale: true, staleFields: [] })
    expect(shown.row).not.toHaveProperty("hidden")
    expect(shown.needsRefresh).toBe(false)
    expect(shown.isStale).toBe(false)
    expect(shown.editable).toBe(false)
  })

  it("is not editable while the object is marked stale-client, and nothing else", async () => {
    let kernel = OBJECTS[0]!.kernelHash
    const { core, card } = await editableCard({
      transport: versionTransport(() => kernel),
    })
    kernel = "1".repeat(64)
    await act(async () => {
      core.requestVersion()
      await settle()
    })
    const shown = card.last()
    expect(shown.isStale).toBe(true)
    expect(shown.row).toMatchObject({ state: "synced", staleFields: [] })
    expect(shown.row).not.toHaveProperty("stale")
    expect(shown.row).not.toHaveProperty("hidden")
    expect(shown.needsRefresh).toBe(false)
    expect(shown.editable).toBe(false)
  })

  it("is not editable while a field is stale, and nothing else", async () => {
    const { fake, core, card } = await editableCard()
    // Новіша шапка без лінивої колонки: `notes` — `stale` на рівні поля.
    fake.edit(TASK, key(1), { title: "changed" })
    const fresh = fake.row(TASK, key(1))!
    const values = { ...fresh.values }
    delete values.notes
    const row = { ...fresh, values }
    // Дочитування поля змонтованою карткою стартує мікрозадачею: `act` його
    // чекає, а відповідь тримає сервер.
    await act(async () => {
      core.commit(
        (w) =>
          w.apply(TASK, { rows: [row], absent: [] }, core.readEpoch(), null),
        core.token()
      )
      await settle()
    })
    const shown = card.last()
    expect(shown.row).toMatchObject({ staleFields: ["notes"] })
    expect(shown.row).not.toHaveProperty("stale")
    expect(shown.row).not.toHaveProperty("hidden")
    expect(shown.needsRefresh).toBe(false)
    expect(shown.isStale).toBe(false)
    expect(shown.editable).toBe(false)
  })

  it("is not editable while a view needsRefresh, and nothing else", async () => {
    const { core, card } = await editableCard()
    act(() => {
      core.commit(
        (w) => w.markViews(TASK, { needsRefresh: true }),
        core.token()
      )
    })
    const shown = card.last()
    expect(shown.needsRefresh).toBe(true)
    expect(shown.row).toMatchObject({ state: "synced", staleFields: [] })
    expect(shown.row).not.toHaveProperty("stale")
    expect(shown.isStale).toBe(false)
    expect(shown.editable).toBe(false)
  })

  it("refresh re-reads the header and the sections, needsRefresh clears after the answer", async () => {
    const { fake, core, card } = await editableCard({}, ["lines"])
    act(() => {
      core.commit(
        (w) => w.markViews(TASK, { needsRefresh: true }),
        core.token()
      )
    })
    expect(card.last().needsRefresh).toBe(true)
    const cards = readsOf(fake, TASK).filter(isCard).length
    const sections = readsOf(fake, TASK).filter(isSection).length
    act(() => card.last().refresh())
    expect(readsOf(fake, TASK).filter(isCard).length).toBe(cards + 1)
    expect(readsOf(fake, TASK).filter(isSection).length).toBe(sections + 1)
    expect(card.last().needsRefresh).toBe(true)
    await act(async () => {
      fake.deliverAll()
      await settle()
    })
    expect(card.last().needsRefresh).toBe(false)
    expect(card.last().editable).toBe(true)
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
