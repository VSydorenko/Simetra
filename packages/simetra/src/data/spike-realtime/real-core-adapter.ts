import type { Filter } from "simetra/model"
import { matches } from "../store/filter"
import type {
  CoreSession,
  FieldType,
  ObjectName,
  ServerRow,
  ViewHandle,
  ViewSpec,
} from "../store/types"
import type {
  ActiveSubset,
  GenerationToken,
  ReceiverCore,
  Row,
  ServerRows,
  SubsetSpec,
} from "./core"

/**
 * Приймач сигналів над справжнім ядром спайку 1 (`CoreSession` v0).
 *
 * Що ядро дає приймачу прямо: `token()`, `commit` з `Writer` (`patch`,
 * `remove`, `markStale(minVersion)`, `purge`, `markViews`),
 * `confirmedVersion`. Чого не дає — і що тут заповнює реєстр виглядів
 * хоста (`track`), — це вимоги спайку 3 до ядра (звіт, критерій 6):
 *
 * - перелік активних виглядів об'єкта з формою, фільтром, ключами й
 *   видимістю (для перевірки нового ключа предикатом і перечитування видимих
 *   підмножин після `SUBSCRIBED`);
 * - позначки на конкретний вигляд, а не на всі вигляди об'єкта;
 * - зняття `stale` підтвердженням тієї самої версії (перечитування після
 *   розриву повертає рядок без змін — він уже не застарілий).
 */
export interface TrackedView {
  readonly spec: ViewSpec
  readonly handle: ViewHandle
  visible: boolean
}

export function realCoreAdapter(options: {
  session: CoreSession
  /** UUID об'єкта каталогу → ім'я в ядрі й типи полів для обчислювача T0. */
  objects: Readonly<
    Record<
      string,
      { name: ObjectName; fields: Readonly<Record<string, FieldType>> }
    >
  >
}): ReceiverCore & {
  track(spec: ViewSpec, handle: ViewHandle): TrackedView
  untrack(view: TrackedView): void
} {
  const { session } = options
  const views = new Map<number, TrackedView>()
  let nextId = 1
  const nameOf = (uuid: string) => {
    const o = options.objects[uuid]
    if (o === undefined) throw new Error(`unknown object ${uuid}`)
    return o
  }
  const uuidOf = (name: ObjectName) =>
    Object.entries(options.objects).find(([, o]) => o.name === name)?.[0] ??
    name
  const toServer = (row: Row): ServerRow => {
    const { id, version, ...values } = row
    return { key: id, version, values }
  }
  const tokenOf = (t: GenerationToken) =>
    t as unknown as ReturnType<CoreSession["token"]>
  const predicate =
    (uuid: string, where: Filter | undefined) =>
    (row: Row): boolean =>
      matches({ id: "uuid", ...nameOf(uuid).fields }, row, where)

  return {
    get closed() {
      return session.closed
    },
    // Токен ядра сам несе `valid`; приймач передає його назад без змін.
    generation: () => session.token() as unknown as GenerationToken,
    versionOf: (object, id) =>
      session.confirmedVersion(nameOf(object).name, id),

    track(spec, handle) {
      const view: TrackedView = { spec, handle, visible: true }
      views.set(nextId++, view)
      return view
    },
    untrack(view) {
      for (const [id, v] of views) if (v === view) views.delete(id)
    },

    activeSubsets(object) {
      const out: ActiveSubset[] = []
      for (const [viewId, v] of views) {
        const uuid = uuidOf(v.spec.object)
        if (object !== undefined && uuid !== object) continue
        const keys = v.handle.getSnapshot().rows.map((r) => r.key)
        const where = "where" in v.spec ? v.spec.where : undefined
        let spec: SubsetSpec
        if (v.spec.kind === "card")
          spec = { kind: "card", object: uuid, id: v.spec.key }
        else if (v.spec.kind === "full")
          spec = {
            kind: "full",
            object: uuid,
            predicate: predicate(uuid, where),
            compare: () => 0,
          }
        else
          spec = {
            kind: "window",
            object: uuid,
            predicate: predicate(uuid, where),
            keys,
          }
        out.push({ viewId, spec, visible: v.visible, keys })
      }
      return out
    },

    apply(input: ServerRows, token) {
      const { name } = nameOf(input.object)
      return session.commit((w) => {
        w.patch(name, input.rows.map(toServer))
        if (input.absent?.length) w.remove(name, input.absent)
        if (input.subset !== undefined) {
          // Склад сторінки після перечитування: ядро не має «заміни членства
          // без зсуву», тож позначки — на рівні об'єкта (прогалина ядра).
          const view = views.get(input.subset.viewId)
          const shown = new Set(
            view?.handle.getSnapshot().rows.map((r) => r.key)
          )
          const next = input.subset.keys ?? []
          if (next.some((k) => !shown.has(k)))
            w.markViews(name, { hasNewRows: true })
          const got = new Set(next)
          if (
            input.subset.keys !== undefined &&
            [...shown].some((k) => !got.has(k))
          )
            w.markViews(name, { needsRefresh: true })
        }
      }, tokenOf(token))
    },

    flag(viewId, flags, token) {
      const view = views.get(viewId)
      if (view === undefined) return true
      const { hasNewRows, needsRefresh } = flags
      if (!hasNewRows && !needsRefresh) return true
      return session.commit(
        (w) =>
          w.markViews(view.spec.object, {
            ...(hasNewRows ? { hasNewRows } : {}),
            ...(needsRefresh ? { needsRefresh } : {}),
          }),
        tokenOf(token)
      )
    },

    markAllStale(stale, token) {
      if (!stale) return true // див. прогалину «зняття stale» вище
      return session.commit((w) => {
        for (const v of views.values())
          w.markStale(
            v.spec.object,
            v.handle.getSnapshot().rows.map((r) => r.key)
          )
      }, tokenOf(token))
    },

    expectVersion(object, id, version, token) {
      return session.commit(
        (w) => w.markStale(nameOf(object).name, [id], version),
        tokenOf(token)
      )
    },

    purge(predicateFn, token) {
      return session.commit((w) => {
        for (const v of views.values()) {
          const uuid = uuidOf(v.spec.object)
          const keys = v.handle
            .getSnapshot()
            .rows.filter((r) =>
              predicateFn(uuid, {
                id: r.key,
                version: r.version ?? 0,
                ...r.values,
              })
            )
            .map((r) => r.key)
          if (keys.length) w.purge(v.spec.object, keys)
        }
      }, tokenOf(token))
    },
  }
}
