import type { Defects } from "./defects"

/*
 * Планувальник свіжості ядра (спека П4-B §6.7, §8.4): один таймер на ядро.
 * Строк планувальника — найраніший строк цілей; таймер спрацьовує, коли
 * вкладка видима, і кличе такт. Що є ціллю і яким є строк, знає ядро
 * (`dueAt`): планувальник не пише другого правила строку.
 */

/** The hooks a scheduler needs from its core. */
export interface SchedulerContext {
  /** The monotonic clock of the core. */
  readonly now: () => number
  /** Whether the host shows the application. */
  readonly visible: () => boolean
  /** Whether the session is closed or closing: nothing is planned or fired. */
  readonly closed: () => boolean
  /** The earliest due time of the targets; `undefined` — no target. */
  readonly dueAt: () => number | undefined
  /** The tick: reads what is due, synchronously (one batch). */
  readonly tick: () => void
  readonly defects: Defects
}

export interface Scheduler {
  /**
   * Asks for a re-plan; calls of one synchronous turn merge into one plan in
   * a microtask.
   */
  request(): void
  /** Drops the timer: the tab is hidden. */
  suspend(): void
  /** Drops the timer for good: the session closes. */
  stop(): void
  /** 1 while a timer is set, else 0. */
  timers(): number
  /** The plans made so far (an inspection counter). */
  plans(): number
}

export function createScheduler(ctx: SchedulerContext): Scheduler {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  let plans = 0

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  // Дефект самотесту «спрацювання на прихованій вкладці»: ні планування, ні
  // спрацювання не питають видимість.
  const hiddenOk = () => ctx.defects.has("scheduler-fires-hidden")

  const fire = () => {
    timer = undefined
    // Видимість — у момент спрацювання, а не лише при постановці: таймер міг
    // пережити `suspend()`; прихована вкладка нічого не шле (§6.7).
    if (ctx.closed() || (!ctx.visible() && !hiddenOk())) return
    ctx.tick()
    request()
  }

  const plan = () => {
    pending = false
    plans++
    // Таймер знімають `cancel` (suspend, закриття) і постановка нового.
    if (ctx.closed() || (!ctx.visible() && !hiddenOk())) return
    clear()
    const due = ctx.dueAt()
    if (due === undefined) return
    timer = setTimeout(fire, Math.max(0, due - ctx.now()))
  }

  function request() {
    if (pending) return
    pending = true
    queueMicrotask(plan)
  }

  return {
    request,
    suspend() {
      if (ctx.defects.has("scheduler-keeps-timer-on-suspend")) return
      clear()
    },
    stop: clear,
    timers: () => (timer === undefined ? 0 : 1),
    plans: () => plans,
  }
}
