import { describe, it, expect, beforeEach } from "vitest"
import { projectModelSchema, type ProjectModel } from "@simetra/core"
import { useMetadataStore } from "../stores/metadata-store"

describe("posting normalization — empty posting becomes undefined", () => {
  beforeEach(() => {
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
          name: "GoodsReceipt",
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
  })

  it("removeMovement normalizes empty posting to undefined", () => {
    const store = useMetadataStore.getState()
    store.removeMovement("GoodsReceipt", {
      kind: "AccumulationRegister",
      name: "InventoryBalance",
    })

    const doc = useMetadataStore
      .getState()
      .model.documents.find((d) => d.name === "GoodsReceipt")
    expect(doc).toBeDefined()
    expect((doc as Record<string, unknown>).posting).toBeUndefined()
  })

  it("removePostingValidation normalizes empty posting to undefined when last validation removed and no movements", () => {
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
          name: "GoodsReceipt",
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
      version: 2,
      objectVersions: {},
      validationErrors: {},
      modelErrors: {},
    })

    useMetadataStore.getState().removePostingValidation("GoodsReceipt", 0)
    const doc = useMetadataStore
      .getState()
      .model.documents.find((d) => d.name === "GoodsReceipt")
    expect((doc as Record<string, unknown>).posting).toBeUndefined()
  })

  it("updateObject sync normalizes empty posting when registerMovements cleared", () => {
    const store = useMetadataStore.getState()
    store.updateObject("Document", "GoodsReceipt", { registerMovements: [] })

    const doc = useMetadataStore
      .getState()
      .model.documents.find((d) => d.name === "GoodsReceipt")
    expect((doc as Record<string, unknown>).posting).toBeUndefined()
  })
})
