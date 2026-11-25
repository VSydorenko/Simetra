import type { MutationState, ObjectName, RowState } from "../types"
import { REJOIN_JITTER_MS } from "../receiver"

/*
 * Оракул О3 (спека ядра синхронізації §5.13, план SK-0 Р-SK0-9): після
 * випадкових кроків вкладка видима, ручного `refresh()` і `revalidate` немає,
 * іде час моделі; кожен видимий вигляд показує правду фейкового сервера.
 * Межу рахує модель за ПРИЧИНОЮ зміни, а не одним інтервалом:
 *  - зміну, про яку клієнт дізнається подією каналу (приєднання), — від події,
 *    за вікном її шляху (джитер приєднання);
 *  - зміну без події каналу — лише з інтервалом перевірки свіжості: початок
 *    фази плюс інтервал і пауза збоїв.
 * Оракул не бачить ядра: лише зміни сервера, події каналу й названі стани.
 */

/** Названий стан, що тримає показ виду без межі за часом (рішення архітекторки). */
export type O3State =
  /** Звичайний вигляд: правда сервера за межею. */
  | "live"
  /** Помилка першого завантаження: `main` чекає дії користувача (рядок 18 §5.14). */
  | "first-load-error"
  /** Межа відкинутих відповідей: сесія не читає до нової (відмова, умова). */
  | "discard-bound"
  /** Несумісний об'єкт: клієнт його не читає (відмова, умова). */
  | "stale-object"
  /** Вигляд знищений `purge` пари: доки пару не відновлено. */
  | "purged"
  /**
   * Завантажена картка чи ТЧ без власної вимоги, польоту, черги й строку:
   * `main` її не читає (рядки 17 і 20 §5.14, ті самі, що й виняток О2); стан, а не час.
   */
  | "card-without-duty"
  /**
   * ТЧ, чий власник `removed` у сховищі: P4-B §6.5 вимагає `ownerState: removed`
   * без рядків, а власника повертає лише перечитування шапки; саме читання ТЧ
   * його не відновлює (рядок 22 §5.14). Стан, а не час.
   */
  | "section-owner-removed"

/** Зміна рядка на сервері й мить моделі, коли модель її побачила. */
export interface O3Change {
  readonly object: ObjectName
  readonly at: number
}

/** Приєднання каналу, яке приймач прийняв: об'єкт іде в хвилю приєднання. */
export interface O3Join {
  readonly object: ObjectName
  readonly at: number
  /** Скільки подій читання було в мить приєднання (самотест порядку читань). */
  readonly after?: number
}

export interface O3View {
  readonly id: number
  /** Об'єкт вигляду і цілі його `include`: зміна будь-якого з них стосується вигляду. */
  readonly objects: readonly ObjectName[]
  readonly state: O3State
  /** Розбіжність показу з правдою сервера; `undefined` — збігається. Викликається лише в оцінці. */
  readonly truth: () => string | undefined
}

export interface O3Input {
  /** Час моделі. */
  readonly now: number
  /** Мить початку фази: вкладка видима, зміни сервера закінчились. */
  readonly phaseStart: number
  /** Інтервал перевірки свіжості цього прогону. */
  readonly intervalMs: number
  readonly changes: readonly O3Change[]
  readonly joins: readonly O3Join[]
  readonly views: readonly O3View[]
}

/** Межа зміни без події каналу: перше читання за інтервалом (і пауза збоїв, не довша за нього). */
export const noEventBound = (
  input: Pick<O3Input, "phaseStart" | "intervalMs">
) => input.phaseStart + 2 * input.intervalMs

/**
 * Межа однієї зміни за причиною. Приєднання після зміни, що хвиля ще не
 * виконала до початку фази, дає межу від приєднання (хвиля читає явно, без
 * паузи збоїв); приєднання, чия хвиля мала спрацювати ще в кроках, межі не
 * скорочує: відповіді моделі на пізні читання бувають застарілими репліками,
 * тож усе, що вони залишили, виправляє лише такт.
 */
export function changeBound(
  change: O3Change,
  input: Pick<O3Input, "phaseStart" | "intervalMs" | "joins">
): number {
  let bound = noEventBound(input)
  for (const join of input.joins) {
    if (join.object !== change.object || join.at < change.at) continue
    const wave = join.at + REJOIN_JITTER_MS
    if (wave > input.phaseStart) bound = Math.min(bound, wave)
  }
  return bound
}

/** Межа вигляду: найпізніша з меж змін його об'єктів. */
export function viewBound(view: O3View, input: O3Input): number {
  let bound = input.phaseStart
  for (const change of input.changes)
    if (view.objects.includes(change.object))
      bound = Math.max(bound, changeBound(change, input))
  return bound
}

/** Мить, до якої модель має дати час: найпізніша межа видимих виглядів у стані `live`. */
export function lastBound(input: O3Input): number {
  let last = input.phaseStart
  for (const view of input.views)
    if (view.state === "live") last = Math.max(last, viewBound(view, input))
  return last
}

/** Миті, у які оракул щось оцінить: межі виглядів у стані `live`, за зростанням. */
export function checkpoints(input: O3Input): number[] {
  const at = new Set<number>()
  for (const view of input.views)
    if (view.state === "live") at.add(viewBound(view, input))
  return [...at].sort((a, b) => a - b)
}

/**
 * Стани рядка, що їх дає власна незавершена мутація журналу, а не сервер:
 * О3 судить показ без неї (оптимістичний шар похідний, ADR-0100). Щойно мутація
 * виходить із цих станів (підтверджена чи скасована), рядок судиться знову — від
 * тієї миті, з межею від неї (модель записує це зміною).
 */
export const OWN_MUTATION_STATES: ReadonlySet<RowState> =
  new Set<MutationState>(["pending", "failed", "conflict", "unknown"])

/** Перший рядок показу, що розійшовся з сервером; рядки з власною мутацією пропущено. */
export function judgeRows(
  rows: readonly {
    readonly state: RowState
    mismatch(): string | undefined
  }[]
): string | undefined {
  for (const row of rows) {
    if (OWN_MUTATION_STATES.has(row.state)) continue
    const problem = row.mismatch()
    if (problem !== undefined) return problem
  }
  return undefined
}

/**
 * Правда ТЧ власника: сервер, що ховає власника (права, `purge`, видалення),
 * не дає рядків; стан шапки в сховищі P4-B §6.5 вимагає лише для `removed`, тож
 * О3 судить дані — власника, версію й рядки, — а не позначку `ownerState`.
 */
export function judgeSection(
  truth: {
    readonly ownerVersion: number | undefined
    readonly lines: readonly unknown[]
  },
  shown: {
    readonly ownerState: RowState
    readonly ownerVersion: number | undefined
    readonly lines: readonly unknown[]
  }
): string | undefined {
  if (OWN_MUTATION_STATES.has(shown.ownerState)) return undefined
  if (truth.ownerVersion === undefined)
    return shown.lines.length > 0
      ? `the server gives no owner, section shows ${shown.lines.length} lines`
      : undefined
  if (shown.ownerVersion !== truth.ownerVersion)
    return `owner version ${String(shown.ownerVersion)} ≠ ${truth.ownerVersion}`
  if (JSON.stringify(shown.lines) !== JSON.stringify(truth.lines))
    return `lines ${JSON.stringify(shown.lines)} ≠ server ${JSON.stringify(truth.lines)}`
  return undefined
}

/** Лічильник нуль — О3 порожній, а не зелений. */
export function assertEvaluated(count: number, where: string): void {
  if (count <= 0)
    throw new Error(`O3 evaluated no view against the server (${where})`)
}

export interface O3 {
  /** Оцінка в мить моделі `input.now`: проблема першого вигляду, що минув межу. */
  step(input: O3Input): string | undefined
  /** Скільки виглядів оракул справді порівняв із сервером. */
  evaluated(): number
  /** Вигляд і межа останньої проблеми: самотест мутації перевіряє, що її дала саме хвиля. */
  failure():
    | { readonly objects: readonly ObjectName[]; readonly bound: number }
    | undefined
  /** Скільки виглядів пропущено названим станом (звіт про вжиті винятки). */
  skipped(state: O3State): number
}

export function createO3(): O3 {
  let count = 0
  const skippedBy = new Map<O3State, number>()
  let failed: { objects: readonly ObjectName[]; bound: number } | undefined
  return {
    step(input) {
      for (const view of input.views) {
        if (viewBound(view, input) > input.now) continue
        // Названі стани: показ тримає сам стан, не час (рішення архітекторки).
        if (view.state !== "live") {
          skippedBy.set(view.state, (skippedBy.get(view.state) ?? 0) + 1)
          continue
        }
        count++
        const problem = view.truth()
        if (problem !== undefined) {
          failed = { objects: view.objects, bound: viewBound(view, input) }
          return `view ${view.id} past its bound ${viewBound(view, input)} at ${input.now}: ${problem}`
        }
      }
      return undefined
    },
    evaluated: () => count,
    failure: () => failed,
    skipped: (state) => skippedBy.get(state) ?? 0,
  }
}
