/**
 * Фейк ядра за ескізом інтерфейсу v0 (спайк 3 рушія T4). Не продукт: тут
 * лише те, що потрібно приймачу сигналів і сценаріям оракула. Власник
 * справжнього ядра — спайк 1; після його контрольної точки приймач
 * перемикається на його `CoreSession` через ту саму форму `ReceiverCore`.
 *
 * Вимоги, які приймач ставить ядру, зібрано в `ReceiverCore` нижче, —
 * перелік для звіту (критерій 6).
 */

export type Row = { readonly id: string; readonly version: number } & Readonly<
  Record<string, unknown>
>

/** Стан рядка, який бачить UI (словник спайків) плюс `removed` (пропозиція спайку 3). */
export type RowState =
  "synced" | "pending" | "failed" | "conflict" | "stale" | "removed" | "unknown"

export interface RowView {
  readonly id: string
  /** Показаний рядок: підтверджений ⊕ накладки незавершених змін. */
  readonly row: Row
  readonly state: RowState
  readonly pendingFields: readonly string[]
  /** Підтверджена версія, на якій стоїть показ. */
  readonly version: number
  /** Новіший серверний рядок при `conflict`. */
  readonly serverRow?: Row
}

/** Звідки прийшли рядки: від цього залежить, чи може змінитися позиція. */
export type Origin =
  "load" | "signal" | "resync" | "command" | "user" | "security"

export type SubsetSpec =
  | { kind: "card"; object: string; id: string }
  | {
      kind: "window"
      object: string
      predicate: (row: Row) => boolean
      /** Порядок сторінки дає сервер; ядро рядків вікна не сортує. */
      keys: readonly string[]
    }
  | {
      kind: "full"
      object: string
      predicate: (row: Row) => boolean
      compare: (a: Row, b: Row) => number
    }

export type SubsetStatus = "loading" | "ready" | "refreshing" | "error"

export interface ViewSnapshot {
  readonly status: SubsetStatus
  readonly rows: readonly RowView[]
  readonly hasNewRows: boolean
  readonly needsRefresh: boolean
  /** Дані показано, але вони можуть бути застарілими (розрив зв'язку). */
  readonly stale: boolean
}

export interface ViewHandle {
  readonly id: number
  getSnapshot(): ViewSnapshot
  /** Хук змонтовано й видно (§8.4 «видима підмножина»). */
  setVisible(visible: boolean): void
  /** Явна дія користувача: перебудувати порядок і членство, скинути позначки. */
  showNew(): void
  release(): void
}

/** Покоління: результат старого покоління чи закритої сесії не пишеться. */
export interface GenerationToken {
  readonly epoch: number
  /** Покоління прав: росте з кожною втратою доступу (`purge`). */
  readonly rights: number
}

export interface ServerRows {
  readonly object: string
  /** Рядки, прочитані під RLS. */
  readonly rows: readonly Row[]
  /** Ключі, які перечитали й не отримали: видалено чи невидимо під RLS. */
  readonly absent?: readonly string[]
  readonly origin: Origin
  /** Перечитування цілої підмножини: нове членство (для `window` — порядок ключів). */
  readonly subset?: {
    readonly viewId: number
    readonly keys?: readonly string[]
  }
}

export interface ActiveSubset {
  readonly viewId: number
  readonly spec: SubsetSpec
  readonly visible: boolean
  /** Ключі, що зараз у підмножині. */
  readonly keys: readonly string[]
}

export type TxOutcome =
  | { ok: true; rows: readonly Row[] }
  | { ok: false; kind: "failed" | "conflict"; serverRow?: Row; error: unknown }

/**
 * Що приймач сигналів вимагає від ядра (вимоги спайку 3 до спайку 1).
 */
export interface ReceiverCore {
  readonly closed: boolean
  generation(): GenerationToken
  /** Найбільша бачена підтверджена версія ключа; `undefined` — ключа немає. */
  versionOf(object: string, id: string): number | undefined
  /** Активні підмножини об'єкта з їхньою видимістю і ключами. */
  activeSubsets(object?: string): readonly ActiveSubset[]
  /** Єдина точка запису серверних рядків; `false` — закрито чи старе покоління. */
  apply(input: ServerRows, token: GenerationToken): boolean
  /** Позначки підмножини без зміни рядків. */
  flag(
    viewId: number,
    flags: { hasNewRows?: boolean; needsRefresh?: boolean; stale?: boolean },
    token: GenerationToken
  ): boolean
  /** Розрив зв'язку: усе показане — `stale`, без приховування. */
  markAllStale(stale: boolean, token: GenerationToken): boolean
  /**
   * Сигнал сказав «є версія ≥ v»: ключ `stale`, доки підтверджене її не
   * досягне (репліка, затримка).
   */
  expectVersion(
    object: string,
    id: string,
    version: number,
    token: GenerationToken
  ): boolean
  /** Втрата доступу: прибрати рядки негайно, з видів теж (виняток безпеки). */
  purge(
    predicate: (object: string, row: Row) => boolean,
    token: GenerationToken
  ): boolean
}

interface Overlay {
  readonly txId: number
  readonly object: string
  readonly id: string
  readonly fields: Readonly<Record<string, unknown>>
  state: "pending" | "failed" | "conflict" | "unknown"
  serverRow?: Row
  /** Версія, від якої зроблено зміну (`expectedVersion`). */
  readonly baseVersion: number | undefined
  /** Власне видалення: рядок на місці зі станом `pending` до підтвердження. */
  readonly deleting?: true
  /** Версія результату `run`: накладка знімається, щойно підтверджене її досягло. */
  confirmedAt?: number
}

interface ViewState {
  readonly id: number
  spec: SubsetSpec
  visible: boolean
  status: SubsetStatus
  /** Членство й порядок, як їх бачить UI зараз. */
  order: string[]
  removed: Set<string>
  hasNewRows: boolean
  needsRefresh: boolean
  stale: boolean
  snapshot: ViewSnapshot | undefined
}

const key = (object: string, id: string) => `${object}\u0000${id}`

/** Сесія фейкового ядра. */
export class FakeCore implements ReceiverCore {
  private epoch = 1
  private rights = 1
  private isClosed = false
  private readonly confirmed = new Map<string, Row>()
  private readonly maxVersion = new Map<string, number>()
  private readonly tombstones = new Map<string, Row>()
  private readonly expected = new Map<string, number>()
  private readonly overlays: Overlay[] = []
  private readonly views = new Map<number, ViewState>()
  private readonly listeners = new Set<() => void>()
  private nextView = 1
  private nextTx = 1
  private notifyScheduled = false
  private allStale = false
  /** Скільки разів ядро повідомило слухачів (пачки за мікрозадачу). */
  notifications = 0

  get closed() {
    return this.isClosed
  }

  generation(): GenerationToken {
    return { epoch: this.epoch, rights: this.rights }
  }

  private stale_(token: GenerationToken): boolean {
    return (
      this.isClosed ||
      token.epoch !== this.epoch ||
      token.rights !== this.rights
    )
  }

  dispose(): void {
    if (this.isClosed) return
    this.isClosed = true
    this.epoch += 1
    this.confirmed.clear()
    this.maxVersion.clear()
    this.overlays.length = 0
    this.views.clear()
    this.listeners.clear()
  }

  subscribe(listener: () => void): () => void {
    if (this.isClosed) return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  versionOf(object: string, id: string): number | undefined {
    return this.maxVersion.get(key(object, id))
  }

  confirmedRow(object: string, id: string): Row | undefined {
    return this.confirmed.get(key(object, id))
  }

  view(spec: SubsetSpec): ViewHandle {
    if (this.isClosed) throw new Error("core closed")
    const id = this.nextView++
    const state: ViewState = {
      id,
      spec,
      visible: true,
      status: "loading",
      order: [],
      removed: new Set(),
      hasNewRows: false,
      needsRefresh: false,
      stale: this.allStale,
      snapshot: undefined,
    }
    this.views.set(id, state)
    if (spec.kind === "card") state.order = [spec.id]
    if (spec.kind === "window") state.order = [...spec.keys]
    if (spec.kind === "full") state.order = this.fullMembers(spec)
    if (state.order.every((k) => this.confirmed.has(key(spec.object, k))))
      if (state.order.length > 0) state.status = "ready"
    return {
      id,
      getSnapshot: () => this.snapshotOf(state),
      setVisible: (visible) => {
        if (state.visible === visible) return
        state.visible = visible
      },
      showNew: () => {
        if (!this.views.has(id)) return
        this.rebuild(state)
        this.touch(state)
      },
      release: () => {
        this.views.delete(id)
      },
    }
  }

  activeSubsets(object?: string): readonly ActiveSubset[] {
    return [...this.views.values()]
      .filter((v) => object === undefined || v.spec.object === object)
      .map((v) => ({
        viewId: v.id,
        spec: v.spec,
        visible: v.visible,
        keys: [...v.order],
      }))
  }

  apply(input: ServerRows, token: GenerationToken): boolean {
    if (this.stale_(token)) return false
    const touched = new Set<string>()
    for (const row of input.rows) {
      const k = key(input.object, row.id)
      const seen = this.maxVersion.get(k)
      // Версія не зменшується (Рд24): старий результат не перемагає новіший.
      if (seen !== undefined && row.version < seen) continue
      const prev = this.confirmed.get(k)
      this.maxVersion.set(k, row.version)
      if (prev !== undefined && prev.version === row.version) continue
      this.confirmed.set(k, row)
      this.tombstones.delete(k)
      const want = this.expected.get(k)
      if (want !== undefined && row.version >= want) this.expected.delete(k)
      touched.add(row.id)
      this.settleOverlays(input.object, row)
    }
    for (const id of input.absent ?? []) {
      const k = key(input.object, id)
      const gone = this.confirmed.get(k)
      if (gone === undefined) continue
      this.confirmed.delete(k)
      // Останній показаний рядок лишається для стану `removed` на місці.
      this.tombstones.set(k, gone)
      touched.add(id)
      // Видалений рядок з незавершеною зміною: зміну не прибирають мовчки.
      // Власне видалення в польоті — не відмова: його ехо прийшло раніше відповіді.
      for (const o of this.overlays)
        if (
          o.object === input.object &&
          o.id === id &&
          o.state === "pending" &&
          !o.deleting
        )
          o.state = "failed"
    }
    for (const view of this.views.values()) {
      if (view.spec.object !== input.object) continue
      let changed = false
      if (input.subset?.viewId === view.id) {
        if (view.needsRefresh || view.stale) {
          view.needsRefresh = false
          view.stale = false
          changed = true
        }
        changed = this.replaceMembership(view, input) || changed
        if (view.status !== "ready") {
          view.status = "ready"
          changed = true
        }
      }
      for (const id of touched)
        changed = this.place(view, id, input.origin) || changed
      if (view.status === "loading" && this.allPresent(view)) {
        view.status = "ready"
        changed = true
      }
      if (changed) this.touch(view)
    }
    return true
  }

  flag(
    viewId: number,
    flags: { hasNewRows?: boolean; needsRefresh?: boolean; stale?: boolean },
    token: GenerationToken
  ): boolean {
    if (this.stale_(token)) return false
    const view = this.views.get(viewId)
    if (view === undefined) return true
    let changed = false
    for (const name of ["hasNewRows", "needsRefresh", "stale"] as const) {
      const value = flags[name]
      if (value !== undefined && view[name] !== value) {
        view[name] = value
        changed = true
      }
    }
    if (changed) this.touch(view)
    return true
  }

  markAllStale(stale: boolean, token: GenerationToken): boolean {
    if (this.stale_(token)) return false
    this.allStale = stale
    for (const view of this.views.values())
      if (view.stale !== stale) {
        view.stale = stale
        this.touch(view)
      }
    return true
  }

  expectVersion(
    object: string,
    id: string,
    version: number,
    token: GenerationToken
  ): boolean {
    if (this.stale_(token)) return false
    const k = key(object, id)
    if ((this.maxVersion.get(k) ?? -1) >= version) return true
    if ((this.expected.get(k) ?? -1) >= version) return true
    this.expected.set(k, version)
    this.touchKey(object, id)
    return true
  }

  purge(
    predicate: (object: string, row: Row) => boolean,
    token: GenerationToken
  ): boolean {
    if (this.stale_(token)) return false
    // Нове покоління прав: перечитування, почате до втрати доступу, уже не
    // запише заборонених рядків назад.
    this.rights += 1
    const gone = new Map<string, Set<string>>()
    for (const [k, row] of [...this.confirmed, ...this.tombstones]) {
      const object = k.slice(0, k.indexOf("\u0000"))
      if (!predicate(object, row)) continue
      this.confirmed.delete(k)
      this.tombstones.delete(k)
      this.maxVersion.delete(k)
      this.expected.delete(k)
      let set = gone.get(object)
      if (set === undefined) gone.set(object, (set = new Set()))
      set.add(row.id)
    }
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      const o = this.overlays[i] as Overlay
      if (gone.get(o.object)?.has(o.id)) this.overlays.splice(i, 1)
    }
    for (const view of this.views.values()) {
      const set = gone.get(view.spec.object)
      if (set === undefined) continue
      const before = view.order.length
      view.order = view.order.filter((id) => !set.has(id))
      for (const id of set) view.removed.delete(id)
      if (view.order.length !== before) this.touch(view)
    }
    return true
  }

  /** Результат команди невідомий: позначка на місці, доки перечитування не розв'яже. */
  markUnknown(txId: number): void {
    const o = this.overlays.find((x) => x.txId === txId)
    if (o === undefined || o.state !== "pending") return
    o.state = "unknown"
    this.touchKey(o.object, o.id)
  }

  /** Почати зміну (v0 `begin`): накладка видна одразу, `commit` шле команду. */
  begin(
    object: string,
    id: string,
    fields: Record<string, unknown>,
    options: { delete?: true } = {}
  ) {
    if (this.isClosed) throw new Error("core closed")
    const overlay: Overlay = {
      txId: this.nextTx++,
      object,
      id,
      fields,
      state: "pending",
      baseVersion: this.versionOf(object, id),
      ...(options.delete ? { deleting: true as const } : {}),
    }
    this.overlays.push(overlay)
    this.touchKey(object, id)
    const token = this.generation()
    return {
      txId: overlay.txId,
      baseVersion: overlay.baseVersion,
      /** Результат команди; після закриття сесії нічого не пише. */
      settle: (outcome: TxOutcome): boolean => {
        if (this.isClosed || token.epoch !== this.epoch) return false
        // Рядок міг піти разом із доступом: тоді писати нічого.
        if (!this.overlays.includes(overlay)) return false
        const now_ = this.generation()
        if (outcome.ok && overlay.deleting) {
          this.dropOverlay(overlay)
          this.apply(
            { object, rows: [], absent: [id], origin: "command" },
            now_
          )
          // Ехо видалення могло лишити рядок `removed`: власне підтверджене — прибрати.
          for (const view of this.views.values())
            if (view.spec.object === object && view.removed.has(id)) {
              view.order = view.order.filter((x) => x !== id)
              view.removed.delete(id)
              this.touch(view)
            }
        } else if (outcome.ok) {
          const mine = outcome.rows.find((r) => r.id === id)
          overlay.confirmedAt = mine?.version
          this.apply({ object, rows: outcome.rows, origin: "command" }, now_)
          // Ехо могло прийти раніше відповіді: тоді підтверджене вже новіше.
          const now = this.versionOf(object, id)
          if (mine === undefined || (now !== undefined && now >= mine.version))
            this.dropOverlay(overlay)
        } else {
          overlay.state = outcome.kind
          if (outcome.serverRow !== undefined)
            overlay.serverRow = outcome.serverRow
        }
        this.touchKey(object, id)
        return true
      },
    }
  }

  /** Явна дія користувача «скасувати» над `failed` чи `conflict`. */
  cancel(txId: number): void {
    const o = this.overlays.find((x) => x.txId === txId)
    if (o === undefined) return
    this.dropOverlay(o)
    this.touchKey(o.object, o.id)
  }

  // --- внутрішнє ---

  private settleOverlays(object: string, row: Row) {
    for (const o of [...this.overlays]) {
      if (o.object !== object || o.id !== row.id) continue
      if (o.confirmedAt !== undefined && row.version >= o.confirmedAt)
        this.dropOverlay(o)
      // Резервний шлях для `unknown` (відповідь `run` втрачено): сигнал і
      // перечитування принесли новішу версію з нашими значеннями — зміна
      // дійшла. Евристика без ключа ідемпотентності (див. звіт).
      else if (
        o.state === "unknown" &&
        row.version > (o.baseVersion ?? 0) &&
        Object.entries(o.fields).every(([f, v]) => row[f] === v)
      )
        this.dropOverlay(o)
    }
  }

  private dropOverlay(o: Overlay) {
    const i = this.overlays.indexOf(o)
    if (i >= 0) this.overlays.splice(i, 1)
  }

  private fullMembers(spec: Extract<SubsetSpec, { kind: "full" }>): string[] {
    const rows: Row[] = []
    for (const [k, row] of this.confirmed)
      if (k.startsWith(`${spec.object}\u0000`) && spec.predicate(row))
        rows.push(row)
    return rows.sort(spec.compare).map((r) => r.id)
  }

  private allPresent(view: ViewState): boolean {
    return view.order.every(
      (id) =>
        view.removed.has(id) || this.confirmed.has(key(view.spec.object, id))
    )
  }

  /** Повна заміна членства з перечитаної підмножини — одним кроком, без порожнього кадру. */
  private replaceMembership(view: ViewState, input: ServerRows): boolean {
    const spec = view.spec
    let next: string[]
    if (spec.kind === "card") next = [spec.id]
    else if (spec.kind === "window")
      next = [...(input.subset?.keys ?? spec.keys)]
    else next = this.fullMembers(spec)
    if (spec.kind === "window") view.spec = { ...spec, keys: next }
    const before = view.order.join(",")
    // Перечитування за дією системи (resync) не переставляє видимого списку:
    // зміну членства показує позначка, перебудову робить користувач. Рядок,
    // що випав зі сторінки, але живий (дочитаний за ключем), — на місці з
    // `needsRefresh`; рядок, якого немає взагалі, позначає `absent` як `removed`.
    if (input.origin === "resync" && view.status === "ready") {
      const known = new Set(view.order)
      if (next.some((id) => !known.has(id))) view.hasNewRows = true
      const stay = new Set(next)
      if (view.order.some((id) => !stay.has(id))) view.needsRefresh = true
      return true
    }
    view.order = next
    view.removed.clear()
    return before !== next.join(",")
  }

  /** Як рядок `id` лягає у вид після зміни; позиції не змінює ні сигнал, ні resync. */
  private place(view: ViewState, id: string, origin: Origin): boolean {
    const spec = view.spec
    const row = this.confirmed.get(key(spec.object, id))
    const member = view.order.includes(id)
    const free = origin === "load" || origin === "user"
    if (spec.kind === "card") {
      if (spec.id !== id) return false
      if (row === undefined) view.removed.add(id)
      else view.removed.delete(id)
      return true
    }
    if (member) {
      if (row === undefined) {
        // Власне підтверджене видалення прибирає рядок; чуже — лишає на місці
        // зі станом `removed` до дії користувача (рішення архітекторки 08.11).
        if (free || origin === "command") {
          view.order = view.order.filter((x) => x !== id)
          view.removed.delete(id)
        } else view.removed.add(id)
        return true
      }
      view.removed.delete(id)
      // Вихід із фільтра чи зміна поля сортування: рядок на місці, список
      // отримує `needsRefresh`, склад змінює лише користувач.
      if (!free && !spec.predicate(row)) view.needsRefresh = true
      if (spec.kind === "full" && !free) {
        const ids = view.order
        const i = ids.indexOf(id)
        const near = (j: number) =>
          this.confirmed.get(key(spec.object, ids[j] ?? ""))
        const prev = near(i - 1)
        const next = near(i + 1)
        if (
          (prev && spec.compare(prev, row) > 0) ||
          (next && spec.compare(row, next) > 0)
        )
          view.needsRefresh = true
      }
      return true
    }
    if (row !== undefined && spec.predicate(row)) {
      if (spec.kind === "full" && free) {
        view.order = this.fullMembers(spec)
        return true
      }
      // Нова позиція невідома (window) чи вставка зсунула б рядки (full) —
      // лише позначка, без стрибка.
      if (!view.hasNewRows) {
        view.hasNewRows = true
        return true
      }
    }
    return false
  }

  private rebuild(view: ViewState) {
    const spec = view.spec
    if (spec.kind === "full") view.order = this.fullMembers(spec)
    else if (spec.kind === "window")
      view.order = view.order.filter((id) => !view.removed.has(id))
    view.removed.clear()
    view.hasNewRows = false
  }

  private rowView(
    object: string,
    id: string,
    removed: boolean
  ): RowView | undefined {
    const base =
      this.confirmed.get(key(object, id)) ??
      this.tombstones.get(key(object, id))
    const mine = this.overlays.filter((o) => o.object === object && o.id === id)
    if (base === undefined && mine.length === 0) return undefined
    let row: Row = base ?? ({ id, version: 0 } as Row)
    const pendingFields = new Set<string>()
    let state: RowState = removed ? "removed" : "synced"
    let serverRow: Row | undefined
    for (const o of mine) {
      row = { ...row, ...o.fields }
      for (const f of Object.keys(o.fields)) pendingFields.add(f)
      if (o.state === "conflict") {
        state = "conflict"
        serverRow = o.serverRow ?? base
      } else if (o.state === "failed" && state !== "conflict") state = "failed"
      else if (
        o.state === "unknown" &&
        state !== "conflict" &&
        state !== "failed"
      )
        state = "unknown"
      else if (state === "synced" || (o.deleting && state === "removed"))
        state = "pending"
    }
    const want = this.expected.get(key(object, id))
    const behind = want !== undefined && (base?.version ?? 0) < want
    if (state === "synced" && (this.allStale || behind)) state = "stale"
    return {
      id,
      row,
      state,
      pendingFields: [...pendingFields],
      version: base?.version ?? 0,
      ...(serverRow !== undefined ? { serverRow } : {}),
    }
  }

  private snapshotOf(view: ViewState): ViewSnapshot {
    if (view.snapshot !== undefined) return view.snapshot
    const rows: RowView[] = []
    for (const id of view.order) {
      const rv = this.rowView(view.spec.object, id, view.removed.has(id))
      if (rv !== undefined) rows.push(rv)
    }
    const snapshot: ViewSnapshot = {
      status: view.status,
      rows,
      hasNewRows: view.hasNewRows,
      needsRefresh: view.needsRefresh,
      stale: view.stale,
    }
    view.snapshot = snapshot
    return snapshot
  }

  private touchKey(object: string, id: string) {
    for (const view of this.views.values())
      if (view.spec.object === object && view.order.includes(id))
        this.touch(view)
  }

  private touch(view: ViewState) {
    view.snapshot = undefined
    if (this.notifyScheduled) return
    this.notifyScheduled = true
    queueMicrotask(() => {
      this.notifyScheduled = false
      if (this.isClosed) return
      this.notifications += 1
      for (const l of this.listeners) l()
    })
  }
}
