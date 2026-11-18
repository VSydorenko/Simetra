// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import {
  Profiler,
  Suspense,
  createElement,
  startTransition,
  use,
  useEffect,
} from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ClientCatalog, SourceAdapter } from "simetra/model"
import { DataRuntimeProvider, useRow } from "simetra/data/react"
import { SUBJECT, clientCatalog, failed } from "../../../data/__tests__/support"
import { runtimeHandleOf } from "../../../data/runtime/handle"
import { createRuntimeHolder } from "../../../data/runtime/holder"
import {
  createDataRuntime,
  type DataRuntime,
} from "../../../data/runtime/runtime"
import { JOURNAL_MAX } from "../../../data/store/overlay"
import {
  OBJECTS,
  TASK,
  key,
  seed,
  settle,
  task,
  taskValues,
} from "../../../data/store/__tests__/core-support"
import { catalogEntry } from "../../../model/runtime/__tests__/entries"
import {
  createFakeSource,
  type FakeSource,
} from "../../../data/store/testing/fake-source"
import { serverTransport, staleKernel } from "../../__tests__/server-transport"
import { CatalogProvider } from "../../catalog"
import { MESSAGES, type MessageKey } from "../../messages"
import { NavigationProvider, type NavigationAdapter } from "../../navigation"
import { CardHost } from "../card-host"
import { useCardDraft, type CardDraft } from "../use-card-draft"

// Картка тестується над справжнім рантаймом T4: читання — адаптером
// фейкового сервера, запис — справжнім `useWriter` через транспорт до того
// самого фейка. Стани мутації дає ядро, а не підставлений рядок.

const K = key(1)
// Запис підтверджується в епосі версій бази: без неї відповідь `run` не має
// рядка, який ядро може показати.
const EPOCH = "e".repeat(64)
const text = (k: MessageKey) => MESSAGES.en[k]

const runtimes: DataRuntime[] = []
afterEach(() => {
  cleanup()
  for (const runtime of runtimes.splice(0)) runtime.dispose()
})

const flush = () => act(async () => void (await settle()))

function makeRuntime(
  fake: FakeSource,
  wire: ReturnType<typeof serverTransport>,
  adapter: (fake: FakeSource) => SourceAdapter = (f) => f.adapter,
  objects: ClientCatalog["objects"] = OBJECTS
) {
  const catalog: ClientCatalog = { ...clientCatalog(), objects: [...objects] }
  const runtime = createDataRuntime({
    catalog,
    transport: wire.transport,
    subject: SUBJECT,
    log: () => {},
    sources: {
      override: Object.fromEntries(
        objects.map((o) => [`${o.kind}.${o.name}`, () => adapter(fake)])
      ),
    },
  })
  runtimes.push(runtime)
  return { runtime, catalog, core: runtimeHandleOf(runtime).core }
}

async function opened(
  options: {
    adapter?: (fake: FakeSource) => SourceAdapter
    objects?: ClientCatalog["objects"]
    lines?: Parameters<FakeSource["setLines"]>[3]
    /** Mounts the bare hook instead of the host, to call its functions. */
    probe?: boolean
    /** A sibling of the card that suspends forever while it gets this key. */
    suspendOn?: string
  } = {}
) {
  const objects = options.objects ?? OBJECTS
  const fake = createFakeSource({ objects, epoch: EPOCH })
  seed(fake, 1, 1)
  if (options.lines !== undefined)
    fake.setLines(TASK, K, "lines", options.lines)
  const wire = serverTransport(fake)
  const { runtime, catalog, core } = makeRuntime(
    fake,
    wire,
    options.adapter,
    objects
  )
  const holder = createRuntimeHolder(runtime)
  // Кожен виклик `useBlockWhile` — кадр хоста: останній каже, чи блокує він.
  const blocks: boolean[] = []
  // Те саме, але лише закомічені кадри: незакомічений рендер переходу теж
  // викликає `useBlockWhile`, а блокує навігацію лише закомічений.
  const committedBlocks: boolean[] = []
  const nav: NavigationAdapter = {
    openCard: vi.fn(),
    openList: vi.fn(),
    useBlockWhile: (dirty) => {
      blocks.push(dirty)
      useEffect(() => void committedBlocks.push(dirty))
    },
  }
  // Кадр — commit піддерева картки (як у тесті списку): DOM уже змінено.
  const frames: string[] = []
  const box = { current: null as HTMLDivElement | null }
  const draft = { current: undefined as unknown as CardDraft }
  function Probe(props: { id: string }) {
    const row = useRow({ object: TASK, id: props.id })
    draft.current = useCardDraft({ object: TASK, id: props.id, card: row })
    return null
  }
  // Сусід картки, що на ключі `suspendOn` не дочитується ніколи: перехід на
  // нього лишається незакоміченим.
  const never = new Promise<never>(() => {})
  function Sibling(props: { id: string }) {
    if (props.id === options.suspendOn) use(never)
    return null
  }
  const tree = (id: string, object = TASK) =>
    createElement(
      CatalogProvider,
      { catalog },
      createElement(
        NavigationProvider,
        { adapter: nav },
        createElement(
          DataRuntimeProvider,
          { holder },
          createElement(
            Profiler,
            {
              id: "card",
              onRender: () => frames.push(box.current?.outerHTML ?? ""),
            },
            createElement(
              "div",
              {
                ref: (node: HTMLDivElement | null) => void (box.current = node),
              },
              createElement(
                Suspense,
                { fallback: null },
                options.probe === true
                  ? createElement(Probe, { id })
                  : createElement(CardHost, { object, id }),
                createElement(Sibling, { id })
              )
            )
          )
        )
      )
    )
  const view = render(tree(K))
  await flush()
  const c = view.container
  /** Re-renders the same card host (or probe) with another row key or object. */
  const reopen = (id: string, object?: string) =>
    act(() => void view.rerender(tree(id, object)))
  /** The same re-render inside `startTransition`. */
  const navigate = (id: string) =>
    act(async () => startTransition(() => void view.rerender(tree(id))))
  return {
    fake,
    wire,
    runtime,
    core,
    holder,
    blocks,
    committedBlocks,
    frames,
    c,
    draft,
    reopen,
    navigate,
  }
}

type Opened = Awaited<ReturnType<typeof opened>>

const card = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('[data-region="card"]')!
const slot = (c: HTMLElement, name: string) =>
  c.querySelector<HTMLElement>(`[data-field-slot="${name}"]`)!
const input = (c: HTMLElement, name: string) =>
  slot(c, name)?.querySelector<HTMLInputElement>(
    `input[data-field="${name}"], textarea[data-field="${name}"]`
  ) ?? null
const button = (c: HTMLElement, k: MessageKey) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent === text(k))
const status = (c: HTMLElement) =>
  c.querySelector('[data-card="status"]')?.textContent
const draftState = (c: HTMLElement) => card(c).getAttribute("data-draft")
const versionOf = (o: Opened) => o.fake.row(TASK, K)!.version

const type = (c: HTMLElement, name: string, value: string) =>
  act(() => void fireEvent.change(input(c, name)!, { target: { value } }))
const click = (c: HTMLElement, k: MessageKey) =>
  act(() => void fireEvent.click(button(c, k)!))

/** The values of the `run` requests sent, by wire field. */
const runs = (o: Opened) =>
  o.wire.calls
    .filter((call) => call.request.type === "run")
    .map(
      (call) =>
        (
          call.request as {
            operation: {
              values: Record<string, unknown>
              expectedVersion: number
            }
          }
        ).operation
    )

/** A foreign change on the server and the re-read that brings it into the store. */
async function foreignChange(o: Opened, values: Record<string, unknown>) {
  o.fake.edit(TASK, K, values)
  void o.core.revalidate(TASK, { visibleOnly: false })
  await flush()
}

/**
 * An adapter whose reads wait while `gate.held` is set, until `gate.open()`,
 * and fail while `gate.failing` is set.
 */
function gated() {
  const waiting: (() => void)[] = []
  const gate = {
    held: false,
    failing: false,
    open() {
      gate.held = false
      for (const go of waiting.splice(0)) go()
    },
  }
  const adapter = (fake: FakeSource): SourceAdapter => ({
    capabilities: fake.adapter.capabilities,
    async read(items) {
      if (gate.held) await new Promise<void>((go) => void waiting.push(go))
      if (gate.failing) throw new Error("read failed")
      return fake.adapter.read(items)
    },
  })
  return { gate, adapter }
}

/** An edit and a save through the host or through the bare hook. */
async function editAndSave(o: Opened, via: "host" | "probe", value: string) {
  if (via === "host") type(o.c, "title", value)
  else act(() => o.draft.current.setValue("title", value))
  return async () => {
    if (via === "host") click(o.c, "action.save")
    else act(() => o.draft.current.save())
    await flush()
  }
}

/** Brings the own mutation of the row to `conflict` or `failed`. */
async function reach(
  o: Opened,
  state: "conflict" | "failed",
  via: "host" | "probe"
) {
  const save = await editAndSave(o, via, "mine")
  if (state === "conflict") await foreignChange(o, { title: "theirs" })
  else o.wire.replies.push(failed({ code: "command.forbidden" }))
  await save()
  expect(o.draft.current?.state ?? draftState(o.c)).toBe(state)
}

/** What takes the write away from the card (П4-D §5.2, §5.4, П4-B §6.4). */
const BLOCKERS: [string, (o: Opened) => Promise<void>][] = [
  [
    "isStale (несумісний клієнт)",
    async (o) => {
      staleKernel(o.fake, task.id)
      act(() => o.core.requestVersion())
      await flush()
    },
  ],
  [
    "editable = false (поле шапки застаріле)",
    async (o) => {
      o.fake.edit(TASK, K, { title: "newer" })
      const full = o.fake.row(TASK, K)!
      const row = {
        ...full,
        values: Object.fromEntries(
          Object.entries(full.values).filter(([name]) => name !== "notes")
        ),
      }
      // Картка сама дочитує застаріле поле: сервер тримає читання, тож
      // стан не минає, а дочитування стартує всередині `act`.
      o.fake.mode = "manual"
      await act(async () => {
        o.core.commit(
          (w) =>
            w.apply(
              TASK,
              { rows: [row], absent: [] },
              o.core.readEpoch(),
              null
            ),
          o.core.token()
        )
        await settle()
      })
    },
  ],
  [
    "row.stale (застарілий рядок)",
    async (o) => {
      act(() => {
        o.core.commit((w) => w.markStale(TASK, [K], 99), o.core.token())
      })
      await flush()
    },
  ],
]

const WRITES: MessageKey[] = ["action.save", "action.overwrite", "action.retry"]
const enabledWrites = (c: HTMLElement) =>
  WRITES.filter((k) => button(c, k)?.disabled === false)

describe("CardHost — показ", () => {
  it("шапка в порядку каталогу; редаговане лише з update: true; ТЧ лише для читання в порядку номера рядка", async () => {
    // `status` без права зміни: той самий перерахування, але показ.
    const locked = {
      ...task,
      attributes: task.attributes.map((a) =>
        a.name === "status" ? { ...a, update: false } : a
      ),
    }
    const o = await opened({
      objects: [locked, ...OBJECTS.slice(1)],
      lines: [
        { ref: key(12), lineNumber: 2, qty: 2 },
        { ref: key(11), lineNumber: 1, qty: 1 },
      ],
    })
    const c = o.c
    const names = [...c.querySelectorAll("[data-field-slot]")].map((s) =>
      s.getAttribute("data-field-slot")
    )
    // Колонка скоупу `org` — службова, тож її в шапці немає.
    expect(names).toEqual(["title", "status", "subject", "notes"])
    expect(input(c, "title")?.value).toBe("t1")
    expect(input(c, "notes")?.value).toBe("body 1")
    expect(slot(c, "status").querySelector("select")).toBeNull()
    expect(
      slot(c, "status").querySelector('[data-field="status"]')
    ).not.toBeNull()
    const lines = [
      ...c.querySelectorAll('[data-section="lines"] tbody tr'),
    ].map((tr) => tr.getAttribute("data-line-key"))
    expect(lines).toEqual([key(11), key(12)])
    expect(c.querySelector('[data-section="lines"] input')).toBeNull()
    // Без змін «Зберегти» вимкнено.
    expect(button(c, "action.save")?.disabled).toBe(true)
    // Позитивний контроль: з `update: true` перерахування — `select`.
    cleanup()
    const editable = await opened()
    expect(slot(editable.c, "status").querySelector("select")).not.toBeNull()
  })

  it("editable = false (поле шапки застаріле) — поля лише для показу", async () => {
    const o = await opened()
    expect(input(o.c, "title")).not.toBeNull()
    // Новіша шапка без лінивого `notes`: поле `notes` стає застарілим.
    o.fake.edit(TASK, K, { title: "newer" })
    const full = o.fake.row(TASK, K)!
    const row = {
      ...full,
      values: Object.fromEntries(
        Object.entries(full.values).filter(([name]) => name !== "notes")
      ),
    }
    // Дочитування поля сервер тримає: так воно стартує всередині `act`.
    o.fake.mode = "manual"
    await act(async () => {
      o.core.commit(
        (w) =>
          w.apply(TASK, { rows: [row], absent: [] }, o.core.readEpoch(), null),
        o.core.token()
      )
      await settle()
    })
    expect(input(o.c, "title")).toBeNull()
    expect(slot(o.c, "title").textContent).toContain("newer")
    expect(
      slot(o.c, "notes").querySelector('[data-hint="stale"]')
    ).not.toBeNull()
  })

  it("tabular-too-large — причина замість рядків", async () => {
    const o = await opened({
      adapter: (fake) => ({
        capabilities: fake.adapter.capabilities,
        async read(items) {
          const answer = await fake.adapter.read(items)
          return {
            ...answer,
            items: answer.items.map((item, i) =>
              "tabularSection" in (items[i]!.query as object)
                ? {
                    ok: false as const,
                    error: {
                      code: "command.invalid" as const,
                      reason: "tabular-too-large",
                      path: "lines",
                    },
                  }
                : item
            ),
          }
        },
      }),
    })
    const section = o.c.querySelector('[data-section="lines"]')!
    expect(section.getAttribute("data-section-state")).toBe("tabular-too-large")
    expect(section.textContent).toBe("tabular-too-large")
    expect(section.querySelector("tr")).toBeNull()
  })
})

describe("useCardDraft — запис", () => {
  it("«Зберегти» шле лише змінені атрибути з expectedVersion = база; dirty блокує навігацію", async () => {
    const o = await opened()
    const v = versionOf(o)
    expect(o.blocks.at(-1)).toBe(false)
    type(o.c, "title", "mine")
    expect(o.blocks.at(-1)).toBe(true)
    expect(button(o.c, "action.save")?.disabled).toBe(false)
    click(o.c, "action.save")
    await flush()
    expect(runs(o)).toHaveLength(1)
    expect(Object.keys(runs(o)[0]!.values)).toEqual(["title"])
    expect(runs(o)[0]!.expectedVersion).toBe(v)
    expect(o.fake.row(TASK, K)!.values).toMatchObject({ title: "mine" })
    expect(draftState(o.c)).toBe("idle")
    expect(o.blocks.at(-1)).toBe(false)
  })

  it("відповідь на ревізію A не перезаписує правок ревізії B; база — версія результату", async () => {
    const o = await opened()
    type(o.c, "title", "A")
    type(o.c, "notes", "A notes")
    o.wire.hold = true
    click(o.c, "action.save")
    await flush()
    // Під час збереження поле показує чернетку, «Зберегти» вимкнено.
    expect(draftState(o.c)).toBe("saving")
    expect(status(o.c)).toBe(text("state.pending"))
    expect(button(o.c, "action.save")?.disabled).toBe(true)
    type(o.c, "title", "B")
    expect(input(o.c, "title")?.value).toBe("B")
    act(() => o.wire.release())
    await flush()
    expect(o.fake.row(TASK, K)!.values).toMatchObject({
      title: "A",
      notes: "A notes",
    })
    const resultVersion = versionOf(o)
    // Поле без правки після A — підтверджене; правка B лишилась.
    expect(input(o.c, "title")?.value).toBe("B")
    expect(input(o.c, "notes")?.value).toBe("A notes")
    expect(o.blocks.at(-1)).toBe(true)
    click(o.c, "action.save")
    await flush()
    const second = runs(o)[1]!
    expect(Object.keys(second.values)).toEqual(["title"])
    expect(second.expectedVersion).toBe(resultVersion)
    expect(o.fake.row(TASK, K)!.values).toMatchObject({ title: "B" })
    expect(o.blocks.at(-1)).toBe(false)
  })

  it("#227: чернетка на v5, сховище отримало v6 перечитуванням — збереження дає conflict, не тихий перезапис", async () => {
    const o = await opened()
    const v5 = versionOf(o)
    type(o.c, "title", "mine")
    await foreignChange(o, { title: "theirs" })
    const v6 = versionOf(o)
    expect(v6).toBeGreaterThan(v5)
    // Сховище вже показує v6, а поле — чернетку.
    expect(input(o.c, "title")?.value).toBe("mine")
    click(o.c, "action.save")
    await flush()
    expect(runs(o)[0]!.expectedVersion).toBe(v5)
    expect(draftState(o.c)).toBe("conflict")
    expect(o.fake.row(TASK, K)).toMatchObject({
      version: v6,
      values: { title: "theirs" },
    })
    // `conflict`: правки лишились, серверний рядок — поруч, дві дії.
    expect(input(o.c, "title")?.value).toBe("mine")
    expect(
      slot(o.c, "title").querySelector('[data-server="title"]')?.textContent
    ).toBe("theirs")
    expect(status(o.c)).toBe(text("state.conflict"))
    expect(button(o.c, "action.takeServer")).toBeDefined()
    // «Перезаписати» — нова база з поточного серверного рядка.
    click(o.c, "action.overwrite")
    await flush()
    expect(runs(o)[1]!.expectedVersion).toBe(v6)
    expect(o.fake.row(TASK, K)!.values).toMatchObject({ title: "mine" })
    expect(draftState(o.c)).toBe("idle")
  })

  it("«Взяти серверне» в conflict — один кадр назад до серверного рядка", async () => {
    const o = await opened()
    type(o.c, "title", "mine")
    await foreignChange(o, { title: "theirs" })
    click(o.c, "action.save")
    await flush()
    expect(draftState(o.c)).toBe("conflict")
    const before = o.frames.length
    click(o.c, "action.takeServer")
    expect(o.frames.length).toBe(before + 1)
    expect(input(o.c, "title")?.value).toBe("theirs")
    expect(draftState(o.c)).toBe("idle")
    expect(o.blocks.at(-1)).toBe(false)
  })

  it("failed лишає правки; command.invalid з path — біля поля; «Скасувати» — один кадр", async () => {
    const o = await opened()
    type(o.c, "title", "bad")
    type(o.c, "notes", "kept")
    o.wire.replies.push(failed({ code: "command.invalid", path: "title" }))
    click(o.c, "action.save")
    await flush()
    expect(draftState(o.c)).toBe("failed")
    expect(status(o.c)).toBe(text("state.failed"))
    expect(input(o.c, "title")?.value).toBe("bad")
    expect(input(o.c, "notes")?.value).toBe("kept")
    expect(o.blocks.at(-1)).toBe(true)
    expect(
      slot(o.c, "title")
        .querySelector("[data-field-error]")
        ?.getAttribute("data-field-error")
    ).toBe("command.invalid")
    expect(slot(o.c, "notes").querySelector("[data-field-error]")).toBeNull()
    expect(button(o.c, "action.retry")).toBeDefined()
    const before = o.frames.length
    click(o.c, "action.cancel")
    expect(o.frames.length).toBe(before + 1)
    expect(input(o.c, "title")?.value).toBe("t1")
    expect(input(o.c, "notes")?.value).toBe("body 1")
    expect(draftState(o.c)).toBe("idle")
    expect(o.c.querySelector("[data-field-error]")).toBeNull()
    expect(o.blocks.at(-1)).toBe(false)
  })

  it("відмова кодека T0 — біля поля, «Зберегти» вимкнено до виправлення", async () => {
    const o = await opened()
    type(o.c, "title", "x".repeat(101))
    expect(
      slot(o.c, "title")
        .querySelector("[data-field-error]")
        ?.getAttribute("data-field-error")
    ).toBe("command.invalid")
    expect(button(o.c, "action.save")?.disabled).toBe(true)
    type(o.c, "title", "ok")
    expect(slot(o.c, "title").querySelector("[data-field-error]")).toBeNull()
    expect(button(o.c, "action.save")?.disabled).toBe(false)
  })

  it("failed — «Повторити» шле мутацію ще раз і переносить базу", async () => {
    const o = await opened()
    type(o.c, "title", "again")
    o.wire.replies.push(failed({ code: "command.forbidden" }))
    click(o.c, "action.save")
    await flush()
    expect(draftState(o.c)).toBe("failed")
    click(o.c, "action.retry")
    await flush()
    expect(runs(o)).toHaveLength(2)
    expect(o.fake.row(TASK, K)!.values).toMatchObject({ title: "again" })
    expect(draftState(o.c)).toBe("idle")
    expect(o.blocks.at(-1)).toBe(false)
  })

  it("unknown — «Скасувати показ» (dismiss); чернетка лишається", async () => {
    const o = await opened()
    type(o.c, "title", "maybe")
    o.wire.replies.push(new Error("network"))
    click(o.c, "action.save")
    await flush()
    expect(draftState(o.c)).toBe("unknown")
    expect(status(o.c)).toBe(text("state.unknown"))
    click(o.c, "action.dismiss")
    expect(draftState(o.c)).toBe("idle")
    expect(input(o.c, "title")?.value).toBe("maybe")
    expect(o.blocks.at(-1)).toBe(true)
  })
})

describe("useCardDraft — одна охорона запису: save, overwrite, retry", () => {
  describe.each(["conflict", "failed"] as const)("%s", (state) => {
    it.each(BLOCKERS)(
      "%s — жодної ввімкненої дії запису в картці",
      async (name, block) => {
        const o = await opened()
        await reach(o, state, "host")
        await block(o)
        // Несумісний клієнт ховає рядок (спека П4-B §10): чернетка переходить у `hidden`.
        expect(draftState(o.c)).toBe(
          name.startsWith("isStale") ? "hidden" : state
        )
        expect(enabledWrites(o.c)).toEqual([])
      }
    )

    it.each(BLOCKERS)(
      "%s — save(), overwrite() і retry() хука нічого не шлють",
      async (_, block) => {
        const o = await opened({ probe: true })
        await reach(o, state, "probe")
        await block(o)
        expect(o.draft.current.canSave).toBe(false)
        const sent = runs(o).length
        act(() => {
          o.draft.current.save()
          o.draft.current.overwrite()
          o.draft.current.retry()
        })
        await flush()
        expect(runs(o)).toHaveLength(sent)
      }
    )

    // Позитивний контроль: без перешкоди та сама дія хука шле запис.
    it("без перешкоди — дія хука шле запис", async () => {
      const o = await opened({ probe: true })
      await reach(o, state, "probe")
      const sent = runs(o).length
      act(() =>
        state === "conflict"
          ? o.draft.current.overwrite()
          : o.draft.current.retry()
      )
      await flush()
      expect(runs(o)).toHaveLength(sent + 1)
    })
  })

  it("conflict до перечитування — без серверного значення й «Перезаписати»; після — обидва з новою версією", async () => {
    const { gate, adapter } = gated()
    const o = await opened({ adapter })
    type(o.c, "title", "mine")
    // Чужа зміна на сервері, якої сховище ще не бачило.
    o.fake.edit(TASK, K, { title: "theirs" })
    const v6 = versionOf(o)
    gate.held = true
    click(o.c, "action.save")
    await flush()
    expect(draftState(o.c)).toBe("conflict")
    expect(o.c.querySelector("[data-server]")).toBeNull()
    expect(button(o.c, "action.overwrite")?.disabled).not.toBe(false)
    // «Взяти серверне» теж чекає: інакше поля на мить показали б стару базу.
    expect(button(o.c, "action.takeServer")?.disabled).not.toBe(false)
    expect(status(o.c)).toBe(text("state.refreshing"))
    act(() => gate.open())
    await flush()
    expect(
      slot(o.c, "title").querySelector('[data-server="title"]')?.textContent
    ).toBe("theirs")
    expect(status(o.c)).toBe(text("state.conflict"))
    expect(button(o.c, "action.overwrite")?.disabled).toBe(false)
    expect(button(o.c, "action.takeServer")?.disabled).toBe(false)
    click(o.c, "action.overwrite")
    await flush()
    expect(runs(o)[1]!.expectedVersion).toBe(v6)
    expect(draftState(o.c)).toBe("idle")
  })
})

describe("useCardDraft — перечитування і відмова стану запису", () => {
  it("перечитування після conflict упало — «Оновити картку»; після нього серверне й «Перезаписати» з новою версією", async () => {
    const { gate, adapter } = gated()
    const o = await opened({ adapter })
    type(o.c, "title", "mine")
    o.fake.edit(TASK, K, { title: "theirs" })
    const v6 = versionOf(o)
    gate.failing = true
    click(o.c, "action.save")
    await flush()
    expect(draftState(o.c)).toBe("conflict")
    expect(o.c.querySelector("[data-server]")).toBeNull()
    expect(button(o.c, "action.refreshCard")?.disabled).toBe(false)
    gate.failing = false
    click(o.c, "action.refreshCard")
    await flush()
    expect(
      slot(o.c, "title").querySelector('[data-server="title"]')?.textContent
    ).toBe("theirs")
    expect(button(o.c, "action.refreshCard")).toBeUndefined()
    expect(input(o.c, "title")?.value).toBe("mine")
    click(o.c, "action.overwrite")
    await flush()
    expect(runs(o).at(-1)!.expectedVersion).toBe(v6)
    expect(draftState(o.c)).toBe("idle")
  })

  it("needsRefresh — «Картка змінилась — оновити» перечитує картку; правки лишаються", async () => {
    const o = await opened()
    type(o.c, "title", "mine")
    expect(button(o.c, "action.refreshCard")).toBeUndefined()
    act(() => {
      o.core.commit(
        (w) => w.markViews(TASK, { needsRefresh: true }),
        o.core.token()
      )
    })
    expect(button(o.c, "action.save")?.disabled).toBe(true)
    click(o.c, "action.refreshCard")
    await flush()
    expect(button(o.c, "action.refreshCard")).toBeUndefined()
    expect(input(o.c, "title")?.value).toBe("mine")
    expect(button(o.c, "action.save")?.disabled).toBe(false)
  })

  it("журнал повний — код data.journal-full біля «Зберегти», правки лишаються; «Повторити» шле знову", async () => {
    const o = await opened()
    seed(o.fake, 2, JOURNAL_MAX + 1)
    type(o.c, "title", "mine")
    // Журнал заповнюють записи інших ключів, що чекають на відповідь.
    o.wire.hold = true
    for (let n = 2; n <= JOURNAL_MAX + 1; n++)
      o.core.update(
        TASK,
        key(n),
        { title: "x" },
        { expectedVersion: o.fake.row(TASK, key(n))!.version }
      )
    const sent = runs(o).length
    click(o.c, "action.save")
    await flush()
    expect(runs(o)).toHaveLength(sent)
    expect(draftState(o.c)).toBe("failed")
    const actions = o.c.querySelector('[data-region="card-actions"]')!
    expect(
      actions
        .querySelector("[data-save-error]")
        ?.getAttribute("data-save-error")
    ).toBe("data.journal-full")
    expect(o.c.querySelector("[data-field-error]")).toBeNull()
    expect(input(o.c, "title")?.value).toBe("mine")
    expect(o.blocks.at(-1)).toBe(true)
    expect(button(o.c, "action.retry")?.disabled).toBe(false)
    // Журнал звільнився: «Повторити» шле ту саму чернетку.
    act(() => o.wire.release())
    await flush()
    click(o.c, "action.retry")
    await flush()
    expect(o.fake.row(TASK, K)!.values).toMatchObject({ title: "mine" })
    expect(draftState(o.c)).toBe("idle")
    expect(o.c.querySelector("[data-save-error]")).toBeNull()
  })
})

describe("useCardDraft — закриття, сховування, несумісний клієнт", () => {
  it("purged скидає чернетку в тому самому кадрі й показує причину", async () => {
    const o = await opened()
    type(o.c, "title", "mine")
    const before = o.frames.length
    const blocked = o.blocks.length
    act(() => o.holder.replace(undefined, "signed-out"))
    // Перший кадр після закриття — без значень чернетки й без блокування.
    expect(o.frames.slice(before).every((f) => !f.includes("mine"))).toBe(true)
    expect(o.blocks[blocked]).toBe(false)
    const security = o.c.querySelector('[data-card="security"]')!
    expect(security.textContent).toBe(text("state.purged"))
    expect(security.getAttribute("data-reason")).toBe("signed-out")
    expect(button(o.c, "action.reloadPage")).toBeDefined()
    // Новий рантайм з тим самим рядком: чернетки вже немає.
    const next = makeRuntime(o.fake, serverTransport(o.fake))
    act(() => o.holder.replace(next.runtime))
    await flush()
    expect(input(o.c, "title")?.value).toBe("t1")
    expect(o.blocks.at(-1)).toBe(false)
  })

  it("removed скидає чернетку: «Рядок недоступний», без значень", async () => {
    const o = await opened()
    type(o.c, "title", "mine")
    const before = o.frames.length
    const blocked = o.blocks.length
    o.fake.remove(TASK, K)
    act(() => {
      o.core.commit(
        (w) =>
          w.apply(TASK, { rows: [], absent: [K] }, o.core.readEpoch(), null),
        o.core.token()
      )
    })
    await flush()
    expect(o.frames.slice(before).every((f) => !f.includes("mine"))).toBe(true)
    expect(o.blocks[blocked]).toBe(false)
    expect(status(o.c)).toBe(text("state.removed"))
    expect(o.c.querySelector("[data-field-slot]")).toBeNull()
    expect(button(o.c, "action.save")).toBeUndefined()
  })

  it("hidden — ні значень рядка, ні чернетки в DOM; «Зберегти» вимкнено; чернетку збережено", async () => {
    const o = await opened()
    type(o.c, "title", "secret-draft")
    act(() => {
      o.core.commit((w) => w.hide(TASK, [K]), o.core.token())
    })
    const html = card(o.c).outerHTML
    for (const secret of ["secret-draft", "t1", "body 1"])
      expect(html).not.toContain(secret)
    expect(o.c.querySelector("[data-field]")).toBeNull()
    expect(status(o.c)).toBe(text("state.hidden"))
    expect(draftState(o.c)).toBe("hidden")
    expect(button(o.c, "action.save")?.disabled).toBe(true)
    // Чернетка жива: навігація блокується, а після перечитування поле знову
    // показує правку.
    expect(o.blocks.at(-1)).toBe(true)
    void o.core.revalidate(TASK, { visibleOnly: false })
    await flush()
    expect(draftState(o.c)).toBe("idle")
    expect(input(o.c, "title")?.value).toBe("secret-draft")
  })

  it("isStale (несумісний клієнт) — «Потрібне оновлення застосунку» замість «Зберегти», ні значень рядка, ні чернетки в DOM", async () => {
    const o = await opened()
    type(o.c, "title", "mine-draft")
    staleKernel(o.fake, task.id)
    act(() => o.core.requestVersion())
    await flush()
    expect(button(o.c, "action.save")).toBeUndefined()
    expect(o.c.querySelector('[data-app="update-required"]')?.textContent).toBe(
      text("app.updateRequired")
    )
    expect(input(o.c, "title")).toBeNull()
    // Клієнт не може перевірити права несумісного об'єкта: значень рядка й
    // чернетки в DOM немає (так само, як у `hidden`).
    const html = card(o.c).outerHTML
    for (const secret of ["mine-draft", "t1", "body 1"])
      expect(html).not.toContain(secret)
  })

  it("застарілий рядок — підказка й «Зберегти» вимкнено, без банера несумісного клієнта", async () => {
    const o = await opened()
    type(o.c, "title", "mine")
    act(() => {
      o.core.commit((w) => w.markStale(TASK, [K], 99), o.core.token())
    })
    expect(status(o.c)).toContain(text("state.stale"))
    expect(button(o.c, "action.save")?.disabled).toBe(true)
    expect(o.c.querySelector('[data-app="update-required"]')).toBeNull()
  })
})

/** A second object with the attributes of `task` and its own table. */
const PROJECT = "Catalog.Project"
const project = catalogEntry({
  id: "00000000-0000-4000-8000-000000000106",
  name: "Project",
  kindLabel: "project",
  table: { schema: "public", name: "project" },
  tabularSections: [],
})

/** The runtime of another subject over its own server: the same key, another title. */
function otherRuntime() {
  const fake = createFakeSource({ objects: OBJECTS, epoch: EPOCH })
  seed(fake, 1, 1)
  // Дві правки: версія B вища за версію A навіть після власного запису A.
  fake.edit(TASK, K, { title: "b-0" })
  fake.edit(TASK, K, { title: "b-title" })
  const wire = serverTransport(fake)
  return { fake, wire, ...makeRuntime(fake, wire) }
}

// Чернетка належить парі (рантайм, рядок): пряма заміна рантайму (інший
// суб'єкт, SSR-знімок) не проходить через `purged`, тож чернетка A інакше
// лягла б на рядок B і пішла б його транспортом.
describe("useCardDraft — заміна рантайму чи рядка скидає чернетку", () => {
  it.each([
    ["видима чернетка", false],
    ["чернетка під hidden", true],
  ])(
    "%s — після holder.replace(B) у DOM немає правки A, поле показує B, запису немає",
    async (_, hide) => {
      const o = await opened()
      type(o.c, "title", "mine")
      if (hide) {
        act(() => {
          o.core.commit((w) => w.hide(TASK, [K]), o.core.token())
        })
      }
      const b = otherRuntime()
      const before = o.frames.length
      const blocked = o.blocks.length
      act(() => o.holder.replace(b.runtime))
      await flush()
      expect(o.frames.slice(before).every((f) => !f.includes("mine"))).toBe(
        true
      )
      expect(o.blocks.slice(blocked).every((dirty) => !dirty)).toBe(true)
      expect(input(o.c, "title")?.value).toBe("b-title")
      expect(draftState(o.c)).toBe("idle")
      expect(button(o.c, "action.save")?.disabled).toBe(true)
      click(o.c, "action.save")
      await flush()
      expect(b.wire.calls.filter((c) => c.request.type === "run")).toEqual([])
    }
  )

  it("пізній settled мутації A після заміни не змінює картку B", async () => {
    const o = await opened()
    type(o.c, "title", "mine")
    o.wire.hold = true
    click(o.c, "action.save")
    await flush()
    expect(draftState(o.c)).toBe("saving")
    const b = otherRuntime()
    const before = o.frames.length
    act(() => o.holder.replace(b.runtime))
    await flush()
    // Спроба A не показується на B ні кадру.
    expect(
      o.frames.slice(before).some((f) => f.includes('data-draft="saving"'))
    ).toBe(false)
    act(() => o.wire.release())
    await flush()
    expect(draftState(o.c)).toBe("idle")
    expect(o.c.querySelector("[data-save-error]")).toBeNull()
    expect(input(o.c, "title")?.value).toBe("b-title")
    // Нова чернетка на B базується на версії B (не A) і йде транспортом B.
    const versionB = b.fake.row(TASK, K)!.version
    expect(versionB).not.toBe(versionOf(o))
    type(o.c, "title", "on-b")
    click(o.c, "action.save")
    await flush()
    const sent = b.wire.calls
      .filter((c) => c.request.type === "run")
      .map((c) => c.request as { operation: { expectedVersion: number } })
    expect(sent.map((r) => r.operation.expectedVersion)).toEqual([versionB])
    expect(b.fake.row(TASK, K)!.values).toMatchObject({ title: "on-b" })
  })

  it("CardHost з іншим id — чернетку скинуто, навігація не блокується", async () => {
    const o = await opened()
    seed(o.fake, 2, 2)
    type(o.c, "title", "mine")
    const before = o.frames.length
    o.reopen(key(2))
    await flush()
    expect(o.frames.slice(before).every((f) => !f.includes("mine"))).toBe(true)
    expect(input(o.c, "title")?.value).toBe("t2")
    expect(o.blocks.at(-1)).toBe(false)
    expect(button(o.c, "action.save")?.disabled).toBe(true)
  })

  it("CardHost з іншим object і тим самим id — чернетку скинуто, запису немає", async () => {
    const o = await opened({ objects: [...OBJECTS, project] })
    o.fake.insert(PROJECT, taskValues(1, { title: "p1" }))
    type(o.c, "title", "mine")
    const before = o.frames.length
    o.reopen(K, PROJECT)
    await flush()
    expect(o.frames.slice(before).every((f) => !f.includes("mine"))).toBe(true)
    expect(card(o.c).getAttribute("data-object")).toBe(PROJECT)
    expect(input(o.c, "title")?.value).toBe("p1")
    expect(o.blocks.at(-1)).toBe(false)
    expect(button(o.c, "action.save")?.disabled).toBe(true)
    click(o.c, "action.save")
    await flush()
    expect(runs(o)).toEqual([])
  })

  it("незакомічений перехід на інший id не чіпає поточної чернетки; закомічений — скидає її", async () => {
    const o = await opened({ suspendOn: key(3) })
    seed(o.fake, 2, 3)
    const v = versionOf(o)
    type(o.c, "title", "mine")
    // Перехід на key(3) не комітиться ніколи: сусід чекає вічно.
    const before = o.frames.length
    await o.navigate(key(3))
    await flush()
    expect(o.frames.length).toBe(before)
    expect(card(o.c).getAttribute("data-key")).toBe(K)
    // Картка K працює далі: правка видна, dirty, «Зберегти» шле з базою K.
    // Після незакоміченого переходу кожен кадр React знову пробує перехід, а
    // той призупиняється: тому дії — в асинхронному `act`.
    await act(async () => {
      fireEvent.change(input(o.c, "title")!, { target: { value: "mine-2" } })
    })
    expect(input(o.c, "title")?.value).toBe("mine-2")
    expect(o.committedBlocks.at(-1)).toBe(true)
    expect(button(o.c, "action.save")?.disabled).toBe(false)
    o.wire.hold = true
    await act(async () => {
      fireEvent.click(button(o.c, "action.save")!)
      await settle()
    })
    expect(runs(o)).toHaveLength(1)
    expect(runs(o)[0]!.values).toEqual({ title: "mine-2" })
    expect(runs(o)[0]!.expectedVersion).toBe(v)
    await act(async () => {
      o.wire.release()
      await settle()
    })
    expect(o.fake.row(TASK, K)!.values).toMatchObject({ title: "mine-2" })
    await act(async () => {
      fireEvent.change(input(o.c, "title")!, { target: { value: "mine-3" } })
    })
    // Закомічений перехід на key(2): чиста чернетка без жодного кадру старої.
    const committed = o.frames.length
    o.reopen(key(2))
    await flush()
    expect(card(o.c).getAttribute("data-key")).toBe(key(2))
    expect(o.frames.slice(committed).every((f) => !f.includes("mine"))).toBe(
      true
    )
    expect(input(o.c, "title")?.value).toBe("t2")
    expect(o.committedBlocks.at(-1)).toBe(false)
    expect(button(o.c, "action.save")?.disabled).toBe(true)
  })

  it("values хука порожні під hidden і після purged", async () => {
    const o = await opened({ probe: true })
    act(() => o.draft.current.setValue("title", "mine"))
    act(() => {
      o.core.commit((w) => w.hide(TASK, [K]), o.core.token())
    })
    expect(o.draft.current.state).toBe("hidden")
    expect(o.draft.current.values).toEqual({})
    act(() => o.holder.replace(undefined, "signed-out"))
    expect(o.draft.current.state).toBe("purged")
    expect(o.draft.current.values).toEqual({})
  })
})
