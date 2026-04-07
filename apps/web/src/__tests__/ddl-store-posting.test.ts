import { describe, it, expect, beforeEach } from "vitest"
import { projectModelSchema, type ProjectModel } from "@simetra/core"
import { useMetadataStore } from "../stores/metadata-store"
import { useDdlStore } from "../stores/ddl-store"

describe("DDL store posting ref validation", () => {
  beforeEach(() => {
    useDdlStore.getState().clearOutput()
    useDdlStore.getState().clearValidationErrors()
  })

  it("reports error when posting.movements references non-existent register", () => {
    const model: ProjectModel = projectModelSchema.parse({
      project: { name: "Test" },
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
            { kind: "AccumulationRegister", name: "NonExistent" },
          ],
          posting: {
            movements: [
              {
                register: { kind: "AccumulationRegister", name: "NonExistent" },
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

    useDdlStore.getState().generateDdl()
    const errors = useDdlStore.getState().validationErrors
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((e) => e.includes("posting.movements"))).toBe(true)
  })

  it("reports error when posting.validations references non-existent register", () => {
    const model: ProjectModel = projectModelSchema.parse({
      project: { name: "Test" },
      documents: [
        {
          kind: "Document",
          name: "Invoice",
          attributes: [],
          tabularSections: [],
          registerMovements: [],
          posting: {
            movements: [],
            validations: [
              {
                type: "NonNegativeBalance",
                register: { kind: "AccumulationRegister", name: "NonExistent" },
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

    useDdlStore.getState().generateDdl()
    const errors = useDdlStore.getState().validationErrors
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((e) => e.includes("posting.validations"))).toBe(true)
  })

  it("passes validation when posting refs exist in model", () => {
    const model: ProjectModel = projectModelSchema.parse({
      project: { name: "Test" },
      accumulationRegisters: [
        {
          kind: "AccumulationRegister",
          name: "InventoryBalance",
          registerType: "Balance",
          recorderTypes: [{ kind: "Document", name: "Invoice" }],
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
                mappings: {
                  dimensions: { product: "row.product" },
                  resources: { quantity: "row.product" },
                },
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

    useDdlStore.getState().generateDdl()
    const errors = useDdlStore.getState().validationErrors
    expect(errors.filter((e) => e.includes("posting"))).toEqual([])
  })

  it("AR: all dimensions reported as missing regardless of required flag", () => {
    const model: ProjectModel = projectModelSchema.parse({
      project: { name: "Test" },
      accumulationRegisters: [
        {
          kind: "AccumulationRegister",
          name: "InventoryBalance",
          registerType: "Balance",
          recorderTypes: [{ kind: "Document", name: "Invoice" }],
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

    useDdlStore.getState().generateDdl()
    const errors = useDdlStore.getState().validationErrors
    const dimError = errors.find((e) => e.includes("не заповнені dimensions"))
    expect(dimError).toBeDefined()
    expect(dimError).toContain("product")
    expect(dimError).toContain("warehouse")
  })

  it("IR: only required dimensions reported as missing", () => {
    const model: ProjectModel = projectModelSchema.parse({
      project: { name: "Test" },
      informationRegisters: [
        {
          kind: "InformationRegister",
          name: "CurrencyRates",
          periodicity: "Day",
          recorderTypes: [{ kind: "Document", name: "RateUpdate" }],
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

    useDdlStore.getState().generateDdl()
    const errors = useDdlStore.getState().validationErrors
    const dimError = errors.find((e) =>
      e.includes("обов'язкові dimensions"),
    )
    expect(dimError).toBeDefined()
    expect(dimError).toContain("currency")
    expect(dimError).not.toContain("warehouse")
  })
})
