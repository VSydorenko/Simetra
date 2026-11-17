import { createContext, createElement, useContext, type ReactNode } from "react"

/** Тексти — значення ключів локалі; `en` — типова (Дх13). Ключі — `<група>.<назва>`. */
const en = {
  "state.pending": "Saving…",
  "state.unknown": "Checking the result…",
  "state.failed": "Not saved",
  "state.conflict": "Changed by someone else",
  "state.stale": "May be out of date",
  "state.hidden": "Access changed — values hidden, checking",
  "state.removed": "Row unavailable",
  "state.loading": "Loading…",
  "state.refreshing": "Updating…",
  "state.purged": "Access changed — data hidden",
  "action.open": "Open",
  "action.save": "Save",
  "action.dismiss": "Dismiss",
  "action.retry": "Retry",
  "action.cancel": "Cancel",
  "action.takeServer": "Take server version",
  "action.overwrite": "Overwrite",
  "action.remove": "Remove",
  "action.showNew": "New rows — show",
  "action.refreshList": "The list changed — refresh",
  "action.refreshCard": "The card changed — refresh",
  "action.reloadPage": "Reload the page",
  "value.yes": "Yes",
  "value.no": "No",
  "value.notInSlice": "Not shown in this slice",
  "app.updateRequired": "An app update is required",
} as const

export type MessageKey = keyof typeof en

const uk: Record<MessageKey, string> = {
  "state.pending": "Зберігається…",
  "state.unknown": "Перевіряємо результат…",
  "state.failed": "Не збережено",
  "state.conflict": "Змінено іншим",
  "state.stale": "Може бути застарілим",
  "state.hidden": "Доступ змінився — значення приховано, перевіряємо",
  "state.removed": "Рядок недоступний",
  "state.loading": "Завантаження…",
  "state.refreshing": "Оновлення…",
  "state.purged": "Доступ змінився — дані приховано",
  "action.open": "Відкрити",
  "action.save": "Зберегти",
  "action.dismiss": "Скасувати показ",
  "action.retry": "Повторити",
  "action.cancel": "Скасувати",
  "action.takeServer": "Взяти серверне",
  "action.overwrite": "Перезаписати",
  "action.remove": "Прибрати",
  "action.showNew": "Є нові рядки — показати",
  "action.refreshList": "Список змінився — оновити",
  "action.refreshCard": "Картка змінилась — оновити",
  "action.reloadPage": "Оновити сторінку",
  "value.yes": "Так",
  "value.no": "Ні",
  "value.notInSlice": "Не показується в зрізі",
  "app.updateRequired": "Потрібне оновлення застосунку",
}

export type Locale = "en" | "uk"

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en, uk }

// Без провайдера — типова локаль: компонент працює й у тесті без обгортки.
const LocaleContext = createContext<Locale>("en")

export function MessagesProvider(props: {
  locale: Locale
  children?: ReactNode
}) {
  return createElement(
    LocaleContext.Provider,
    { value: props.locale },
    props.children
  )
}

export function useMessage(key: MessageKey): string {
  return MESSAGES[useContext(LocaleContext)][key]
}
