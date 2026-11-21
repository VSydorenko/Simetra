import {
  ZERO_UUID,
  channelTopic,
  type CatalogEntry,
  type CatalogIndex,
  type SignalError,
  type SignalTransport,
  type Unsubscribe,
} from "simetra/model"
import { visibleRow } from "./object-store"
import { canSubscribe } from "./rights"
import type { RightsState } from "./types"
import { activeViews, type WriterContext } from "./writer"

/*
 * Приймач сигналів (спека П4-B §8.4): модуль ядра, не рантайму. Тут —
 * життєвий цикл і підписки: які канали змін тримати, виходячи зі знімка прав
 * і активних виглядів. Розбір сигналів і перечитування — наступні задачі.
 */

/** What the receiver needs from the core. */
export interface ReceiverContext {
  /** The transport of the runtime's subject; the runtime owns and closes it. */
  readonly transport: SignalTransport
  readonly index: CatalogIndex
  readonly writer: WriterContext
  rights(): RightsState | undefined
}

export interface Receiver {
  /** The set of active views or the rows they show may have changed. */
  touch(): void
  /** A rights snapshot (the first one too) replaced the current one. */
  snapshotReplaced(): void
  /** Drops every subscription; the receiver sees nothing afterwards. */
  stop(): void
}

// Підписка каналу: `off` з'являється після повернення `subscribe`, а відмова
// `auth` може прийти раніше (фейк кличе її синхронно, справжній транспорт —
// пізніше), тож приймач не залежить від порядку.
interface Held {
  off: Unsubscribe | undefined
}

export function createReceiver(ctx: ReceiverContext): Receiver {
  const { transport, writer } = ctx
  const entries = [...ctx.index.byId.values()].filter((e) => e.signal)
  const catalog = { objects: entries }
  const held = new Map<string, Held>()
  // Канал, відхилений `auth`, не повторюється до наступної заміни знімка.
  const refused = new Set<string>()
  let stopped = false
  let planned = false

  const scopesOfRows = (entry: CatalogEntry): string[] => {
    const o = writer.objectOf(`${entry.kind}.${entry.name}`)
    const scopes = new Set<string>()
    for (const view of activeViews(writer, o.name)) {
      for (const key of view.keys) {
        const row = o.rows.get(key)
        const values = row === undefined ? undefined : visibleRow(row)
        if (row?.scope != null && values !== undefined) scopes.add(row.scope)
      }
    }
    return [...scopes]
  }

  // Канали за знімком прав (§8.4): скоупи `scopeSets` виду об'єкта, нескоуплений
  // — `ZERO_UUID`; скоуплений `publicRead` — ще скоупи рядків активних
  // виглядів. Кожен канал — через `canSubscribe`, дзеркало SQL.
  const wanted = (): Set<string> => {
    const channels = new Set<string>()
    const state = ctx.rights()
    if (state === undefined) return channels
    const { snapshot } = state
    const withViews = new Set<CatalogEntry>()
    for (const s of writer.registry.subsets())
      if (s.alive && !s.purged) withViews.add(s.form.object.entry)
    for (const entry of entries) {
      if (!withViews.has(entry)) continue
      const kind = entry.scopeKindId
      const scopes = new Set<string>(
        kind === undefined
          ? [ZERO_UUID]
          : snapshot.scopeSets
              .filter((s) => s.scopeKind === kind)
              .map((s) => s.scope)
      )
      if (kind !== undefined && entry.publicRead !== undefined)
        for (const scope of scopesOfRows(entry)) scopes.add(scope)
      for (const scope of scopes) {
        const channel = channelTopic({
          kind: "changes",
          scopeKindId: kind ?? ZERO_UUID,
          scope,
          object: entry.id,
        })
        if (canSubscribe(snapshot, channel, catalog)) channels.add(channel)
      }
    }
    return channels
  }

  const onError = (error: SignalError) => {
    if (stopped || error.kind !== "auth" || error.channel === undefined) return
    const slot = held.get(error.channel)
    if (slot === undefined) return
    held.delete(error.channel)
    refused.add(error.channel)
    slot.off?.()
  }

  // Сигнали обробляє наступна задача; тут канал лише тримається.
  const onSignal = () => {}

  const join = (channel: string) => {
    const slot: Held = { off: undefined }
    held.set(channel, slot)
    const off = transport.subscribe([channel], onSignal, onError)
    if (held.get(channel) === slot) slot.off = off
    else off()
  }

  const sync = () => {
    planned = false
    if (stopped || !writer.session.token().valid) return
    const next = wanted()
    for (const [channel, slot] of [...held]) {
      if (next.has(channel)) continue
      held.delete(channel)
      slot.off?.()
    }
    for (const channel of next)
      if (!held.has(channel) && !refused.has(channel)) join(channel)
  }

  const touch = () => {
    if (stopped || planned) return
    planned = true
    queueMicrotask(sync)
  }

  return {
    touch,
    snapshotReplaced() {
      refused.clear()
      touch()
    },
    stop() {
      stopped = true
      for (const slot of held.values()) slot.off?.()
      held.clear()
    },
  }
}
