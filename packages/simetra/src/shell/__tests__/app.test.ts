// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CatalogProvider, useCatalogEntry } from "simetra/ui"
import { SUBJECT } from "../../data/__tests__/support"
import { simetraApp } from "../app"
import { catalog } from "./support"

// Спостерігаємо фабрику рантайму з пропуском до справжньої: тотожність
// каталогу видно лише в аргументі виклику.
const created = vi.hoisted(() => ({ catalogs: [] as unknown[] }))
vi.mock("simetra/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("simetra/data")>()
  return {
    ...actual,
    createDataRuntime: (options: { catalog: unknown }) => {
      created.catalogs.push(options.catalog)
      return actual.createDataRuntime(
        options as Parameters<typeof actual.createDataRuntime>[0]
      )
    },
  }
})

afterEach(cleanup)

describe("simetraApp", () => {
  it("returns the descriptor { ref, id } of a known object", () => {
    const entity = simetraApp(catalog).object({ kind: "Catalog", name: "Task" })
    expect(entity).toEqual({
      ref: "Catalog.Task",
      id: catalog.objects[0]!.id,
    })
  })

  it("throws TypeError for an object outside the catalog", () => {
    expect(() =>
      simetraApp(catalog).object({ kind: "Catalog", name: "Nope" })
    ).toThrow(TypeError)
  })

  it("gives the runtime factory and the provider the same catalog object", () => {
    const app = simetraApp(catalog)
    app
      .createRuntime({
        transport: () => Promise.reject(new Error("unused")),
        subject: SUBJECT,
        log: () => {},
      })
      .dispose()
    expect(created.catalogs).toHaveLength(1)
    expect(created.catalogs[0]).toBe(catalog)

    const mounted = app.Provider({})
    expect(mounted.type).toBe(CatalogProvider)
    expect((mounted.props as { catalog: unknown }).catalog).toBe(catalog)
  })

  it("provides the catalog to the hosts below it", () => {
    const app = simetraApp(catalog)
    let seen: string | undefined
    function Probe() {
      seen = useCatalogEntry("Catalog.Task").name
      return null
    }
    render(createElement(app.Provider, null, createElement(Probe)))
    expect(seen).toBe("Task")
  })
})
