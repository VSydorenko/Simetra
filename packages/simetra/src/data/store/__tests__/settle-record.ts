import { coreInternals } from "../core"
import type { Subset } from "../subsets"
import { requirementOf } from "../sync/target-state"
import type { Key, ViewHandle } from "../types"
import { TASK, type CoreHarness } from "./core-support"

/*
 * Запис ефектів осідання для характеристичного тесту `main`
 * (`settle-sites-main.test.ts`, план SK-2, задача 2). Бачить лише шви, які
 * міграція точок лишає: записи сховищ (`ops`), кінець області запису
 * (`afterCommit` реєстру), сповіщення підписників, зняття оренди, події
 * `watchAttempts` і `watchReads`, зміни полів виглядів і позначок рядків між
 * двома подіями. Функції, які міграція переносить (`settle`, `confirm`,
 * `settleRequirement`), не підміняються: тест не мусить червоніти від
 * легітимної зміни місця виклику.
 *
 * Що не записується (і чому): `s.dirty` — його читає лише `afterCommit` після
 * області запису, порядок усередині області не поведінка; числові значення
 * часу й епох — лише «задано» (вони залежать від годинника прогону);
 * однакове присвоєння не міняє значення й не є подією.
 */

const NUMBER_SET = (value: unknown) => (value === undefined ? "-" : "set")

/** Поля вигляду, чий порядок відносно подій записується. */
function fieldsOf(s: Subset): Record<string, string> {
  return {
    status: s.status,
    error:
      s.error === undefined ? "-" : String((s.error as { code?: string }).code),
    loaded: String(s.loaded),
    refreshedAt: NUMBER_SET(s.targetState.refreshedAt),
    okReadEpoch: NUMBER_SET(s.targetState.okReadEpoch),
    failures: String(s.targetState.failures),
    failedAt: NUMBER_SET(s.targetState.failedAt),
    needsRefresh: String(s.needsRefresh),
    hasNewRows: String(s.hasNewRows),
    answerRejected: String(s.answerRejected),
    unconfirmedSince: NUMBER_SET(
      requirementOf(s.targetState, "composition-unconfirmed")?.since
    ),
    paging: [...s.paging.keys()].sort().join("+") || "-",
    retryAt: NUMBER_SET(s.targetState.retryAt),
    flight: NUMBER_SET(s.targetState.flight),
    rereadEpochs: String(s.targetState.rereadEpochs.length),
    rereadWaiters: String(s.targetState.rereadWaiters.length),
    waiters: String(s.waiters.length),
    alive: String(s.alive),
    purged: String(s.purged),
    trailing:
      s.targetState.trailing === undefined
        ? "-"
        : s.targetState.trailing.reason,
  }
}

export interface Recorder {
  /** Усі події від початку запису (або від останнього `mark`). */
  readonly log: string[]
  /** Підписка вигляду; сповіщення підписника — подія журналу. */
  watch(handle: ViewHandle, name: string): { unsubscribe: () => void }
  /** Власна подія сценарію (дія, що пускає шлях). */
  note(event: string): void
  /** Забирає зміни, що лишились між подіями, і повертає журнал. */
  done(): string[]
  /** Скидає журнал: далі — лише ефекти шляху, а не підготовки. */
  mark(): void
  /** Строк об'єкта, відкладений осіданням (відкинута відповідь), як подія. */
  due(): void
}

/**
 * Починає запис на готовому ядрі. Підготовку сценарію роблять до виклику
 * (або викликають `mark()`), тож у журнал потрапляє лише осідання.
 */
export function record(h: CoreHarness): Recorder {
  const internals = coreInternals(h.core)
  const log: string[] = []
  const tags = new Map<Subset, string>()
  const last = new Map<string, string>()
  const rowLast = new Map<string, string>()
  let logged = h.log.length

  const tagOf = (s: Subset) => {
    let tag = tags.get(s)
    if (tag === undefined) {
      tag = s.form.spec.kind
      let n = 1
      while ([...tags.values()].includes(tag)) tag = `${s.form.spec.kind}${++n}`
      tags.set(s, tag)
    }
    return tag
  }

  const rowSummary = (key: Key): string => {
    const e = internals.objects.get(TASK)?.rows.get(key)
    if (e === undefined) return "-"
    const marks = [
      e.removed === undefined
        ? ""
        : e.removed.divergent
          ? "removed!"
          : "removed",
      e.stale.hidden === undefined ? "" : "hidden",
      e.stale.minVersion === undefined ? "" : `min${e.stale.minVersion.v}`,
      e.stale.epoch === undefined ? "" : "epoch",
    ].filter((m) => m !== "")
    return marks.length === 0 ? "present" : marks.join(",")
  }
  const KEYS: readonly Key[] = Array.from(
    { length: 6 },
    (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`
  )

  const flushChanges = () => {
    const changes: string[] = []
    for (const s of internals.registry.subsets()) {
      const tag = tagOf(s)
      for (const [field, value] of Object.entries(fieldsOf(s))) {
        const id = `${tag}.${field}`
        const before = last.get(id)
        last.set(id, value)
        if (before !== undefined && before !== value)
          changes.push(`${id}=${value}`)
      }
    }
    for (const key of KEYS) {
      const id = `row${KEYS.indexOf(key) + 1}`
      const value = rowSummary(key)
      const before = rowLast.get(id)
      rowLast.set(id, value)
      if (before !== undefined && before !== value)
        changes.push(`${id}=${value}`)
    }
    if (changes.length > 0) log.push(`~ ${changes.sort().join(" ")}`)
    for (; logged < h.log.length; logged++) {
      const entry = h.log[logged]!
      log.push(
        `log ${entry.kind}${"what" in entry ? ` ${String((entry as { what?: unknown }).what)}` : ""}`
      )
    }
  }
  // Початковий знімок: те, що було до запису, зміною не є.
  const baseline = () => {
    for (const s of internals.registry.subsets()) {
      const tag = tagOf(s)
      for (const [field, value] of Object.entries(fieldsOf(s)))
        last.set(`${tag}.${field}`, value)
    }
    KEYS.forEach((key, i) => rowLast.set(`row${i + 1}`, rowSummary(key)))
    logged = h.log.length
  }
  baseline()

  const emit = (event: string) => {
    flushChanges()
    // Серія однакових записів сховища (рядок за рядком) — одна подія з
    // кратністю: порядок рядків усередині серії не поведінка осідання.
    const previous = log.at(-1)
    if (event.startsWith("ops.") && previous !== undefined) {
      const [name] = previous.split("×")
      if (name === event) {
        const n = Number(previous.split("×")[1] ?? 1) + 1
        log[log.length - 1] = `${event}×${n}`
        return
      }
    }
    log.push(event)
  }

  const ops = internals.ops as unknown as Record<
    string,
    (...a: never[]) => unknown
  >
  for (const name of [
    "put",
    "remove",
    "own",
    "disown",
    "putSection",
    "clearOwner",
    "sweep",
  ]) {
    const original = ops[name]!.bind(ops)
    ops[name] = (...args: never[]) => {
      emit(`ops.${name}`)
      return original(...args)
    }
  }
  const registry = internals.registry as unknown as {
    afterCommit: (closing: boolean) => Subset[]
  }
  const afterCommit = registry.afterCommit.bind(registry)
  registry.afterCommit = (closing) => {
    emit(closing ? "flush(closing)" : "flush")
    return afterCommit(closing)
  }
  const source = internals.source as unknown as {
    lease: () => { issue: (o: never) => void; release: () => void }
  }
  const lease = source.lease.bind(source)
  source.lease = () => {
    const held = lease()
    const release = held.release.bind(held)
    held.release = () => {
      emit("lease.release")
      release()
    }
    return held
  }
  const inspect = h.inspect
  inspect.watchAttempts((event) => {
    emit(
      event.phase === "started"
        ? `attempt.start ${event.kind} ${event.site}`
        : `attempt.settled ${event.kind} ${event.outcome}${event.error === undefined ? "" : ` (${event.error})`}`
    )
  })
  inspect.watchReads((event) => {
    emit(
      `read ${event.target.kind} ${event.site}${event.reason === "requirement" ? `/${event.requirement}` : `/${event.reason}`}`
    )
  })

  return {
    log,
    watch(handle, name) {
      const unsubscribe = handle.subscribe(() => emit(`notify ${name}`))
      return { unsubscribe }
    },
    note: emit,
    done() {
      flushChanges()
      return log
    },
    mark() {
      flushChanges()
      log.length = 0
    },
    due() {
      const due = [...inspect.scheduledDue()].map(([object]) => object)
      emit(`scheduled ${due.length === 0 ? "-" : due.join(",")}`)
    },
  }
}
