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
  /** The number of live timers: 1 while one is set, else 0. */
  timers(): number
  /** The plans made so far (an inspection counter). */
  plans(): number
}

export function createScheduler(ctx: SchedulerContext): Scheduler {
  // Множина, а не одне поле: лічильник чесно показує й зайві таймери.
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let pending = false
  let plans = 0
  let immediate = false

  const clear = () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  // Дефект самотесту «спрацювання на прихованій вкладці»: ні планування, ні
  // спрацювання не питають видимість.
  const hiddenOk = () => ctx.defects.has("scheduler-fires-hidden")

  const fire = (self?: ReturnType<typeof setTimeout>) => {
    if (self !== undefined) timers.delete(self)
    // Видимість — у момент спрацювання, а не лише при постановці: таймер міг
    // пережити `suspend()`; прихована вкладка нічого не шле (§6.7).
    if (ctx.closed() || (!ctx.visible() && !hiddenOk())) return
    // Синхронний збій такту не вбиває таймер: перепланування йде в будь-якому разі.
    try {
      ctx.tick()
    } finally {
      request()
    }
  }

  const plan = () => {
    pending = false
    plans++
    // Таймер знімають `cancel` (suspend, закриття) і постановка нового.
    if (ctx.closed() || (!ctx.visible() && !hiddenOk())) {
      immediate = false
      return
    }
    // Дефект самотесту: нове планування лишає попередній таймер.
    if (!ctx.defects.has("scheduler-timer-per-object")) clear()
    const due = ctx.dueAt()
    if (due === undefined) {
      immediate = false
      return
    }
    const wait = due - ctx.now()
    // Строк, що вже настав (`requestReread` з `jitterMs` 0), виконує це саме
    // перепланування без таймера: виклики одного ходу — один такт. Після
    // такту строк, який такт не зняв, іде вже таймером, а не мікрозадачею:
    // розбіжність ядра й планувальника не голодує цикл подій.
    if (wait <= 0 && !immediate) {
      immediate = true
      fire()
      return
    }
    immediate = false
    const timer: ReturnType<typeof setTimeout> = setTimeout(
      () => fire(timer),
      Math.max(0, wait)
    )
    timers.add(timer)
  }

  function request() {
    if (pending) return
    pending = true
    // Не `queueMicrotask`: його підміняють тести перевідкидання помилок host-а.
    void Promise.resolve().then(plan)
  }

  return {
    request,
    suspend() {
      if (ctx.defects.has("scheduler-keeps-timer-on-suspend")) return
      clear()
    },
    stop: clear,
    timers: () => timers.size,
    plans: () => plans,
  }
}
