import { useForm, useSelector } from "@tanstack/react-form"
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react"
import {
  useWriter,
  type Mutation,
  type MutationResult,
  type UseRowResult,
} from "simetra/data/react"
import type { CommandError } from "simetra/model"

/**
 * The state of a card draft (P4-D spec §5.2, P4-B spec §7.1): `saving` while
 * an own write is in flight, `failed` / `conflict` / `unknown` from the own
 * mutation of the row, `purged` after the view was purged or the row became
 * `removed` (the draft is dropped), `hidden` while the values are hidden by
 * rights (the draft is kept, nothing is shown).
 */
export type CardDraftState =
  "idle" | "saving" | "failed" | "conflict" | "unknown" | "purged" | "hidden"

type Values = Readonly<Record<string, unknown>>

export interface UseCardDraftInput {
  /** Logical object name `"<kind>.<name>"`. */
  object: string
  /** The row key. */
  id: string
  /** The card read by `useRow` for the same object and key. */
  card: UseRowResult
}

/** The draft of one card header (P4-B spec §7.1 «Чернетка форми»). */
export interface CardDraft {
  readonly state: CardDraftState
  /** The draft holds edits; a host blocks navigation meanwhile. */
  readonly dirty: boolean
  /**
   * The confirmed version the draft is based on: the row version when the
   * draft started. `expectedVersion` of a save; it moves only with an own
   * success or «Overwrite», never with a newer store version.
   */
  readonly base: number | undefined
  /**
   * What the header fields show: the draft over the confirmed row. Empty
   * while `hidden` or `purged`, so no value of the row or the draft reaches
   * the DOM.
   */
  readonly values: Values
  /** The fields the draft holds. */
  readonly edited: ReadonlySet<string>
  /**
   * Refusals per field: a T0 codec refusal of the input, or `command.invalid`
   * with a `path` from the server.
   */
  readonly fieldErrors: Readonly<Record<string, CommandError>>
  /** The refusal of the last save, when it has one. */
  readonly error?: CommandError
  /** «Save» is allowed now. */
  readonly canSave: boolean
  /**
   * `conflict`: the re-read of the server row has landed (its version is
   * above {@link base}), so the shown server value is the current one.
   */
  readonly serverRead: boolean
  /** «Overwrite» is allowed now. */
  readonly canOverwrite: boolean
  /** «Retry» is allowed now. */
  readonly canRetry: boolean
  /** Records an edit; `error` is the codec refusal of the input, if any. */
  setValue(field: string, value: unknown, error?: CommandError): void
  /** Sends the edited attributes with `expectedVersion` = {@link base}. */
  save(): void
  /** `conflict`: a new save based on the current server row; only while {@link canOverwrite}. */
  overwrite(): void
  /** `failed`: the mutation's `retry`; only while {@link canRetry}. */
  retry(): void
  /** Drops the draft and the own mutation; one frame back to the confirmed row. */
  cancel(): void
  /** `unknown`: drops the shown mutation (`dismiss`); the draft stays. */
  dismiss(): void
}

const EMPTY: Values = Object.freeze({})
const NO_ERRORS: Readonly<Record<string, CommandError>> = Object.freeze({})

/** Бухгалтерія чернетки, що не є значеннями: значення тримає TanStack Form. */
interface DraftMeta {
  base: number | undefined
  /** Лічильник ревізій: кожна правка — нова ревізія. */
  revision: number
  /** Ревізія останньої правки кожного поля чернетки. */
  revisions: Map<string, number>
  /** Ревізія, з якою пішла остання спроба: її бере й `retry`. */
  sent: number
  /** Покоління чернетки: відповідь спроби старшого покоління ігнорується. */
  generation: number
}

/*
 * Єдина охорона запису картки: її беруть `save`, `overwrite` і `retry`, а не
 * лише кнопки. Застарілий рядок `editable` хука ще не враховує (#242 зведе
 * охорону до `editable` і кодека).
 */
function writable(
  card: UseRowResult,
  codecErrors: Readonly<Record<string, CommandError>>
): boolean {
  return (
    card.editable &&
    !card.isStale &&
    card.row?.state !== "removed" &&
    card.row?.stale !== true &&
    Object.keys(codecErrors).length === 0
  )
}

/** Що дозволено в останньому кадрі: функції хука читають це, а не замикання. */
interface Allowed {
  save: boolean
  overwrite: boolean
  retry: boolean
}

const freshMeta = (generation: number): DraftMeta => ({
  base: undefined,
  revision: 0,
  revisions: new Map(),
  sent: 0,
  generation,
})

/**
 * The draft of a card header over TanStack Form (P4-D spec §5.2): the form
 * holds the edited values, the hook keeps the draft base and a revision per
 * field. A success of revision A drops only the fields not edited after A
 * and moves the base to the version of the result; `conflict` and `failed`
 * keep every edit.
 */
export function useCardDraft(input: UseCardDraftInput): CardDraft {
  const { object, id, card } = input
  const writer = useWriter()
  const form = useForm({ defaultValues: EMPTY as Record<string, unknown> })
  const draft = useSelector(form.store, (s) => s.values)
  const meta = useRef<DraftMeta>(freshMeta(0))
  // База живе в `meta` (її читають асинхронні продовження), а кадр із новою
  // базою без зміни значень дає цей лічильник.
  const [, rendered] = useReducer((n: number) => n + 1, 0)
  const [codecErrors, setCodecErrors] =
    useState<Readonly<Record<string, CommandError>>>(NO_ERRORS)
  // Спроба в польоті й відмова без мутації рядка (закритий writer): лише
  // тоді стан не дає `RowView.mutation`.
  const [attempt, setAttempt] = useState<{
    id?: string
    error?: CommandError
  }>({})
  const latest = useRef(card)
  latest.current = card
  const allowed = useRef<Allowed>({
    save: false,
    overwrite: false,
    retry: false,
  })

  const row = card.row
  const live = row !== undefined && row.state !== "removed" ? row : undefined
  const mutation = row?.mutation
  const purged = card.status === "purged" || row?.state === "removed"
  const hidden = live?.hidden === true

  const reset = useCallback(() => {
    meta.current = freshMeta(meta.current.generation + 1)
    form.reset(EMPTY as Record<string, unknown>)
    setCodecErrors(NO_ERRORS)
    setAttempt({})
    rendered()
  }, [form])

  // Скидання — ефектом, бо форма — зовнішнє сховище; показ до нього
  // охороняє `purged` нижче, тож кадру зі старою чернеткою немає.
  useEffect(() => {
    if (purged) reset()
  }, [purged, reset])

  const track = useCallback(
    (m: Mutation, sent: number) => {
      const generation = meta.current.generation
      setAttempt({ id: m.id })
      void m.settled.then((result: MutationResult) => {
        const current = meta.current
        if (current.generation !== generation) return
        if (result.ok) {
          // Успіх ревізії A: поля, змінені після A, лишаються над новою базою.
          for (const [field, revision] of [...current.revisions]) {
            if (revision > sent) continue
            current.revisions.delete(field)
            form.deleteField(field)
          }
          current.base =
            current.revisions.size === 0
              ? undefined
              : (result.rows[0]?.version ?? current.base)
          setAttempt({})
          rendered()
          return
        }
        // Відмова лишає всі правки; стан показує мутація рядка, а без неї
        // (writer без рантайму) — сама відмова.
        const shown = latest.current.row?.mutation
        setAttempt(shown?.id === m.id ? {} : { error: result.error })
      })
    },
    [form]
  )

  const send = useCallback(
    (expectedVersion: number) => {
      const current = meta.current
      current.sent = current.revision
      const values = { ...form.state.values }
      track(
        writer.update(object, id, values, { expectedVersion }),
        current.sent
      )
    },
    [form, writer, object, id, track]
  )

  const setValue = useCallback(
    (field: string, value: unknown, error?: CommandError) => {
      const current = meta.current
      // База — версія, яку користувач бачив на початку чернетки (#227).
      if (current.base === undefined) current.base = latest.current.version
      current.revisions.set(field, ++current.revision)
      form.setFieldValue(field, () => value)
      setCodecErrors((prev) => {
        if (error === undefined && !(field in prev)) return prev
        const next = { ...prev }
        if (error === undefined) delete next[field]
        else next[field] = error
        return next
      })
    },
    [form]
  )

  const save = useCallback(() => {
    const base = meta.current.base
    if (allowed.current.save && base !== undefined) send(base)
  }, [send])

  const overwrite = useCallback(() => {
    const shownRow = latest.current.row
    if (!allowed.current.overwrite) return
    if (shownRow === undefined || shownRow.state === "removed") return
    // «Перезаписати» — свідома згода з поточним серверним рядком: він і є
    // новою базою.
    meta.current.base = shownRow.version
    rendered()
    send(shownRow.version)
  }, [send])

  const retry = useCallback(() => {
    if (!allowed.current.retry) return
    const next = latest.current.row?.mutation?.retry?.()
    if (next !== undefined) track(next, meta.current.sent)
  }, [track])

  const cancel = useCallback(() => {
    const own = latest.current.row?.mutation
    reset()
    own?.cancel?.()
  }, [reset])

  const dismiss = useCallback(() => {
    latest.current.row?.mutation?.dismiss?.()
  }, [])

  const edited = useMemo(() => new Set(Object.keys(draft)), [draft])
  const failure = mutation?.error ?? attempt.error
  const fieldErrors = useMemo(() => {
    const server =
      failure?.code === "command.invalid" && failure.path !== undefined
        ? { [failure.path]: failure }
        : undefined
    return server === undefined ? codecErrors : { ...server, ...codecErrors }
  }, [failure, codecErrors])

  let state: CardDraftState
  if (purged) state = "purged"
  else if (hidden) state = "hidden"
  else if (mutation?.state === "pending" || attempt.id !== undefined)
    state = "saving"
  else if (mutation !== undefined) state = mutation.state
  else if (attempt.error !== undefined) state = "failed"
  else state = "idle"

  // Чернетка поверх підтвердженого рядка; на `hidden` і `purged` — нічого:
  // сховане правами не потрапляє в DOM навіть значенням чернетки.
  const values = useMemo<Values>(
    () =>
      purged || hidden || live === undefined
        ? EMPTY
        : { ...live.values, ...draft },
    [purged, hidden, live, draft]
  )
  const dirty = !purged && edited.size > 0
  const base = meta.current.base
  const canWrite = writable(card, codecErrors)
  const canSave =
    dirty &&
    (state === "idle" || state === "failed") &&
    canWrite &&
    base !== undefined
  // `conflict` настає раніше за перечитування (оверлей T4 спершу віддає стан):
  // доти сховище тримає базовий рядок, і «Перезаписати» взяло б стару базу.
  const serverRead =
    state === "conflict" &&
    live !== undefined &&
    base !== undefined &&
    live.version > base
  const canOverwrite = serverRead && canWrite
  const canRetry = state === "failed" && canWrite
  allowed.current = { save: canSave, overwrite: canOverwrite, retry: canRetry }

  return {
    state,
    dirty,
    base: purged ? undefined : meta.current.base,
    values,
    edited: purged ? new Set() : edited,
    fieldErrors: purged || hidden ? NO_ERRORS : fieldErrors,
    ...(failure === undefined || purged || hidden ? {} : { error: failure }),
    canSave,
    serverRead,
    canOverwrite,
    canRetry,
    setValue,
    save,
    overwrite,
    retry,
    cancel,
    dismiss,
  }
}
