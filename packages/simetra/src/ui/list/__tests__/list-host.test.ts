// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Profiler, createElement, type ReactNode } from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { ClientCatalog } from "simetra/model"
import { SUBJECT, clientCatalog } from "../../../data/__tests__/support"
import { runtimeHandleOf } from "../../../data/runtime/handle"
import {
  createRuntimeHolder,
  type RuntimeHolder,
} from "../../../data/runtime/holder"
import {
  createDataRuntime,
  type DataRuntime,
} from "../../../data/runtime/runtime"
import {
  OBJECTS,
  ORG,
  TASK,
  isPage,
  key,
  readsOf,
  seed,
  S,
  settle,
  task,
  taskValues,
} from "../../../data/store/__tests__/core-support"
import { createFakeSource } from "../../../data/store/testing/fake-source"
import { DataRuntimeProvider, type RowView } from "simetra/data/react"
import { ORGANIZATION_ID } from "../../../model/runtime/__tests__/entries"
import { CatalogProvider } from "../../catalog"
import { MESSAGES, type MessageKey } from "../../messages"
import { NavigationProvider, type NavigationAdapter } from "../../navigation"
import { LIST_HEIGHT, ROW_HEIGHT } from "../geometry"
import { ListHost, ListRow } from "../list-host"
import { headerColumns } from "../../fields"
import { catalogIndex } from "simetra/model"

// Хост тестується над справжнім рантаймом T4 і фейковим сервером: стани
// рядків і вибірки дає ядро, а не підставлений знімок. Стани мутації
// (`pending`, `failed`, `conflict`, `unknown`) рантайм до #222 не дає — їх
// перевіряє рядок напряму.

const text = (key: MessageKey) => MESSAGES.en[key]

// jsdom не має розкладки: область прокрутки має висоту списку, слоти —
// сталу висоту рядка.
const scrollTops = new WeakMap<Element, number>()
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return scrollTops.get(this) ?? 0
    },
    set(this: Element, v: number) {
      scrollTops.set(this, v)
    },
  })
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => 100 * ROW_HEIGHT,
  })
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => LIST_HEIGHT,
  })
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 1000,
  })
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.hasAttribute("data-scroll"))
      return { top: 0, bottom: LIST_HEIGHT, height: LIST_HEIGHT } as DOMRect
    return { top: 0, bottom: ROW_HEIGHT, height: ROW_HEIGHT } as DOMRect
  }
})

const runtimes: DataRuntime[] = []
afterEach(() => {
  cleanup()
  for (const runtime of runtimes.splice(0)) runtime.dispose()
})

function makeRuntime(
  options: { windowPage?: number; objects?: ClientCatalog["objects"] } = {}
) {
  const objects = options.objects ?? OBJECTS
  const fake = createFakeSource({ objects })
  const catalog: ClientCatalog = { ...clientCatalog(), objects: [...objects] }
  const runtime = createDataRuntime({
    catalog,
    transport: () => Promise.reject(new Error("unused")),
    subject: SUBJECT,
    log: () => {},
    sources: {
      override: { [TASK]: () => fake.adapter, [ORG]: () => fake.adapter },
    },
    ...(options.windowPage === undefined
      ? {}
      : { limits: { windowPage: options.windowPage } }),
  })
  runtimes.push(runtime)
  return { fake, runtime, catalog, core: runtimeHandleOf(runtime).core }
}

const flush = () => act(async () => void (await settle()))

function navigation() {
  const adapter = {
    openCard: vi.fn<(object: string, key: string) => void>(),
    openList: vi.fn(),
    useBlockWhile: () => {},
  }
  return adapter satisfies NavigationAdapter
}

function mount(
  holder: RuntimeHolder,
  catalog: ClientCatalog,
  nav: NavigationAdapter = navigation(),
  extra?: ReactNode
) {
  return render(
    createElement(
      CatalogProvider,
      { catalog },
      createElement(
        NavigationProvider,
        { adapter: nav },
        createElement(
          DataRuntimeProvider,
          { holder },
          createElement(ListHost, { object: TASK }),
          extra
        )
      )
    )
  )
}

async function ready(options: Parameters<typeof makeRuntime>[0] = {}) {
  const harness = makeRuntime(options)
  seed(harness.fake, 1, 3)
  const holder = createRuntimeHolder(harness.runtime)
  const nav = navigation()
  const view = mount(holder, harness.catalog, nav)
  await flush()
  return { ...harness, holder, nav, view }
}

const rowOf = (c: HTMLElement, n: number) =>
  c.querySelector<HTMLElement>(`[data-row-key="${key(n)}"] [role="row"]`)!
const slotOf = (c: HTMLElement, n: number) =>
  c.querySelector<HTMLElement>(`[data-row-key="${key(n)}"]`)!
const panel = (c: HTMLElement) => c.querySelector('[data-region="panel"]')!
const button = (c: Element, label: string) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent === label)

describe("геометрія", () => {
  it("висоти рядка й списку збігаються з slots.css", () => {
    const css = readFileSync(
      join(import.meta.dirname, "../../slots.css"),
      "utf8"
    )
    const px = (name: string) =>
      Number(new RegExp(`${name}:\\s*(\\d+)px`).exec(css)?.[1])
    expect(px("--simetra-row-height")).toBe(40)
    expect(ROW_HEIGHT).toBe(px("--simetra-row-height"))
    expect(LIST_HEIGHT).toBe(px("--simetra-list-height"))
  })
})

describe("ListHost", () => {
  it("показує колонки шапки, рядки й атрибути контракту DOM", async () => {
    const { view } = await ready()
    const c = view.container
    expect(c.querySelector('[data-region="list"]')).not.toBeNull()
    expect(panel(c)).not.toBeNull()
    expect(c.querySelector("[data-scroll]")).not.toBeNull()
    const headers = [...c.querySelectorAll('[role="columnheader"]')].map(
      (h) => h.textContent
    )
    expect(headers).toEqual(["", "title", "status", "subject"])
    const row = rowOf(c, 1)
    expect(row.getAttribute("data-state")).toBe("synced")
    expect(row.querySelector('[data-field="title"]')?.textContent).toBe("t1")
    // `synced` — без позначки.
    expect(row.querySelector('[role="gridcell"]')?.textContent).toBe("")
    // Лічильника немає, але слот під нього є.
    expect(panel(c).querySelector('[data-slot="count"]')?.textContent).toBe("")
  })

  it("без даних — слот завантаження", () => {
    const { fake, runtime, catalog } = makeRuntime()
    seed(fake, 1, 3)
    const view = mount(createRuntimeHolder(runtime), catalog)
    const slot = view.container.querySelector('[data-loading="list"]')
    expect(slot?.textContent).toBe(text("state.loading"))
  })

  it("типовий orderBy — за ключем, типовий include — одноцільові Ref колонок", async () => {
    const withOwner = {
      ...task,
      attributes: [
        ...task.attributes,
        {
          ...task.attributes[0]!,
          name: "owner",
          column: "owner_id",
          ref: { object: ORGANIZATION_ID, constraint: "task_owner_id_fkey" },
        },
      ],
    }
    const harness = makeRuntime({ objects: [withOwner, OBJECTS[1]!] })
    harness.fake.insert(ORG, { ref: S })
    harness.fake.insert(TASK, taskValues(1, { owner: S }))
    mount(createRuntimeHolder(harness.runtime), harness.catalog)
    await flush()
    const page = readsOf(harness.fake, TASK).find((r) => isPage(r))!
    expect(page.query).toMatchObject({
      orderBy: [{ attribute: "ref", direction: "asc" }],
    })
    // Ціль `include` читається окремо за ключами — це й видно серверу.
    expect(readsOf(harness.fake, ORG).length).toBeGreaterThan(0)
  })

  it("клік і Enter відкривають картку", async () => {
    const { view, nav } = await ready()
    fireEvent.click(rowOf(view.container, 2))
    fireEvent.keyDown(rowOf(view.container, 2), { key: "Enter" })
    expect(nav.openCard.mock.calls).toEqual([
      [TASK, key(2)],
      [TASK, key(2)],
    ])
  })

  it("stale рядка — значення видно й «Може бути застарілим»", async () => {
    const { view, core } = await ready()
    act(() => {
      core.commit((w) => w.markStale(TASK, [key(1)], 99), core.token())
    })
    const row = rowOf(view.container, 1)
    expect(row.getAttribute("data-state")).toBe("stale")
    expect(row.querySelector('[role="gridcell"]')?.textContent).toBe(
      text("state.stale")
    )
    expect(row.querySelector('[data-field="title"]')?.textContent).toBe("t1")
  })

  it("hidden — слот того самого розміру без значень і без відкриття картки", async () => {
    const { view, core, nav } = await ready()
    act(() => {
      core.commit((w) => w.hide(TASK, [key(1)]), core.token())
    })
    const c = view.container
    const row = rowOf(c, 1)
    // Ядро віддає рядок як `stale` зі значеннями; хост показує `hidden`.
    expect(row.getAttribute("data-state")).toBe("hidden")
    expect(row.textContent).toBe(text("state.hidden"))
    expect(slotOf(c, 1).textContent).not.toContain("t1")
    expect(slotOf(c, 1).querySelector("[data-field]")).toBeNull()
    expect(slotOf(c, 1).style.height).toBe(`${ROW_HEIGHT}px`)
    expect(slotOf(c, 1).style.height).toBe(slotOf(c, 2).style.height)
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: "Enter" })
    expect(nav.openCard).not.toHaveBeenCalled()
  })

  it("removed — слот без значень, «Прибрати» оновлює склад", async () => {
    const { view, core, fake, nav } = await ready()
    fake.remove(TASK, key(2))
    act(() => {
      core.commit(
        (w) =>
          w.apply(TASK, { rows: [], absent: [key(2)] }, core.readEpoch(), null),
        core.token()
      )
    })
    const c = view.container
    const row = rowOf(c, 2)
    expect(row.getAttribute("data-state")).toBe("removed")
    expect(row.querySelector('[role="gridcell"]')?.textContent).toBe(
      text("state.removed")
    )
    expect(slotOf(c, 2).textContent).not.toContain("t2")
    expect(slotOf(c, 2).querySelector("[data-field]")).toBeNull()
    expect(slotOf(c, 2).style.height).toBe(slotOf(c, 1).style.height)
    // Без незавершеної мутації — лише «Прибрати».
    expect(row.querySelectorAll("button")).toHaveLength(1)
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: "Enter" })
    expect(nav.openCard).not.toHaveBeenCalled()
    fireEvent.click(button(row, text("action.remove"))!)
    await flush()
    expect(c.querySelector(`[data-row-key="${key(2)}"]`)).toBeNull()
    expect(rowOf(c, 3).getAttribute("data-state")).toBe("synced")
  })

  it("панель: hasNewRows і needsRefresh з діями, refreshing — у живому регіоні", async () => {
    const { view, core, fake } = await ready()
    const c = view.container
    act(() => {
      core.commit(
        (w) => w.markViews(TASK, { hasNewRows: true, needsRefresh: true }),
        core.token()
      )
    })
    expect(button(panel(c), text("action.showNew"))).toBeDefined()
    expect(button(panel(c), text("action.refreshList"))).toBeDefined()
    fake.hold = () => true
    fireEvent.click(button(panel(c), text("action.refreshList"))!)
    const polite = panel(c).querySelector('[aria-live="polite"]')!
    expect(polite.textContent).toBe(text("state.refreshing"))
    // Під час оновлення рядки видно.
    expect(rowOf(c, 1).querySelector('[data-field="title"]')?.textContent).toBe(
      "t1"
    )
    fake.hold = undefined
    act(() => fake.deliverAll())
    await flush()
    expect(polite.textContent).toBe("")
    expect(button(panel(c), text("action.showNew"))).toBeUndefined()
    expect(button(panel(c), text("action.refreshList"))).toBeUndefined()
  })

  it("помилка вибірки — код і «Повторити»", async () => {
    const { fake, runtime, catalog } = makeRuntime()
    fake.hold = () => true
    const view = mount(createRuntimeHolder(runtime), catalog)
    await flush()
    act(() => fake.take().fail("command.forbidden"))
    await flush()
    const p = panel(view.container)
    expect(p.querySelector("[data-error]")?.getAttribute("data-error")).toBe(
      "command.forbidden"
    )
    expect(button(p, text("action.retry"))).toBeDefined()
  })

  it("purged прибирає значення в тому самому кадрі й оголошує assertive", async () => {
    const harness = makeRuntime()
    seed(harness.fake, 1, 3)
    const holder = createRuntimeHolder(harness.runtime)
    // Кадр — кожен commit піддерева: `onRender` профайлера кличеться в фазі
    // commit, коли DOM уже змінено, і на commit лише дочірнього хоста теж.
    const frames: string[] = []
    const box = { current: null as HTMLDivElement | null }
    const Frames = (props: { children?: ReactNode }) =>
      createElement(
        Profiler,
        {
          id: "list",
          onRender: () => frames.push(box.current?.textContent ?? ""),
        },
        createElement(
          "div",
          { ref: (node: HTMLDivElement | null) => void (box.current = node) },
          props.children
        )
      )
    const view = render(
      createElement(
        CatalogProvider,
        { catalog: harness.catalog },
        createElement(
          NavigationProvider,
          { adapter: navigation() },
          createElement(
            DataRuntimeProvider,
            { holder },
            createElement(
              Frames,
              null,
              createElement(ListHost, { object: TASK })
            )
          )
        )
      )
    )
    await flush()
    expect(frames[frames.length - 1]).toContain("t1")
    const before = frames.length
    act(() => holder.replace(undefined, "signed-out"))
    // Перший кадр після закриття — уже без значень.
    expect(frames[before]).not.toContain("t1")
    expect(frames.slice(before).every((f) => !f.includes("t1"))).toBe(true)
    const p = panel(view.container)
    const assertive = p.querySelector('[aria-live="assertive"]')!
    expect(assertive.textContent).toBe(text("state.purged"))
    expect(assertive.getAttribute("data-reason")).toBe("signed-out")
    expect(button(p, text("action.reloadPage"))).toBeDefined()
    expect(view.container.querySelector("[data-row-key]")).toBeNull()
  })

  it("хост дочитує сторінку, коли крайовий слот видно, і не раніше", async () => {
    const { fake, runtime, catalog } = makeRuntime({ windowPage: 20 })
    seed(fake, 1, 60)
    const view = mount(createRuntimeHolder(runtime), catalog)
    await flush()
    const pages = () => readsOf(fake, TASK).filter((r) => isPage(r)).length
    // Сторінка з 20 рядків заповнює 15 видимих: крайовий слот поза видом.
    expect(pages()).toBe(1)
    const scroller = view.container.querySelector<HTMLElement>("[data-scroll]")!
    act(() => {
      scroller.scrollTop = 20 * ROW_HEIGHT - LIST_HEIGHT + ROW_HEIGHT
      fireEvent.scroll(scroller)
    })
    await flush()
    expect(pages()).toBe(2)
    expect(slotOf(view.container, 21)).not.toBeNull()
  })
})

describe("ListRow — стани мутації", () => {
  const catalog = catalogIndex(OBJECTS)
  const columns = headerColumns(task)
  const values = { title: "secret", status: null, subject: null }
  const synced = (over: Record<string, unknown>): RowView =>
    ({
      key: key(1),
      version: 1,
      values,
      state: "synced",
      staleFields: [],
      ...over,
    }) as RowView
  const draw = (row: RowView, onOpen = vi.fn(), onRemove = vi.fn()) =>
    render(
      createElement(ListRow, { row, columns, catalog, onOpen, onRemove })
    ).container.querySelector<HTMLElement>('[role="row"]')!

  it.each([
    ["pending", "state.pending"],
    ["unknown", "state.unknown"],
    ["failed", "state.failed"],
    ["conflict", "state.conflict"],
    ["stale", "state.stale"],
  ] as const)("%s — значення й ключ %s", (state, messageKey) => {
    const row = draw(synced({ state }))
    expect(row.getAttribute("data-state")).toBe(state)
    expect(row.querySelector('[role="gridcell"]')?.textContent).toBe(
      text(messageKey)
    )
    expect(row.querySelector('[data-field="title"]')?.textContent).toBe(
      "secret"
    )
  })

  it("failed — код відмови в підказці", () => {
    const row = draw(
      synced({
        state: "failed",
        mutation: { error: { code: "command.conflict" } },
      })
    )
    expect(row.querySelector('[role="gridcell"]')?.getAttribute("title")).toBe(
      "command.conflict"
    )
  })

  it.each(["synced", "pending", "failed", "conflict", "unknown", "stale"])(
    "hidden над %s — без значень",
    (state) => {
      const onOpen = vi.fn()
      const row = draw(synced({ state, hidden: true }), onOpen)
      expect(row.getAttribute("data-state")).toBe("hidden")
      expect(row.textContent).toBe(text("state.hidden"))
      expect(row.querySelector("[data-field]")).toBeNull()
      fireEvent.click(row)
      expect(onOpen).not.toHaveBeenCalled()
    }
  )

  it("removed з незавершеною мутацією — «Прибрати» і «Скасувати»", () => {
    const cancel = vi.fn()
    const onRemove = vi.fn()
    const row = draw(
      { key: key(1), state: "removed", mutation: { cancel } } as RowView,
      vi.fn(),
      onRemove
    )
    fireEvent.click(button(row, text("action.remove"))!)
    fireEvent.click(button(row, text("action.cancel"))!)
    expect(onRemove).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
