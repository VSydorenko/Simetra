// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { MESSAGES, MessagesProvider, useMessage } from "../messages"

afterEach(cleanup)

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
    "кожен ключ має непорожній текст %s",
    (locale) => {
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
