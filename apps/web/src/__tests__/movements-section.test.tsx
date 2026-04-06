import { beforeEach, describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { projectModelSchema, type ProjectModel } from "@simetra/core"
import "@/i18n"
import { MovementsSection } from "../components/editor/movements-section"
import { useMetadataStore } from "../stores/metadata-store"

function createDocModel(): ProjectModel {
  return projectModelSchema.parse({
    project: { name: "Test" },
    accumulationRegisters: [
      {
        kind: "AccumulationRegister",
        name: "InventoryBalance",
        registerType: "Balance",
        dimensions: [
          {
            name: "warehouse",
            type: "Ref",
            ref: { kind: "Catalog", name: "Warehouses" },
          },
        ],
        resources: [
          { name: "quantity", type: "Numeric", precision: 15, scale: 3 },
        ],
      },
    ],
    documents: [
      {
        kind: "Document",
        name: "GoodsReceipt",
        attributes: [
          {
            name: "warehouse",
            type: "Ref",
            ref: { kind: "Catalog", name: "Warehouses" },
          },
        ],
        tabularSections: [
          {
            name: "items",
            attributes: [
              { name: "quantity", type: "Numeric", precision: 15, scale: 3 },
            ],
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
                dimensions: {
                  warehouse: "doc.warehouse",
                },
                resources: {
                  quantity: "row.quantity",
                },
              },
            },
          ],
          validations: [],
        },
      },
    ],
  })
}

function createDocWithoutMovements(): ProjectModel {
  return projectModelSchema.parse({
    project: { name: "Test" },
    documents: [
      {
        kind: "Document",
        name: "Payment",
        attributes: [
          { name: "amount", type: "Numeric", precision: 15, scale: 2 },
        ],
        tabularSections: [],
      },
    ],
  })
}

beforeEach(() => {
  useMetadataStore.getState().loadModel(createDocModel())
})

describe("MovementsSection", () => {
  it("рендерить таблицю з назвою регістру при наявних рухах", () => {
    const doc = createDocModel().documents[0]

    render(
      <MovementsSection
        kind="Document"
        objectName="GoodsReceipt"
        object={doc}
      />,
    )

    // Назва регістру відображається у таблиці
    expect(screen.getByText("InventoryBalance")).toBeInTheDocument()
  })

  it('показує "Немає регістрів" коли registerMovements порожній', () => {
    const model = createDocWithoutMovements()
    useMetadataStore.getState().loadModel(model)
    const doc = model.documents[0]

    render(
      <MovementsSection
        kind="Document"
        objectName="Payment"
        object={doc}
      />,
    )

    // Текст про відсутність регістрів (з i18n fallback)
    expect(
      screen.getByText(/Немає регістрів/i),
    ).toBeInTheDocument()
  })

  it('має кнопку "Додати"', () => {
    const doc = createDocModel().documents[0]

    render(
      <MovementsSection
        kind="Document"
        objectName="GoodsReceipt"
        object={doc}
      />,
    )

    // Кнопка додавання регістрів
    const addButtons = screen.getAllByRole("button")
    const addBtn = addButtons.find(
      (btn) => btn.textContent?.includes("Додати") || btn.textContent?.includes("Add"),
    )
    expect(addBtn).toBeDefined()
  })
})
