// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { Profiler, createElement } from "react"
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
import {
  OBJECTS,
  ORG,
  TASK,
  key,
  seed,
  settle,
  task,
} from "../../../data/store/__tests__/core-support"
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
      override: { [TASK]: () => adapter(fake), [ORG]: () => adapter(fake) },
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
  const nav: NavigationAdapter = {
    openCard: vi.fn(),
    openList: vi.fn(),
    useBlockWhile: (dirty) => void blocks.push(dirty),
  }
  // Кадр — commit піддерева картки (як у тесті списку): DOM уже змінено.
  const frames: string[] = []
  const box = { current: null as HTMLDivElement | null }
  const draft = { current: undefined as unknown as CardDraft }
  function Probe() {
    const row = useRow({ object: TASK, id: K })
    draft.current = useCardDraft({ object: TASK, id: K, card: row })
    return null
  }
  const view = render(
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
              options.probe === true
                ? createElement(Probe)
                : createElement(CardHost, { object: TASK, id: K })
            )
          )
        )
      )
    )
  )
  await flush()
  const c = view.container
  return { fake, wire, runtime, core, holder, blocks, frames, c, draft }
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

/** An adapter whose reads wait while `gate.held` is set, until `gate.open()`. */
function gated() {
  const waiting: (() => void)[] = []
  const gate = {
    held: false,
    open() {
      gate.held = false
      for (const go of waiting.splice(0)) go()
    },
  }
  const adapter = (fake: FakeSource): SourceAdapter => ({
    capabilities: fake.adapter.capabilities,
    async read(items) {
      if (gate.held) await new Promise<void>((go) => void waiting.push(go))
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
      act(() => {
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
      })
      // Без `flush`: картка сама дочитує застаріле поле, і стан минає.
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
    act(() => {
      o.core.commit(
        (w) =>
          w.apply(TASK, { rows: [row], absent: [] }, o.core.readEpoch(), null),
        o.core.token()
      )
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
      async (_, block) => {
        const o = await opened()
        await reach(o, state, "host")
        await block(o)
        expect(draftState(o.c)).toBe(state)
        expect(enabledWrites(o.c)).toEqual([])
      }
    )

    it.each(BLOCKERS)(
      "%s — overwrite() і retry() хука нічого не шлють",
      async (_, block) => {
        const o = await opened({ probe: true })
        await reach(o, state, "probe")
        await block(o)
        expect(o.draft.current.canSave).toBe(false)
        const sent = runs(o).length
        act(() => {
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
    expect(status(o.c)).toBe(text("state.refreshing"))
    act(() => gate.open())
    await flush()
    expect(
      slot(o.c, "title").querySelector('[data-server="title"]')?.textContent
    ).toBe("theirs")
    expect(status(o.c)).toBe(text("state.conflict"))
    expect(button(o.c, "action.overwrite")?.disabled).toBe(false)
    click(o.c, "action.overwrite")
    await flush()
    expect(runs(o)[1]!.expectedVersion).toBe(v6)
    expect(draftState(o.c)).toBe("idle")
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

  it("isStale (несумісний клієнт) — «Потрібне оновлення застосунку» замість «Зберегти», поля лише для показу", async () => {
    const o = await opened()
    type(o.c, "title", "mine")
    staleKernel(o.fake, task.id)
    act(() => o.core.requestVersion())
    await flush()
    expect(button(o.c, "action.save")).toBeUndefined()
    expect(o.c.querySelector('[data-app="update-required"]')?.textContent).toBe(
      text("app.updateRequired")
    )
    expect(input(o.c, "title")).toBeNull()
    // Чернетку не втрачено: поле показує правку.
    expect(slot(o.c, "title").textContent).toContain("mine")
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
