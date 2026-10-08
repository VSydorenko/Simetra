import { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@workspace/ui/components/accordion"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Checkbox } from "@workspace/ui/components/checkbox"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { HugeiconsIcon } from "@hugeicons/react"
import { PencilEdit02Icon } from "@hugeicons/core-free-icons"
import { DataTypeEditorDialog } from "@/components/editor/data-type-editor-dialog"
import { useMetadataStore, type ValidationError } from "@/stores/metadata-store"
import { useFieldUpdate, getFieldRole } from "@/hooks/use-field-update"
import { type FieldSelection } from "@/stores/ui-store"
import { KIND_TO_KEY } from "@/lib/metadata-defaults"
import {
  FIELD_TYPE_ICONS,
  KIND_ICONS,
  DEFAULT_FIELD_ICON,
} from "@/lib/metadata-icons"
import { formatTypeLabel } from "@/lib/format-type-label"
import type { Attribute, MetadataObject, ProjectModel } from "@simetra/core"

interface FieldPropertiesProps {
  selection: FieldSelection
}

function SettingRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[1fr_1fr] items-center gap-2">
      <Label className="truncate text-xs text-muted-foreground">{label}</Label>
      <div>{children}</div>
    </div>
  )
}

/** Стабільне пусте посилання — уникаємо нових [] при відсутності помилок */
const EMPTY_ERRORS: ValidationError[] = []

/** Форматує повідомлення про помилку для відображення */
function formatErrorMessage(
  message: string,
  t: (key: string, opts?: Record<string, string>) => string
): string {
  if (message.startsWith("ref:")) {
    const refPart = message.slice(4)
    const slashIdx = refPart.indexOf("/")
    if (slashIdx !== -1) {
      const kind = refPart.slice(0, slashIdx)
      const name = refPart.slice(slashIdx + 1)
      return t("validation.refNotFound", { kind, name })
    }
  }
  return message
}

/** Панель відображення помилок валідації для поля */
function FieldValidationErrors({
  errors,
  fieldName,
  tabularSectionName,
}: {
  errors: ValidationError[]
  fieldName: string
  tabularSectionName?: string
}) {
  const { t } = useTranslation()
  // Точне зіставлення за path з урахуванням ролі поля та секції
  const fieldErrors = errors.filter((e) => {
    if (!e.path) return false
    // Поле табличної частини: tabularSections.{sectionName}.{fieldName}[.*]
    if (tabularSectionName) {
      const prefix = `tabularSections.${tabularSectionName}.${fieldName}`
      return e.path === prefix || e.path.startsWith(`${prefix}.`)
    }
    // Звичайне поле (attributes, dimensions, resources) — точний збіг або sub-path
    return (
      e.path === `attributes.${fieldName}` ||
      e.path.startsWith(`attributes.${fieldName}.`) ||
      e.path === `dimensions.${fieldName}` ||
      e.path.startsWith(`dimensions.${fieldName}.`) ||
      e.path === `resources.${fieldName}` ||
      e.path.startsWith(`resources.${fieldName}.`)
    )
  })
  if (fieldErrors.length === 0) return null

  const blockingErrors = fieldErrors.filter(
    (error) => error.severity !== "warning"
  )
  const warningErrors = fieldErrors.filter(
    (error) => error.severity === "warning"
  )

  return (
    <div className="mb-2 space-y-2">
      {blockingErrors.length > 0 && (
        <div className="rounded border border-destructive/20 bg-destructive/5 px-3 py-2">
          <p className="mb-1 text-[10px] font-medium tracking-wide text-destructive uppercase">
            {t("validation.objectErrors")}
          </p>
          <ul className="space-y-0.5">
            {blockingErrors.map((err, i) => (
              <li key={i} className="text-[11px] text-destructive">
                {formatErrorMessage(err.message, t)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warningErrors.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="mb-1 text-[10px] font-medium tracking-wide text-amber-700 uppercase">
            {t("validation.warnings", { count: warningErrors.length })}
          </p>
          <ul className="space-y-0.5">
            {warningErrors.map((err, i) => (
              <li key={i} className="text-[11px] text-amber-700">
                {formatErrorMessage(err.message, t)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Знаходить атрибут за selection у відповідній колекції обʼєкта */
function findAttribute(
  object: MetadataObject,
  selection: FieldSelection
): Attribute | null {
  // Поле табличної частини
  if (selection.tabularSectionName && "tabularSections" in object) {
    const sections = object.tabularSections as {
      name: string
      attributes: Attribute[]
    }[]
    const section = sections.find(
      (s) => s.name === selection.tabularSectionName
    )
    return (
      section?.attributes.find((a) => a.name === selection.fieldName) ?? null
    )
  }

  // Атрибути
  if ("attributes" in object) {
    const attrs = object.attributes as Attribute[]
    const found = attrs.find((a) => a.name === selection.fieldName)
    if (found) return found
  }

  // Dimensions
  if ("dimensions" in object) {
    const dims = object.dimensions as Attribute[]
    const found = dims.find((a) => a.name === selection.fieldName)
    if (found) return found
  }

  // Resources
  if ("resources" in object) {
    const res = object.resources as Attribute[]
    const found = res.find((a) => a.name === selection.fieldName)
    if (found) return found
  }

  return null
}

export function FieldProperties({ selection }: FieldPropertiesProps) {
  const model = useMetadataStore((s) => s.model)
  const dispatchFieldUpdate = useFieldUpdate()

  const { kind, name: objectName } = selection.objectRef

  // Помилки валідації: два окремих примітивних селектори + useMemo
  // (уникаємо infinite loop через нові посилання на масив у single selector)
  const key = `${kind}/${objectName}`
  const mutErrors = useMetadataStore(
    (s) => s.validationErrors[key] ?? EMPTY_ERRORS
  )
  const mdlErrors = useMetadataStore((s) => s.modelErrors[key] ?? EMPTY_ERRORS)
  const objectErrors = useMemo(() => {
    if (mutErrors.length === 0 && mdlErrors.length === 0) return EMPTY_ERRORS
    const seen = new Set<string>()
    const combined: ValidationError[] = []
    for (const err of [...mutErrors, ...mdlErrors]) {
      const dedupeKey = `${err.path}:${err.message}`
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey)
        combined.push(err)
      }
    }
    return combined
  }, [mutErrors, mdlErrors])

  const object = useMemo(() => {
    const key = KIND_TO_KEY[kind]
    const objects = model[key] as MetadataObject[]
    return objects.find((o) => o.name === objectName) ?? null
  }, [model, kind, objectName])

  const attribute = useMemo(
    () => (object ? findAttribute(object, selection) : null),
    [object, selection]
  )

  const fieldRole = useMemo(
    () =>
      object
        ? getFieldRole(
            object,
            selection.fieldName,
            selection.tabularSectionName
          )
        : "attributes",
    [object, selection.fieldName, selection.tabularSectionName]
  )

  const handleUpdate = useCallback(
    (updates: Partial<Attribute>) => {
      return dispatchFieldUpdate(
        {
          kind,
          objectName,
          fieldName: selection.fieldName,
          role: fieldRole,
          tabularSectionName: selection.tabularSectionName,
        },
        updates
      )
    },
    [
      kind,
      objectName,
      selection.fieldName,
      selection.tabularSectionName,
      fieldRole,
      dispatchFieldUpdate,
    ]
  )

  if (!object || !attribute) return null

  return (
    <FieldPropertiesInner
      selection={selection}
      attribute={attribute}
      model={model}
      objectErrors={objectErrors}
      handleUpdate={handleUpdate}
    />
  )
}

function FieldPropertiesInner({
  selection,
  attribute,
  model,
  objectErrors,
  handleUpdate,
}: {
  selection: FieldSelection
  attribute: Attribute
  model: ProjectModel
  objectErrors: ValidationError[]
  handleUpdate: (updates: Partial<Attribute>) => ValidationError[] | null
}) {
  const { t } = useTranslation()
  const [typeEditorOpen, setTypeEditorOpen] = useState(false)

  return (
    <>
      <FieldValidationErrors
        errors={objectErrors}
        fieldName={selection.fieldName}
        tabularSectionName={selection.tabularSectionName}
      />
      <Accordion
        type="multiple"
        defaultValue={["general", "dataType", "constraints", "additional"]}
        className="w-full"
      >
        {/* Основні */}
        <AccordionItem value="general">
          <AccordionTrigger className="px-3 py-2 text-xs font-medium">
            {t("properties.group.general")}
          </AccordionTrigger>
          <AccordionContent className="space-y-2 px-3 pb-3">
            <SettingRow label={t("metadata.field.name")}>
              <Input
                className="h-7 font-mono text-xs"
                value={attribute.name}
                readOnly
                disabled
              />
            </SettingRow>
            <SettingRow label={t("editor.displayNameUk")}>
              <Input
                className="h-7 text-xs"
                value={attribute.displayName?.uk ?? ""}
                onChange={(e) =>
                  handleUpdate({
                    displayName: {
                      ...attribute.displayName,
                      uk: e.target.value || undefined,
                    },
                  })
                }
              />
            </SettingRow>
            <SettingRow label={t("editor.displayNameEn")}>
              <Input
                className="h-7 text-xs"
                value={attribute.displayName?.en ?? ""}
                onChange={(e) =>
                  handleUpdate({
                    displayName: {
                      ...attribute.displayName,
                      en: e.target.value || undefined,
                    },
                  })
                }
              />
            </SettingRow>
          </AccordionContent>
        </AccordionItem>

        {/* Тип даних — readonly display + тригер діалогу */}
        <AccordionItem value="dataType">
          <AccordionTrigger className="px-3 py-2 text-xs font-medium">
            {t("properties.group.dataType")}
          </AccordionTrigger>
          <AccordionContent className="space-y-2 px-3 pb-3">
            <SettingRow label={t("metadata.field.type")}>
              <div className="flex items-center gap-1">
                <TypeReadonlyDisplay attribute={attribute} />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0"
                      onClick={() => setTypeEditorOpen(true)}
                    >
                      <HugeiconsIcon
                        icon={PencilEdit02Icon}
                        size={14}
                        className="text-muted-foreground"
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {t("dataTypeEditor.editType")}
                  </TooltipContent>
                </Tooltip>
              </div>
            </SettingRow>
            <TypeParamsHint attribute={attribute} />
          </AccordionContent>
        </AccordionItem>

        {/* Обмеження */}
        <AccordionItem value="constraints">
          <AccordionTrigger className="px-3 py-2 text-xs font-medium">
            {t("properties.group.constraints")}
          </AccordionTrigger>
          <AccordionContent className="space-y-2 px-3 pb-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="field-required"
                checked={attribute.required}
                onCheckedChange={(v) => handleUpdate({ required: v === true })}
              />
              <Label htmlFor="field-required" className="text-xs">
                {t("metadata.field.required")}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="field-indexed"
                checked={attribute.indexed}
                onCheckedChange={(v) => handleUpdate({ indexed: v === true })}
              />
              <Label htmlFor="field-indexed" className="text-xs">
                {t("metadata.field.indexed")}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="field-unique"
                checked={attribute.unique}
                onCheckedChange={(v) => handleUpdate({ unique: v === true })}
              />
              <Label htmlFor="field-unique" className="text-xs">
                {t("metadata.field.unique")}
              </Label>
            </div>
            <SettingRow label={t("metadata.field.defaultValue")}>
              <Input
                className="h-7 text-xs"
                value={attribute.defaultValue ?? ""}
                onChange={(e) =>
                  handleUpdate({ defaultValue: e.target.value || null })
                }
              />
            </SettingRow>
          </AccordionContent>
        </AccordionItem>

        {/* Додатково */}
        <AccordionItem value="additional">
          <AccordionTrigger className="px-3 py-2 text-xs font-medium">
            {t("properties.group.additional")}
          </AccordionTrigger>
          <AccordionContent className="space-y-2 px-3 pb-3">
            <SettingRow label={t("metadata.field.description") + " (uk)"}>
              <Input
                className="h-7 text-xs"
                value={attribute.description?.uk ?? ""}
                onChange={(e) =>
                  handleUpdate({
                    description: {
                      ...attribute.description,
                      uk: e.target.value || undefined,
                    },
                  })
                }
              />
            </SettingRow>
            <SettingRow label={t("metadata.field.description") + " (en)"}>
              <Input
                className="h-7 text-xs"
                value={attribute.description?.en ?? ""}
                onChange={(e) =>
                  handleUpdate({
                    description: {
                      ...attribute.description,
                      en: e.target.value || undefined,
                    },
                  })
                }
              />
            </SettingRow>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <DataTypeEditorDialog
        open={typeEditorOpen}
        onOpenChange={setTypeEditorOpen}
        attribute={attribute}
        model={model}
        onSave={handleUpdate}
      />
    </>
  )
}

/** Readonly display поточного типу з іконкою */
function TypeReadonlyDisplay({ attribute }: { attribute: Attribute }) {
  const { t } = useTranslation()

  const label = formatTypeLabel(attribute, t)

  // Іконка залежить від типу
  const icon =
    attribute.type === "Ref" && attribute.ref
      ? (KIND_ICONS[attribute.ref.kind] ??
        FIELD_TYPE_ICONS.Ref ??
        DEFAULT_FIELD_ICON)
      : (FIELD_TYPE_ICONS[attribute.type] ?? DEFAULT_FIELD_ICON)

  return (
    <span className="flex items-center gap-1.5 truncate text-xs">
      <HugeiconsIcon
        icon={icon}
        size={14}
        className="shrink-0 text-muted-foreground"
      />
      <span className="truncate">{label}</span>
    </span>
  )
}

/** Readonly підказка параметрів типу під display value */
function TypeParamsHint({ attribute }: { attribute: Attribute }) {
  const { t } = useTranslation()

  if (attribute.type === "String" && attribute.length != null) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {t("properties.field.length")}: {attribute.length}
      </p>
    )
  }

  if (attribute.type === "Numeric") {
    const parts: string[] = []
    if (attribute.precision != null)
      parts.push(`${t("properties.field.precision")}: ${attribute.precision}`)
    if (attribute.scale != null)
      parts.push(`${t("properties.field.scale")}: ${attribute.scale}`)
    if (parts.length > 0) {
      return (
        <p className="text-[11px] text-muted-foreground">{parts.join(", ")}</p>
      )
    }
  }

  return null
}
