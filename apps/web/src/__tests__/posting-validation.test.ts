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

  it("AR: all dimensions required regardless of required flag", () => {
    const model: ProjectModel = projectModelSchema.parse({
      project: { name: "Test" },
      accumulationRegisters: [
        {
          kind: "AccumulationRegister",
          name: "InventoryBalance",
          registerType: "Balance",
          dimensions: [
            { name: "product", type: "String" },
            { name: "warehouse", type: "String", required: false },
          ],
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
          registerMovements: [
            { kind: "AccumulationRegister", name: "InventoryBalance" },
          ],
          posting: {
            movements: [
              {
                register: {
                  kind: "AccumulationRegister",
                  name: "InventoryBalance",
                },
                movementType: "Receipt",
                source: "tabularSection:items",
                mappings: { dimensions: {}, resources: {} },
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
    const dimError = docErrors.find((e) =>
      e.message.includes("не заповнені dimensions"),
    )
    expect(dimError).toBeDefined()
    expect(dimError!.message).toContain("product")
    expect(dimError!.message).toContain("warehouse")
  })

  it("IR: only required dimensions reported as missing", () => {
    const model: ProjectModel = projectModelSchema.parse({
      project: { name: "Test" },
      informationRegisters: [
        {
          kind: "InformationRegister",
          name: "CurrencyRates",
          periodicity: "Day",
          dimensions: [
            { name: "currency", type: "String", required: true },
            { name: "warehouse", type: "String", required: false },
          ],
          resources: [
            { name: "rate", type: "Numeric", precision: 15, scale: 4 },
          ],
        },
      ],
      documents: [
        {
          kind: "Document",
          name: "RateUpdate",
          attributes: [],
          tabularSections: [],
          registerMovements: [
            { kind: "InformationRegister", name: "CurrencyRates" },
          ],
          posting: {
            movements: [
              {
                register: {
                  kind: "InformationRegister",
                  name: "CurrencyRates",
                },
                movementType: "Receipt",
                source: "document",
                mappings: { dimensions: {}, resources: {} },
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
    const docErrors = modelErrors["Document/RateUpdate"] ?? []
    const dimError = docErrors.find((e) =>
      e.message.includes("обов'язкові dimensions"),
    )
    expect(dimError).toBeDefined()
    expect(dimError!.message).toContain("currency")
    expect(dimError!.message).not.toContain("warehouse")
  })
})
