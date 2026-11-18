import {
  createElement,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react"
import { useRow, type CardSection, type UseRowResult } from "simetra/data/react"
import type { CatalogEntry, CatalogEntrySection } from "simetra/model"
import { useCatalogEntry } from "../catalog"
import {
  FieldEditor,
  FieldView,
  cardFields,
  isEditableType,
  type FieldColumn,
} from "../fields"
import { useMessage, type MessageKey } from "../messages"
import { useNavigation } from "../navigation"
import { displayState, stateMessageKey } from "../list/state-cell"
import { useCardDraft, type CardDraft } from "./use-card-draft"

export interface CardHostProps {
  /** Logical object name `"<kind>.<name>"`. */
  object: string
  /** The row key. */
  id: string
}

/**
 * The read of a card: every tabular section of the object. One function for
 * the host and the route loader (P4-D spec §6), so the views a loader
 * preloads are the views the host subscribes to.
 */
export function cardQuery(entry: CatalogEntry): {
  tabularSections: readonly string[]
} {
  return { tabularSections: entry.tabularSections.map((s) => s.name) }
}

const DRAFT_KEYS: Partial<Record<CardDraft["state"], MessageKey>> = {
  saving: "state.pending",
  failed: "state.failed",
  conflict: "state.conflict",
  unknown: "state.unknown",
}

function Text(props: { messageKey: MessageKey }) {
  return useMessage(props.messageKey)
}

function Button(props: {
  messageKey: MessageKey
  onClick(): void
  disabled?: boolean
}) {
  return createElement(
    "button",
    { type: "button", onClick: props.onClick, disabled: props.disabled },
    createElement(Text, { messageKey: props.messageKey })
  )
}

/** The status line of the card: which message the header state shows. */
function statusKey(
  card: UseRowResult,
  draft: CardDraft
): MessageKey | undefined {
  if (card.status === "purged") return "state.purged"
  const row = card.row
  if (row === undefined)
    return card.status === "loading" ? "state.loading" : undefined
  // `hidden` і `removed` старші за стан чернетки: значень немає.
  const shown = displayState(row)
  if (shown === "hidden" || shown === "removed") return stateMessageKey(shown)
  // Серверний рядок конфлікту ще читається: показуємо читання, не стару базу.
  if (draft.state === "conflict" && !draft.serverRead) return "state.refreshing"
  return DRAFT_KEYS[draft.state] ?? stateMessageKey(shown)
}

function Field(props: {
  column: FieldColumn
  card: UseRowResult
  draft: CardDraft
}): ReactElement {
  const { column, card, draft } = props
  const { attribute, name } = column
  const row = card.row
  const live = row !== undefined && row.state !== "removed" ? row : undefined
  const showValues = draft.state !== "hidden" && draft.state !== "purged"
  // Поле редаговане лише за правом атрибута, цілою шапкою й сумісним
  // клієнтом (§5.2); тип, якого зріз не редагує, — показ.
  const editable =
    showValues &&
    attribute.update &&
    card.editable &&
    !card.isStale &&
    isEditableType(attribute)
  const value = draft.values[name]
  const error = draft.fieldErrors[name]
  const staleField = live?.staleFields.includes(name) === true
  let body: ReactNode = null
  if (showValues && live !== undefined) {
    body = editable
      ? createElement(FieldEditor, {
          attribute,
          value,
          onChange: (next, codec) => draft.setValue(name, next, codec),
        })
      : createElement(FieldView, { attribute, value })
  }
  return createElement(
    "div",
    { "data-field-slot": name },
    createElement("label", null, column.title),
    body,
    // Біля поля — його відмова: кодек T0 чи `command.invalid` з `path`.
    error !== undefined && showValues
      ? createElement(
          "span",
          { role: "alert", "data-field-error": error.code },
          error.code
        )
      : null,
    staleField && showValues
      ? createElement(
          "span",
          { "data-hint": "stale" },
          createElement(Text, { messageKey: "state.stale" })
        )
      : null,
    // `conflict`: поточний серверний рядок поруч із правкою — лише
    // перечитаний, бо до того сховище показує базу користувача.
    draft.serverRead && draft.edited.has(name) && live !== undefined
      ? createElement(
          "span",
          { "data-server": name },
          createElement(FieldView, { attribute, value: live.values[name] })
        )
      : null
  )
}

function Section(props: {
  section: CatalogEntrySection
  data: CardSection | undefined
  card: UseRowResult
}): ReactElement {
  const { section, data, card } = props
  const error = card.error
  // Понад `TABULAR_LINES_MAX` сервер не обрізає, а відмовляє (П4-D §5.2):
  // таблиця показує причину, а не неповні рядки.
  if (
    error?.code === "command.invalid" &&
    "reason" in error &&
    error.reason === "tabular-too-large" &&
    (error.path === undefined || error.path === section.name)
  ) {
    return createElement(
      "div",
      { "data-section": section.name, "data-section-state": error.reason },
      error.reason
    )
  }
  const lines =
    data === undefined || data.ownerState === "removed"
      ? []
      : [...data.lines].sort(
          (a, b) =>
            Number(a.values[section.lineNumberName]) -
            Number(b.values[section.lineNumberName])
        )
  return createElement(
    "table",
    { "data-section": section.name },
    createElement(
      "thead",
      null,
      createElement(
        "tr",
        null,
        ...section.attributes.map((a) =>
          createElement("th", { key: a.name }, a.name)
        )
      )
    ),
    createElement(
      "tbody",
      null,
      ...lines.map((line) =>
        createElement(
          "tr",
          { key: line.key, "data-line-key": line.key },
          ...section.attributes.map((a) =>
            createElement(
              "td",
              { key: a.name },
              createElement(FieldView, {
                attribute: a,
                value: line.values[a.name],
              })
            )
          )
        )
      )
    )
  )
}

function Actions(props: { card: UseRowResult; draft: CardDraft }) {
  const { card, draft } = props
  const updateRequired = useMessage("app.updateRequired")
  if (draft.state === "purged") {
    return createElement(Button, {
      messageKey: "action.reloadPage",
      // Виняток безпеки скидає стан сторінки цілком (як і в списку).
      onClick: () => window.location.reload(),
    })
  }
  if (card.row === undefined || card.row.state === "removed") return null
  return createElement(
    "div",
    { "data-region": "card-actions" },
    // Несумісний клієнт (П4-B §6.4): запис не пройде, тож замість дії —
    // вимога оновити застосунок.
    card.isStale
      ? createElement("span", { "data-app": "update-required" }, updateRequired)
      : createElement(Button, {
          messageKey: "action.save",
          onClick: draft.save,
          disabled: !draft.canSave,
        }),
    draft.state === "failed"
      ? createElement(Button, {
          messageKey: "action.retry",
          onClick: draft.retry,
          disabled: !draft.canRetry,
        })
      : null,
    draft.state === "failed"
      ? createElement(Button, {
          messageKey: "action.cancel",
          onClick: draft.cancel,
        })
      : null,
    // «Взяти серверне» — те саме скидання чернетки й мутації, що й
    // «Скасувати»: поля повертаються до серверного рядка.
    draft.state === "conflict"
      ? createElement(Button, {
          messageKey: "action.takeServer",
          onClick: draft.cancel,
        })
      : null,
    draft.state === "conflict"
      ? createElement(Button, {
          messageKey: "action.overwrite",
          onClick: draft.overwrite,
          disabled: !draft.canOverwrite,
        })
      : null,
    draft.state === "unknown"
      ? createElement(Button, {
          messageKey: "action.dismiss",
          onClick: draft.dismiss,
        })
      : null
  )
}

/**
 * The standard card of an object (P4-D spec §5.2): the header fields in
 * catalog order with the draft of `useCardDraft`, and every tabular section
 * read-only. A dirty draft blocks navigation. A `hidden` card shows no value
 * of the row or the draft; a purged or `removed` one drops the draft. Needs
 * `CatalogProvider`, `NavigationProvider` and `DataRuntimeProvider`.
 */
export function CardHost(props: CardHostProps): ReactElement {
  const { object, id } = props
  const entry = useCatalogEntry(object)
  const query = useMemo(() => cardQuery(entry), [entry])
  const fields = useMemo(() => cardFields(entry), [entry])
  const card = useRow({ object, id, ...query })
  const draft = useCardDraft({ object, id, card })
  useNavigation().useBlockWhile(draft.dirty)
  const key = statusKey(card, draft)
  const row = card.row
  const live = row !== undefined && row.state !== "removed" ? row : undefined
  const showValues =
    live !== undefined && draft.state !== "hidden" && draft.state !== "purged"
  // Стан мутації старший за `stale` у назві, але факт застарілості рядка
  // показується підказкою поруч (П4-B §6.5).
  const staleHint =
    showValues &&
    live.stale === true &&
    key !== undefined &&
    key !== "state.stale"
  return createElement(
    "div",
    {
      "data-region": "card",
      "data-object": object,
      "data-key": id,
      "data-state": row === undefined ? undefined : displayState(row),
      "data-draft": draft.state,
    },
    createElement(
      "div",
      { "data-region": "card-status" },
      // Живі регіони стоять у DOM завжди (як і в панелі списку).
      createElement(
        "span",
        { "aria-live": "polite", "data-card": "status" },
        key === undefined || key === "state.purged"
          ? null
          : createElement(Text, { messageKey: key }),
        staleHint
          ? createElement(
              "span",
              { "data-hint": "stale" },
              createElement(Text, { messageKey: "state.stale" })
            )
          : null,
        card.status === "error" &&
          card.error !== undefined &&
          !("reason" in card.error && card.error.reason === "tabular-too-large")
          ? createElement(
              "span",
              { "data-error": card.error.code },
              card.error.code
            )
          : null
      ),
      createElement(
        "span",
        {
          "aria-live": "assertive",
          "data-card": "security",
          "data-reason": card.status === "purged" ? card.reason : undefined,
        },
        key === "state.purged" ? createElement(Text, { messageKey: key }) : null
      )
    ),
    row === undefined && card.status === "loading"
      ? createElement("div", { "data-loading": "card" })
      : null,
    live === undefined || draft.state === "purged"
      ? null
      : createElement(
          "div",
          { "data-region": "card-header" },
          ...fields.map((column) =>
            createElement(Field, { key: column.name, column, card, draft })
          )
        ),
    createElement(Actions, { card, draft }),
    showValues
      ? entry.tabularSections.map((section) =>
          createElement(Section, {
            key: section.name,
            section,
            data: card.tabularSections[section.name],
            card,
          })
        )
      : null
  )
}
