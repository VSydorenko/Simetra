// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  NavigationProvider,
  useNavigation,
  type NavigationAdapter,
} from "../navigation"

afterEach(cleanup)

describe("навігація", () => {
  it("useNavigation без провайдера кидає Error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    function Probe() {
      useNavigation()
      return null
    }
    expect(() => render(createElement(Probe))).toThrow(Error)
    spy.mockRestore()
  })

  it("з провайдером віддає той самий адаптер", () => {
    const adapter: NavigationAdapter = {
      openCard: () => {},
      openList: () => {},
      useBlockWhile: () => {},
    }
    let got: NavigationAdapter | undefined
    function Probe() {
      got = useNavigation()
      return null
    }
    render(createElement(NavigationProvider, { adapter }, createElement(Probe)))
    expect(got).toBe(adapter)
  })
})
