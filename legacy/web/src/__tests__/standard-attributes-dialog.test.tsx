import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { projectModelSchema, type ProjectModel } from "@simetra/core"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import "@/i18n"
import { StandardAttributesDialog } from "../components/editor/standard-attributes-dialog"
import { TabularSectionsEditor } from "../components/editor/tabular-sections-editor"
import { useMetadataStore } from "../stores/metadata-store"

function createModel(): ProjectModel {
  return projectModelSchema.parse({
    project: { name: "TestProject" },
    catalogs: [
      {
        kind: "Catalog",
        name: "Products",
        codeLength: 9,
        codeType: "String",
        descriptionLength: 100,
        hierarchyType: "None",
        standardAttributeOverrides: {
          id: {
            description: {
              uk: "Object-level id",
              en: "Object-level id",
            },
          },
        },
        attributes: [],
        tabularSections: [
          {
            name: "items",
            standardAttributeOverrides: {
              id: {
                description: {
                  uk: "Section-level id",
                  en: "Section-level id",
                },
              },
            },
            attributes: [],
          },
        ],
      },
    ],
  })
}

function createInformationRegisterModel(): ProjectModel {
  return projectModelSchema.parse({
    project: { name: "TestProject" },
    documents: [
      {
        kind: "Document",
        name: "SalesOrder",
      },
      {
        kind: "Document",
        name: "ReturnOrder",
      },
    ],
    informationRegisters: [
      {
        kind: "InformationRegister",
        name: "SalesHistory",
        periodicity: "Month",
        writeMode: "RecorderSubordinate",
        recorderTypes: [
          { kind: "Document", name: "SalesOrder" },
          { kind: "Document", name: "ReturnOrder" },
        ],
      },
    ],
  })
}

function createCatalogWithOwnerModel(): ProjectModel {
  return projectModelSchema.parse({
    project: { name: "TestProject" },
    catalogs: [
      {
        kind: "Catalog",
        name: "Products",
        codeLength: 9,
        codeType: "String",
        descriptionLength: 100,
        hierarchyType: "None",
        owners: [{ kind: "Catalog", name: "Categories" }],
      },
    ],
  })
}

beforeEach(() => {
  useMetadataStore.getState().loadModel(createModel())
})

describe("StandardAttributesDialog", () => {
  it("для register settings показує конкретні recorder targets у type label recorder_id", () => {
    const object = createInformationRegisterModel().informationRegisters[0]

    render(
      <StandardAttributesDialog
        open={true}
        onOpenChange={vi.fn()}
        kind="InformationRegister"
        objectName="SalesHistory"
        object={object}
        onUpdateObject={vi.fn()}
      />
    )

    const recorderRow = screen.getByText("recorder_id").closest("tr")
    expect(recorderRow).not.toBeNull()
    expect(
      within(recorderRow as HTMLTableRowElement).getByText(/SalesOrder/)
    ).toBeInTheDocument()
    expect(
      within(recorderRow as HTMLTableRowElement).getByText(/ReturnOrder/)
    ).toBeInTheDocument()
  })

  it("object-level path не деградує і показує single ref target для owner_id", () => {
    const object = createCatalogWithOwnerModel().catalogs[0]

    render(
      <StandardAttributesDialog
        open={true}
        onOpenChange={vi.fn()}
        kind="Catalog"
        objectName="Products"
        object={object}
        onUpdateObject={vi.fn()}
      />
    )

    const ownerRow = screen.getByText("owner_id").closest("tr")
    expect(ownerRow).not.toBeNull()
    expect(
      within(ownerRow as HTMLTableRowElement).getByText(/Categories/)
    ).toBeInTheDocument()
  })

  it("для tabular section читає й зберігає section-level overrides без object-level save", async () => {
    const user = userEvent.setup()
    const onUpdateObject = vi.fn()
    const object = useMetadataStore.getState().model.catalogs[0]

    render(
      <StandardAttributesDialog
        open={true}
        onOpenChange={vi.fn()}
        kind="Catalog"
        objectName="Products"
        object={object}
        onUpdateObject={onUpdateObject}
        tabularSectionName="items"
      />
    )

    expect(screen.getByDisplayValue("Section-level id")).toBeInTheDocument()
    expect(
      screen.queryByDisplayValue("Object-level id")
    ).not.toBeInTheDocument()

    const lineNumberRow = screen.getByText("line_number").closest("tr")
    expect(lineNumberRow).not.toBeNull()

    const lineNumberInput = within(
      lineNumberRow as HTMLTableRowElement
    ).getByRole("textbox")
    await user.type(lineNumberInput, "Custom line number")
    await user.click(screen.getByRole("button", { name: "Зберегти" }))

    expect(onUpdateObject).not.toHaveBeenCalled()

    const updatedObject = useMetadataStore.getState().model.catalogs[0]
    expect(
      updatedObject.standardAttributeOverrides?.line_number
    ).toBeUndefined()
    expect(
      updatedObject.tabularSections[0].standardAttributeOverrides?.line_number
    ).toEqual({
      description: {
        uk: "Custom line number",
      },
    })
  })

  it("quick-access кнопка в header ТЧ відкриває dialog з tabular-section standard attrs", async () => {
    const user = userEvent.setup()
    const section =
      useMetadataStore.getState().model.catalogs[0].tabularSections

    render(
      <TooltipProvider>
        <TabularSectionsEditor
          kind="Catalog"
          objectName="Products"
          tabularSections={section}
        />
      </TooltipProvider>
    )

    await user.click(
      screen.getByRole("button", { name: "Стандартні реквізити — items" })
    )

    expect(screen.getByText("line_number")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Зберегти" })).toBeInTheDocument()
  })

  it("auto-close при stale tabularSectionName (секцію видалено)", () => {
    const onOpenChange = vi.fn()
    const object = useMetadataStore.getState().model.catalogs[0]

    render(
      <StandardAttributesDialog
        open={true}
        onOpenChange={onOpenChange}
        kind="Catalog"
        objectName="Products"
        object={object}
        onUpdateObject={vi.fn()}
        tabularSectionName="nonExistentSection"
      />
    )

    // Guard useEffect має автоматично закрити діалог
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
