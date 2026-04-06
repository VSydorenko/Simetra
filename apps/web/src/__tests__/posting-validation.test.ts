import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { projectModelSchema, type ProjectModel } from "@simetra/core"
import "@/i18n"
import { useMetadataStore } from "../stores/metadata-store"
import { useModelValidation } from "../hooks/use-model-validation"

describe("posting cross-check: posting register refs subset of registerMovements", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("reports error when posting.movements has register not in registerMovements", () => {
    const model: ProjectModel = projectModelSchema.parse({
      project: { name: "Test" },
      accumulationRegisters: [
        {
          kind: "AccumulationRegister",
          name: "InventoryBalance",
          registerType: "Balance",
          dimensions: [{ name: "product", type: "String" }],
          resources: [
            { name: "quantity", type: "Numeric", precision: 15, scale: 2 },
          ],
        },
      ],
      documents: [
        {
          kind: "Document",
          name: "Invoice",
          attributes: [],
          tabularSections: [
            {
              name: "items",
              attributes: [{ name: "product", type: "String" }],
            },
          ],
          registerMovements: [],
          posting: {
            movements: [
              {
                register: {
                  kind: "AccumulationRegister",
                  name: "InventoryBalance",
                },
                movementType: "Receipt",
                source: "tabularSection:items",
                mappings: { dimensions: { product: "row.product" } },
              },
            ],
            validations: [],
          },
        },
      ],
    })

    useMetadataStore.setState({
      model,
      version: 1,
      objectVersions: {},
      validationErrors: {},
      modelErrors: {},
    })

    renderHook(() => useModelValidation())

    act(() => {
      vi.advanceTimersByTime(400)
    })

    const modelErrors = useMetadataStore.getState().modelErrors
    const docErrors = modelErrors["Document/Invoice"] ?? []
    expect(
      docErrors.some(
        (e) =>
          e.message.includes("posting.movements contains register") &&
          e.message.includes("not declared in registerMovements"),
      ),
    ).toBe(true)
  })

  it("reports warning when posting has validations but no movements", () => {
    const model: ProjectModel = projectModelSchema.parse({
      project: { name: "Test" },
      accumulationRegisters: [
        {
          kind: "AccumulationRegister",
          name: "InventoryBalance",
          registerType: "Balance",
          dimensions: [{ name: "product", type: "String" }],
          resources: [
            { name: "quantity", type: "Numeric", precision: 15, scale: 2 },
          ],
        },
      ],
      documents: [
        {
          kind: "Document",
          name: "Invoice",
          attributes: [],
          tabularSections: [],
          registerMovements: [
            { kind: "AccumulationRegister", name: "InventoryBalance" },
          ],
          posting: {
            movements: [],
            validations: [
              {
                type: "NonNegativeBalance",
                register: {
                  kind: "AccumulationRegister",
                  name: "InventoryBalance",
                },
                dimensions: ["product"],
                resource: "quantity",
                message: { uk: "Помилка" },
              },
            ],
          },
        },
      ],
    })

    useMetadataStore.setState({
      model,
      version: 1,
      objectVersions: {},
      validationErrors: {},
      modelErrors: {},
    })

    renderHook(() => useModelValidation())

    act(() => {
      vi.advanceTimersByTime(400)
    })

    const modelErrors = useMetadataStore.getState().modelErrors
    const docErrors = modelErrors["Document/Invoice"] ?? []
    expect(
      docErrors.some((e) =>
        e.message.includes("validations but no movements"),
      ),
    ).toBe(true)
  })
})
