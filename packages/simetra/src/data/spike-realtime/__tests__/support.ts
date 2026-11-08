import {
  ZERO_UUID,
  channelTopic,
  type SignalErrorKind,
  type SignalTransport,
} from "simetra/model"
import type { CommandOp, CommandResult } from "../commands"
import type { FakeCore, Row, ViewHandle, ViewSnapshot } from "../core"
import type { ReceiverSource } from "../receiver"

/**
 * Обв'язка сценаріїв спайку 3: сервер-джерело правди в пам'яті, керований
 * канал сигналів і записувач кадрів ядра. Сервер шле сигнал рівно так, як
 * ядро команд (§8.2): після «коміту», без даних, з версією рядка.
 */

export const OBJECT = "0b7c6a52-3a7e-4c1e-9f2a-5d1b8e3c9a01"
export const TOPIC = channelTopic({
  kind: "changes",
  scopeKindId: ZERO_UUID,
  scope: ZERO_UUID,
  object: OBJECT,
})

export const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

/** Керований канал: доставка в мікрозадачу, розрив губить повідомлення. */
export class FakeChannel implements SignalTransport {
  private onSignal: ((topic: string, payload: unknown) => void) | undefined
  private onError: ((kind: SignalErrorKind) => void) | undefined
  private readonly subscribed = new Set<() => void>()
  private topics = new Set<string>()
  connected = true
  /** Тримати повідомлення до `release()` (порядок задає тест). */
  hold = false
  readonly held: Array<[string, unknown]> = []
  delivered = 0
  lost = 0

  subscribe(
    channels: readonly string[],
    onSignal: (topic: string, payload: unknown) => void,
    onError: (kind: SignalErrorKind) => void
  ) {
    this.topics = new Set(channels)
    this.onSignal = onSignal
    this.onError = onError
    return () => {
      this.onSignal = undefined
      this.onError = undefined
    }
  }

  onSubscribed(handler: () => void) {
    this.subscribed.add(handler)
    return () => this.subscribed.delete(handler)
  }

  get active() {
    return this.onSignal !== undefined
  }

  publish(topic: string, payload: unknown) {
    if (!this.topics.has(topic)) return
    if (!this.connected) {
      this.lost += 1
      return
    }
    if (this.hold) {
      this.held.push([topic, payload])
      return
    }
    queueMicrotask(() => this.deliver(topic, payload))
  }

  /** Віддати притримані повідомлення в порядку `order` (індекси) чи як є. */
  release(order?: number[]) {
    const batch = order ? order.map((i) => this.held[i]!) : [...this.held]
    this.held.length = 0
    this.hold = false
    for (const [t, p] of batch) this.deliver(t, p)
  }

  deliver(topic: string, payload: unknown) {
    this.delivered += 1
    this.onSignal?.(topic, payload)
  }

  /** Перше приєднання чи повторне після розриву. */
  join() {
    this.connected = true
    for (const h of this.subscribed) h()
  }

  drop() {
    this.connected = false
    this.onError?.("transport")
  }
}

export interface ServerOptions {
  /** `row`: версія з 1 на кожне створення; `sequence`: одна монотонна послідовність. */
  versioning?: "row" | "sequence"
}

/** Джерело правди в пам'яті з RLS-предикатом і сигналом на кожен запис. */
export class FakeServer {
  readonly rows = new Map<string, Row>()
  private seq = 0
  readonly channels: FakeChannel[] = []
  /** Що бачить читач (RLS). */
  visible: (row: Row) => boolean = () => true
  /** Затримка відповіді читання, мс (0 — у мікрозадачу). */
  readDelayMs = 0
  /** Репліка відстає: перші `lagReads` читань ключа віддають попередню версію. */
  lagReads = 0
  private readonly previous = new Map<string, Row>()
  reads: Array<{ kind: "keys" | "subset"; size: number }> = []
  private readonly versioning: "row" | "sequence"

  constructor(options: ServerOptions = {}) {
    this.versioning = options.versioning ?? "row"
  }

  private nextVersion(prev: Row | undefined) {
    if (this.versioning === "sequence") return ++this.seq
    return (prev?.version ?? 0) + 1
  }

  seed(count: number, make: (i: number) => Record<string, unknown>) {
    for (let i = 1; i <= count; i++) {
      const id = uuid(i)
      this.rows.set(id, {
        id,
        version: this.nextVersion(undefined),
        ...make(i),
      })
    }
  }

  private signal(op: string, id: string, version: number) {
    const payload = {
      id: crypto.randomUUID(),
      object: OBJECT,
      op,
      keys: { id },
      row_ver: version,
    }
    for (const c of this.channels) c.publish(TOPIC, payload)
    return payload
  }

  /** Запис «іншого користувача»: коміт і сигнал. */
  write(id: string, values: Record<string, unknown>) {
    const prev = this.rows.get(id)
    if (prev) this.previous.set(id, prev)
    const row: Row = {
      ...(prev ?? { id }),
      ...values,
      id,
      version: this.nextVersion(prev),
    }
    this.rows.set(id, row)
    this.signal(prev ? "update" : "create", id, row.version)
    return row
  }

  remove(id: string) {
    const prev = this.rows.get(id)
    if (!prev) return
    this.rows.delete(id)
    this.signal("delete", id, prev.version)
  }

  /** Команда клієнта: CAS за версією, як ядро команд. */
  run(op: CommandOp): { result: CommandResult; signal?: unknown } {
    const prev = this.rows.get(op.id)
    if (
      prev &&
      op.expectedVersion !== undefined &&
      prev.version !== op.expectedVersion
    )
      return { result: { ok: false, code: "command.conflict" } }
    if (op.action === "delete") {
      if (!prev) return { result: { ok: false, code: "command.conflict" } }
      this.rows.delete(op.id)
      const signal = this.signal("delete", op.id, prev.version)
      return { result: { ok: true, rows: [] }, signal }
    }
    const row: Row = {
      ...(prev ?? { id: op.id }),
      ...op.values,
      id: op.id,
      version: this.nextVersion(prev),
    }
    if (prev) this.previous.set(op.id, prev)
    this.rows.set(op.id, row)
    const signal = this.signal(prev ? "update" : "create", op.id, row.version)
    return { result: { ok: true, rows: [row] }, signal }
  }

  private readRow(id: string): Row | undefined {
    const row = this.rows.get(id)
    if (row && this.lagReads > 0 && this.previous.has(id)) {
      this.lagReads -= 1
      return this.previous.get(id)
    }
    return row && this.visible(row) ? row : undefined
  }

  private wait() {
    return this.readDelayMs > 0
      ? new Promise<void>((r) => setTimeout(r, this.readDelayMs))
      : Promise.resolve()
  }

  /** Джерело для приймача: читання за ключами й підмножиною під RLS. */
  source(page: (rows: Row[]) => Row[] = (rows) => rows): ReceiverSource {
    return {
      readByKeys: async (_object, ids) => {
        this.reads.push({ kind: "keys", size: ids.length })
        await this.wait()
        return ids.flatMap((id) => this.readRow(id) ?? [])
      },
      readSubset: async (spec) => {
        this.reads.push({ kind: "subset", size: 0 })
        await this.wait()
        if (spec.kind === "card")
          return { rows: [this.readRow(spec.id)].flatMap((r) => r ?? []) }
        const all = [...this.rows.values()].filter(
          (r) => this.visible(r) && spec.predicate(r)
        )
        if (spec.kind === "full") return { rows: all }
        const rows = page(all)
        return { rows, keys: rows.map((r) => r.id) }
      },
    }
  }
}

/** Записувач кадрів: знімок кожного виду на кожне повідомлення ядра. */
export function recordFrames(
  core: FakeCore,
  views: Record<string, ViewHandle>
) {
  const frames: Array<Record<string, ViewSnapshot>> = []
  const take = () =>
    frames.push(
      Object.fromEntries(
        Object.entries(views).map(([n, v]) => [n, v.getSnapshot()])
      )
    )
  take()
  core.subscribe(take)
  return {
    frames,
    /** Послідовність показаних значень поля рядка без повторів поспіль. */
    trace(view: string, id: string, field: string) {
      const out: unknown[] = []
      for (const f of frames) {
        const rv = f[view]?.rows.find((r) => r.id === id)
        const v = rv === undefined ? "<absent>" : rv.row[field]
        if (out.length === 0 || out[out.length - 1] !== v) out.push(v)
      }
      return out
    },
    states(view: string, id: string) {
      const out: string[] = []
      for (const f of frames) {
        const rv = f[view]?.rows.find((r) => r.id === id)
        const v = rv?.state ?? "<absent>"
        if (out.length === 0 || out[out.length - 1] !== v) out.push(v)
      }
      return out
    },
    /** Кадр без рядків після кадру з рядками, чи повернення до `loading`. */
    emptyFrames(view: string) {
      let seen = false
      let bad = 0
      for (const f of frames) {
        const s = f[view]
        if (!s) continue
        if (s.rows.length > 0 && s.status === "ready") seen = true
        else if (seen && (s.rows.length === 0 || s.status === "loading"))
          bad += 1
      }
      return bad
    },
    /** Скільки разів змінився порядок чи склад ключів виду. */
    orderChanges(view: string) {
      let prev: string | undefined
      let n = 0
      for (const f of frames) {
        const s = f[view]
        if (!s || s.status !== "ready") continue
        const cur = s.rows.map((r) => r.id).join(",")
        if (prev !== undefined && cur !== prev) n += 1
        prev = cur
      }
      return n
    },
  }
}

/** Дочекатися, поки осядуть мікрозадачі, таймери пачок і перечитування. */
export async function settle(receiver: { idle(): Promise<void> }, rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0))
    await receiver.idle()
  }
}
