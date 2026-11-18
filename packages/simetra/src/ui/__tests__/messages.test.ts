// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { MESSAGES, MessagesProvider, useMessage } from "../messages"

afterEach(cleanup)

// Явний перелік зі спеки §5.4: видалення ключа з обох локалей має червонити тест.
const REQUIRED_KEYS = [
  "state.pending",
  "state.unknown",
  "state.failed",
  "state.conflict",
  "state.stale",
  "state.hidden",
  "state.removed",
  "state.loading",
  "state.refreshing",
  "state.purged",
  "action.open",
  "action.save",
  "action.dismiss",
  "action.retry",
  "action.cancel",
  "action.takeServer",
  "action.overwrite",
  "action.remove",
  "action.showNew",
  "action.refreshList",
  "action.refreshCard",
  "action.reloadPage",
  "value.yes",
  "value.no",
  "value.notInSlice",
  "app.updateRequired",
] as const

function Probe() {
  return createElement("span", null, useMessage("state.hidden"))
}

describe("каталог повідомлень", () => {
  it("ключі en і uk збігаються", () => {
    expect(Object.keys(MESSAGES.uk).sort()).toEqual(
      Object.keys(MESSAGES.en).sort()
    )
  })

  it.each(["en", "uk"] as const)(
    "кожен обов'язковий ключ має непорожній текст %s",
    (locale) => {
      const catalogue: Record<string, string | undefined> = MESSAGES[locale]
      for (const key of REQUIRED_KEYS) {
        expect(catalogue[key]?.trim(), key).toBeTruthy()
      }
      for (const [key, text] of Object.entries(MESSAGES[locale])) {
        expect(text.trim(), key).not.toBe("")
      }
    }
  )

  it("рядок hidden uk — літерал зі спеки §5.4", () => {
    expect(MESSAGES.uk["state.hidden"]).toBe(
      "Доступ змінився — значення приховано, перевіряємо"
    )
  })

  it("без провайдера — en", () => {
    const { container } = render(createElement(Probe))
    expect(container.textContent).toBe(MESSAGES.en["state.hidden"])
  })

  it("провайдер перемикає локаль", () => {
    const { container } = render(
      createElement(MessagesProvider, { locale: "uk" }, createElement(Probe))
    )
    expect(container.textContent).toBe(MESSAGES.uk["state.hidden"])
  })
})
