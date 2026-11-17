// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { clientCatalog } from "../../data/__tests__/support"
import { CatalogProvider, useCatalogEntry } from "../catalog"

afterEach(cleanup)

function probe(object: string, seen: { name?: string }) {
  return function Probe() {
    seen.name = useCatalogEntry(object).name
    return null
  }
}

describe("каталог T5", () => {
  it("useCatalogEntry без провайдера кидає Error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(createElement(probe("Catalog.Task", {})))).toThrow(
      "useCatalogEntry requires a CatalogProvider"
    )
    spy.mockRestore()
  })

  it("віддає запис за логічним іменем, невідомий об'єкт — TypeError", () => {
    const seen: { name?: string } = {}
    render(
      createElement(
        CatalogProvider,
        { catalog: clientCatalog() },
        createElement(probe("Catalog.Task", seen))
      )
    )
    expect(seen.name).toBe("Task")
    cleanup()
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() =>
      render(
        createElement(
          CatalogProvider,
          { catalog: clientCatalog() },
          createElement(probe("Catalog.Missing", {}))
        )
      )
    ).toThrow(TypeError)
    spy.mockRestore()
  })
})
