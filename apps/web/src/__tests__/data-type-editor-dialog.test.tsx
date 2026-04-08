import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  projectModelSchema,
  type Attribute,
  type ProjectModel,
} from "@simetra/core"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import "@/i18n"
import { DataTypeEditorDialog } from "../components/editor/data-type-editor-dialog"

// --- Хелпери ---

function createModel(): ProjectModel {
  return projectModelSchema.parse({
    project: { name: "Test" },
    catalogs: [
      {
        kind: "Catalog",
        name: "Products",
        codeLength: 9,
        codeType: "String",
        descriptionLength: 100,
        hierarchyType: "None",
        attributes: [],
        tabularSections: [],
      },
      {
        kind: "Catalog",
        name: "Partners",
        codeLength: 9,
        codeType: "String",
        descriptionLength: 100,
        hierarchyType: "None",
        attributes: [],
        tabularSections: [],
      },
    ],
    documents: [
      {
        kind: "Document",
        name: "SalesOrder",
        numberLength: 11,
        numberType: "String",
        attributes: [],
        tabularSections: [],
      },
    ],
    enumerations: [
      {
        kind: "Enumeration",
        name: "PriceTypes",
        values: [{ name: "Retail" }],
      },
    ],
  })
}

function makeAttr(overrides: Partial<Attribute> = {}): Attribute {
  return {
    name: "test_field",
    type: "String",
    length: 50,
    required: false,
    indexed: false,
    unique: false,
    defaultValue: null,
    ...overrides,
  } as Attribute
}

function renderDialog(
  attribute: Attribute = makeAttr(),
  onSave = vi.fn(() => null),
  model = createModel()
) {
  const onOpenChange = vi.fn()
  const result = render(
    <TooltipProvider>
      <DataTypeEditorDialog
        open={true}
        onOpenChange={onOpenChange}
        attribute={attribute}
        model={model}
        onSave={onSave}
      />
    </TooltipProvider>
  )
  return { ...result, onSave, onOpenChange }
}

// --- Тести ---

describe("DataTypeEditorDialog", () => {
  it("рендериться з заголовком", () => {
    renderDialog()
    expect(
      screen.getByRole("heading", { name: "Редагування типу даних" })
    ).toBeInTheDocument()
  })

  it('показує кнопки "Скасувати" та "Зберегти"', () => {
    renderDialog()
    expect(screen.getByText("Скасувати")).toBeInTheDocument()
    expect(screen.getByText("Зберегти")).toBeInTheDocument()
  })

  it('кнопка "Зберегти" disabled при відкритті (isDirty = false)', () => {
    renderDialog()
    const saveBtn = screen.getByText("Зберегти")
    expect(saveBtn).toBeDisabled()
  })

  it("Cancel не викликає onSave", async () => {
    const user = userEvent.setup()
    const { onSave } = renderDialog()
    await user.click(screen.getByText("Скасувати"))
    expect(onSave).not.toHaveBeenCalled()
  })

  it("відображає поле пошуку", () => {
    renderDialog()
    expect(screen.getByPlaceholderText("Пошук типу")).toBeInTheDocument()
  })

  it('відображає чекбокс "Складений тип"', () => {
    renderDialog()
    expect(screen.getByText("Складений тип")).toBeInTheDocument()
  })

  it('показує секцію "Параметри типу"', () => {
    renderDialog()
    expect(screen.getByText("Параметри типу")).toBeInTheDocument()
  })

  it('для String показує поле "Довжина"', () => {
    renderDialog(makeAttr({ type: "String", length: 50 }))
    expect(screen.getByText("Довжина")).toBeInTheDocument()
  })

  it('для Numeric показує поля "Точність" і "Масштаб"', () => {
    renderDialog(makeAttr({ type: "Numeric", precision: 10, scale: 2 }))
    expect(screen.getByText("Точність")).toBeInTheDocument()
    expect(screen.getByText("Масштаб")).toBeInTheDocument()
  })

  it('для Boolean показує "Додаткових налаштувань немає"', () => {
    renderDialog(makeAttr({ type: "Boolean" }))
    expect(screen.getByText("Додаткових налаштувань немає")).toBeInTheDocument()
  })

  it("compound mode: чекбокс активується для атрибута з allowedTypes", () => {
    renderDialog(
      makeAttr({
        type: "Ref",
        allowedTypes: [
          { kind: "Catalog", name: "Products" },
          { kind: "Catalog", name: "Partners" },
        ],
      })
    )
    // Чекбокс "Складений тип" повинен бути checked
    const checkbox = screen.getByRole("checkbox", { name: /складений тип/i })
    expect(checkbox).toHaveAttribute("data-state", "checked")
  })

  it("isDirty стає true після зміни довжини для String", async () => {
    const user = userEvent.setup()
    renderDialog(makeAttr({ type: "String", length: 50 }))

    const lengthInput = screen.getByRole("spinbutton")
    await user.clear(lengthInput)
    await user.type(lengthInput, "100")

    const saveBtn = screen.getByText("Зберегти")
    expect(saveBtn).not.toBeDisabled()
  })

  it("Save передає type-related поля як patch", async () => {
    const user = userEvent.setup()
    const { onSave } = renderDialog(makeAttr({ type: "String", length: 50 }))

    const lengthInput = screen.getByRole("spinbutton")
    await user.clear(lengthInput)
    await user.type(lengthInput, "100")

    await user.click(screen.getByText("Зберегти"))

    expect(onSave).toHaveBeenCalledTimes(1)
    const patch = onSave.mock.calls[0][0]
    expect(patch.type).toBe("String")
    expect(patch.length).toBe(100)
    expect(patch.precision).toBeUndefined()
    expect(patch.scale).toBeUndefined()
    expect(patch.ref).toBeUndefined()
    expect(patch.allowedTypes).toBeUndefined()
  })
})
