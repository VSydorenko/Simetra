import { afterEach, describe, expect, it } from "vitest"
import type { DataWriter } from "../../data-writer"
import { createCore, type CoreSession } from "../core"
import { createCoreSource, createReadLimiter, type ServerPort } from "../source"
import { createFakeSource, type FakeSource } from "../testing/fake-source"
import {
  DEFAULT_CORE_LIMITS,
  type Mutation,
  type MutationResult,
  type RowView,
  type Values,
  type ViewHandle,
  type ViewSnapshot,
} from "../types"
import { OBJECTS, TASK, key, seed, settle } from "./core-support"

/*
 * Контракт чернетки форми шапки (спека П4-B §7.1 «Чернетка форми», §13 рядок
 * B3-4; правило архітекторки 2026-11-17, #227): фейкова форма над
 * `DataWriter` і карткою ядра — так, як її збудує хук форми П4-D. Чернетка
 * живе у формі, не в ядрі: ядро дає підтверджений рядок, стан мутації й
 * `purged`; форма тримає базову версію, ревізії й правки.
 */

const EPOCH = "e".repeat(64)
const K = key(1)

/** The server port: each `run` waits for {@link Port.release}. */
interface Port {
  hold: boolean
  release(): void
}

function harness() {
  const fake = createFakeSource({ objects: OBJECTS, epoch: EPOCH })
  const queue: (() => void)[] = []
  const port: Port = {
    hold: false,
    release() {
      for (const go of queue.splice(0)) go()
    },
  }
  const server: ServerPort = {
    run(request) {
      if (!port.hold) return fake.server.run(request)
      return new Promise((resolve, reject) =>
        queue.push(() => void fake.server.run(request).then(resolve, reject))
      )
    },
    version: () => fake.server.version(),
  }
  const core = createCore({
    subject: "u1",
    source: createCoreSource(
      () => fake.adapter,
      fake.index,
      createReadLimiter(DEFAULT_CORE_LIMITS.readParallel),
      server
    ),
    index: fake.index,
    log: () => {},
  })
  return { fake, core, port }
}

/** One frame of the form: what its fields show and its draft state. */
interface FormFrame {
  readonly shown: Values
  readonly dirty: boolean
  readonly reason?: string
}

/**
 * A fake header form (P4-D) over `DataWriter` and a card view. The draft
 * keeps its base — the row version when the draft started — and the
 * revision of every edited field; the base moves only with an own success
 * or «Перезаписати».
 */
class FakeForm {
  /** The confirmed version the draft is based on; `expectedVersion` of a save. */
  base: number | undefined
  private draft = new Map<string, { value: unknown; revision: number }>()
  private revision = 0
  readonly frames: FormFrame[] = []
  /** The last save outcome the form shows. */
  outcome: "saved" | "conflict" | "failed" | undefined
  private readonly unsubscribe: () => void

  constructor(
    private readonly writer: DataWriter,
    private readonly card: ViewHandle
  ) {
    this.unsubscribe = card.subscribe(() => this.onCard())
  }

  get row(): RowView | undefined {
    return this.card.getSnapshot().rows[0]
  }

  private confirmed(): Values {
    const row = this.row
    return row === undefined || row.state === "removed" ? {} : row.values
  }

  /** The store holds a newer confirmed version than the draft base (#227). */
  get storeAhead(): boolean {
    const row = this.row
    return (
      this.base !== undefined &&
      row !== undefined &&
      row.state !== "removed" &&
      row.version > this.base
    )
  }

  /** What the fields show: the draft over the confirmed row (P4-D). */
  shown(): Values {
    const values: Record<string, unknown> = { ...this.confirmed() }
    for (const [field, { value }] of this.draft) values[field] = value
    return values
  }

  private emit(reason?: string) {
    this.frames.push({
      shown: this.shown(),
      dirty: this.draft.size > 0,
      ...(reason === undefined ? {} : { reason }),
    })
  }

  private onCard() {
    const snapshot: ViewSnapshot = this.card.getSnapshot()
    // `purged` (а `removed` за звуженням — так само) скидає чернетку й
    // показує причину (§9.4).
    if (snapshot.status === "purged" || this.row?.state === "removed") {
      this.reset()
      this.emit(snapshot.reason ?? "removed")
      return
    }
    // Нова версія сховища базу чернетки не переносить (#227): форма лише
    // показує `storeAhead`.
    this.emit()
  }

  private reset() {
    this.draft.clear()
    this.base = undefined
    this.outcome = undefined
  }

  edit(field: string, value: unknown) {
    const row = this.row
    if (this.base === undefined && row !== undefined && row.state !== "removed")
      this.base = row.version
    this.draft.set(field, { value, revision: ++this.revision })
    this.emit()
  }

  /** Saves revision A of the draft with the draft base. */
  async save(): Promise<MutationResult> {
    return this.send(this.base!)
  }

  /** «Перезаписати»: a new `update` with the current server row as the base (Р1). */
  async overwrite(): Promise<MutationResult> {
    const row = this.row
    if (row === undefined || row.state === "removed") throw new Error("no row")
    this.base = row.version
    return this.send(row.version)
  }

  private async send(base: number): Promise<MutationResult> {
    const sent = this.revision
    const values = Object.fromEntries(
      [...this.draft].map(([field, { value }]) => [field, value])
    )
    const mutation: Mutation = this.writer.update(TASK, K, values, {
      expectedVersion: base,
    })
    const result = await mutation.settled
    if (result.ok) {
      // Успіх: скидаються лише поля, не змінені після ревізії A, а база —
      // версія результату; правки ревізії B лишаються.
      for (const [field, { revision }] of [...this.draft]) {
        if (revision <= sent) this.draft.delete(field)
      }
      const row = result.rows[0]
      this.base =
        this.draft.size === 0 ? undefined : (row?.version ?? this.base)
      this.outcome = "saved"
    } else {
      // `conflict` і решта відмов лишають усі правки.
      this.outcome =
        result.error.code === "command.conflict" ? "conflict" : "failed"
    }
    this.emit()
    return result
  }

  /** «Скасувати»: the draft returns to the confirmed row in one frame. */
  cancel() {
    const mutation = this.row?.mutation
    this.reset()
    // Скасування мутації дає один кадр картки, а з ним — і форми; без
    // мутації кадр дає сама форма.
    if (mutation?.cancel !== undefined) mutation.cancel()
    else this.emit()
  }

  dispose() {
    this.unsubscribe()
  }
}

const forms: FakeForm[] = []
afterEach(() => {
  for (const form of forms.splice(0)) form.dispose()
})

async function opened(h: ReturnType<typeof harness>) {
  seed(h.fake, 1, 1)
  const writer: DataWriter = { update: h.core.update }
  const form = new FakeForm(
    writer,
    h.core.view({ kind: "card", object: TASK, key: K })
  )
  forms.push(form)
  await settle()
  return form
}

const versionOf = (form: FakeForm) => {
  const row = form.row!
  if (row.state === "removed") throw new Error("removed")
  return row.version
}

/** A foreign change on the server and the re-read of the card that brings it. */
async function foreignChange(
  fake: FakeSource,
  core: CoreSession,
  form: FakeForm
) {
  fake.edit(TASK, K, { title: "theirs" })
  void core.revalidate(TASK, { visibleOnly: false })
  await settle()
  expect(form.row).toMatchObject({ values: { title: "theirs" } })
}

describe("the draft contract of a header form (§7.1, §13 B3-4)", () => {
  it("an answer to revision A does not overwrite the edits of revision B", async () => {
    const h = harness()
    const form = await opened(h)
    form.edit("title", "A")
    form.edit("notes", "A notes")
    h.port.hold = true
    const saving = form.save()
    await settle()
    // Під час збереження поле показує чернетку (за `await` рядок —
    // підтверджений, стан `pending`).
    expect(form.row).toMatchObject({
      state: "pending",
      values: { title: "t1" },
    })
    form.edit("title", "B")
    expect(form.shown()).toMatchObject({ title: "B" })
    h.port.hold = false
    h.port.release()
    const result = await saving
    expect(result.ok).toBe(true)
    // Поле, не змінене після A, скинуто на підтверджене; правка B лишилась
    // над новою базою — версією результату.
    expect(form.row).toMatchObject({
      state: "synced",
      values: { title: "A" },
    })
    expect(form.shown()).toMatchObject({ title: "B" })
    expect(form.base).toBe(versionOf(form))
    expect(form.frames.at(-1)!.dirty).toBe(true)
    // Наступне збереження шле лише B з базою результату A і проходить.
    const again = await form.save()
    expect(again.ok).toBe(true)
    expect(form.row).toMatchObject({ values: { title: "B" } })
    expect(form.frames.at(-1)!.dirty).toBe(false)
  })

  it("conflict keeps every edit of the draft", async () => {
    const h = harness()
    const form = await opened(h)
    form.edit("title", "mine")
    form.edit("notes", "my notes")
    h.fake.edit(TASK, K, { title: "theirs" })
    const result = await form.save()
    await settle()
    expect(result).toMatchObject({
      ok: false,
      error: { code: "command.conflict" },
    })
    expect(form.outcome).toBe("conflict")
    expect(form.shown()).toMatchObject({ title: "mine", notes: "my notes" })
    // Рядок картки — поточний серверний (перечитано), стан — `conflict`.
    expect(form.row).toMatchObject({
      state: "conflict",
      values: { title: "theirs" },
    })
  })

  it("«Скасувати» returns the draft to the confirmed row in one frame", async () => {
    const h = harness()
    const form = await opened(h)
    form.edit("title", "mine")
    h.fake.edit(TASK, K, { title: "theirs" })
    await form.save()
    await settle()
    expect(form.row!.mutation?.state).toBe("conflict")
    const before = form.frames.length
    form.cancel()
    // Один кадр: чернетки немає, мутації немає, поля — підтверджений рядок.
    expect(form.frames.length).toBe(before + 1)
    expect(form.frames.at(-1)).toEqual({
      shown: form.shown(),
      dirty: false,
    })
    expect(form.shown()).toMatchObject({ title: "theirs" })
    expect(form.row).toMatchObject({ state: "synced" })
    expect(form.row!.mutation).toBeUndefined()
  })

  it("the purged state resets the draft and shows the reason", async () => {
    const h = harness()
    const form = await opened(h)
    form.edit("title", "mine")
    h.core.commit((w) => w.purge(TASK, { keys: [K] }), h.core.token())
    await settle()
    const last = form.frames.at(-1)!
    expect(last.dirty).toBe(false)
    expect(last.reason).toBeDefined()
    expect(form.shown()).toEqual({})
    expect(form.base).toBeUndefined()
  })

  it("#227: a newer store version does not move the draft base; the save is a conflict, not a silent overwrite", async () => {
    const h = harness()
    const form = await opened(h)
    const v5 = versionOf(form)
    form.edit("title", "mine")
    expect(form.base).toBe(v5)
    expect(form.storeAhead).toBe(false)
    // Сховище переходить на v6 перечитуванням під час редагування.
    await foreignChange(h.fake, h.core, form)
    const v6 = versionOf(form)
    expect(v6).toBeGreaterThan(v5)
    expect(form.base).toBe(v5)
    expect(form.storeAhead).toBe(true)
    expect(form.shown()).toMatchObject({ title: "mine" })
    // Збереження зі старою базою — `conflict`; серверне значення ціле.
    const result = await form.save()
    await settle()
    expect(result).toMatchObject({
      ok: false,
      error: { code: "command.conflict" },
    })
    expect(h.fake.row(TASK, K)).toMatchObject({
      version: v6,
      values: { title: "theirs" },
    })
    expect(form.shown()).toMatchObject({ title: "mine" })
    // «Перезаписати» — новий `update` з базою поточного серверного рядка.
    const overwritten = await form.overwrite()
    expect(overwritten.ok).toBe(true)
    expect(h.fake.row(TASK, K)).toMatchObject({ values: { title: "mine" } })
    expect(form.row).toMatchObject({
      state: "synced",
      values: { title: "mine" },
    })
  })
})
