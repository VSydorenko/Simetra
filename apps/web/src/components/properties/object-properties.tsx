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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Switch } from "@workspace/ui/components/switch"
import { Badge } from "@workspace/ui/components/badge"
import { StandardAttributesDialog } from "@/components/editor/standard-attributes-dialog"
import { AdditionalIndexesDialog } from "@/components/editor/additional-indexes-dialog"
import { FieldTypeSelect } from "@/components/editor/field-type-select"
import { MetadataRefMultiPicker } from "@/components/properties/metadata-ref-picker"
import i18n from "@/i18n"
import { validateTechnicalName } from "@/lib/validate-technical-name"
import { useMetadataStore, type ValidationError } from "@/stores/metadata-store"
import { useUiStore } from "@/stores/ui-store"
import { KIND_TO_KEY } from "@/lib/metadata-defaults"
import type {
  Attribute,
  MetadataKind,
  MetadataObject,
  MetadataRef,
  FieldType,
  LocalizedString,
} from "@simetra/core"

interface ObjectPropertiesProps {
  objectRef: MetadataRef
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
  // ref:Kind/Name — спеціальний формат для broken references
  if (message.startsWith("ref:")) {
    const refPart = message.slice(4) // видаляємо "ref:"
    const slashIdx = refPart.indexOf("/")
    if (slashIdx !== -1) {
      const kind = refPart.slice(0, slashIdx)
      const name = refPart.slice(slashIdx + 1)
      return t("validation.refNotFound", { kind, name })
    }
  }
  return message
}

/** Панель відображення помилок валідації у правій панелі */
function ValidationErrorsPanel({ errors }: { errors: ValidationError[] }) {
  const { t } = useTranslation()
  if (errors.length === 0) return null

  const blockingErrors = errors.filter((error) => error.severity !== "warning")
  const warningErrors = errors.filter((error) => error.severity === "warning")

  return (
    <div className="space-y-2 border-b border-border px-3 py-2">
      {blockingErrors.length > 0 && (
        <div className="rounded border border-destructive/20 bg-destructive/5 px-2 py-2">
          <p className="mb-1 text-[10px] font-medium tracking-wide text-destructive uppercase">
            {t("validation.objectErrors")}
          </p>
          <ul className="space-y-0.5">
            {blockingErrors.map((err, i) => (
              <li key={i} className="text-[11px] text-destructive">
                {err.path ? (
                  <span>
                    <span className="font-mono opacity-70">{err.path}: </span>
                    {formatErrorMessage(err.message, t)}
                  </span>
                ) : (
                  formatErrorMessage(err.message, t)
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warningErrors.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 px-2 py-2">
          <p className="mb-1 text-[10px] font-medium tracking-wide text-amber-700 uppercase">
            {t("validation.warnings", { count: warningErrors.length })}
          </p>
          <ul className="space-y-0.5">
            {warningErrors.map((err, i) => (
              <li key={i} className="text-[11px] text-amber-700">
                {err.path ? (
                  <span>
                    <span className="font-mono opacity-70">{err.path}: </span>
                    {formatErrorMessage(err.message, t)}
                  </span>
                ) : (
                  formatErrorMessage(err.message, t)
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function extractInlineNameError(errors: ValidationError[]): string {
  return (
    errors.find((error) => error.path === "name")?.message ??
    errors[0]?.message ??
    i18n.t("validation.renameFailed")
  )
}

function NameEditor({
  kind,
  currentName,
  renameObject,
  updateTabObjectRef,
}: {
  kind: MetadataKind
  currentName: string
  renameObject: (
    kind: MetadataKind,
    oldName: string,
    newName: string
  ) => ValidationError[] | null
  updateTabObjectRef: (oldRef: MetadataRef, newRef: MetadataRef) => void
}) {
  const [draft, setDraft] = useState(currentName)
  const [error, setError] = useState<string | null>(null)

  const commit = () => {
    const trimmed = draft.trim()

    if (trimmed === currentName) {
      setDraft(currentName)
      setError(null)
      return true
    }

    const validationError = validateTechnicalName(trimmed, "PascalCase")
    if (validationError) {
      setError(validationError)
      return false
    }

    const errors = renameObject(kind, currentName, trimmed)
    if (errors) {
      setError(extractInlineNameError(errors))
      return false
    }

    setError(null)
    updateTabObjectRef({ kind, name: currentName }, { kind, name: trimmed })
    return true
  }

  return (
    <div className="space-y-1">
      <Input
        className="h-7 font-mono text-xs"
        value={draft}
        aria-invalid={error ? "true" : "false"}
        onChange={(e) => {
          setDraft(e.target.value)
          if (error) setError(null)
        }}
        onBlur={() => {
          commit()
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (commit()) {
              ;(e.target as HTMLInputElement).blur()
            } else {
              e.preventDefault()
            }
          } else if (e.key === "Escape") {
            setDraft(currentName)
            setError(null)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  )
}

export function ObjectProperties({ objectRef }: ObjectPropertiesProps) {
  const { t } = useTranslation()
  const model = useMetadataStore((s) => s.model)
  const updateObject = useMetadataStore((s) => s.updateObject)
  const renameObject = useMetadataStore((s) => s.renameObject)
  const { updateTabObjectRef } = useUiStore()

  // Помилки валідації: два окремих примітивних селектори + useMemo
  // (уникаємо infinite loop через нові посилання на масив у single selector)
  const errKey = `${objectRef.kind}/${objectRef.name}`
  const mutErrors = useMetadataStore(
    (s) => s.validationErrors[errKey] ?? EMPTY_ERRORS
  )
  const mdlErrors = useMetadataStore(
    (s) => s.modelErrors[errKey] ?? EMPTY_ERRORS
  )
  const objectErrors = useMemo(() => {
    if (mutErrors.length === 0 && mdlErrors.length === 0) return EMPTY_ERRORS
    // Обʼєднуємо, уникаючи дублікатів за повідомленням
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
    const key = KIND_TO_KEY[objectRef.kind]
    const objects = model[key] as MetadataObject[]
    return objects.find((o) => o.name === objectRef.name) ?? null
  }, [model, objectRef])

  const handleUpdate = useCallback(
    (updates: Partial<MetadataObject>) => {
      return updateObject(objectRef.kind, objectRef.name, updates)
    },
    [objectRef.kind, objectRef.name, updateObject]
  )

  const hasStandardAttributes = !["Enumeration", "Constant"].includes(
    objectRef.kind
  )
  const [stdAttrDialogOpen, setStdAttrDialogOpen] = useState(false)
  const [indexesDialogOpen, setIndexesDialogOpen] = useState(false)

  // Індикатор: чи є кастомний опис у стандартних реквізитах
  const hasCustomDescriptions = useMemo(() => {
    if (!object || !("standardAttributeOverrides" in object)) return false
    const overrides = object.standardAttributeOverrides as
      | Record<string, { description?: LocalizedString }>
      | undefined
    if (!overrides) return false
    return Object.values(overrides).some((o) => {
      const d = o?.description
      return d && (d.uk || d.en)
    })
  }, [object])

  // Індикатор: чи є indexed на custom реквізитах
  const hasCustomIndexes = useMemo(() => {
    if (!object) return false
    const sections = ["attributes", "dimensions", "resources"] as const
    for (const section of sections) {
      if (
        section in object &&
        Array.isArray((object as Record<string, unknown>)[section])
      ) {
        for (const attr of (object as Record<string, unknown>)[
          section
        ] as Attribute[]) {
          if (attr.indexed) return true
        }
      }
    }
    return false
  }, [object])

  if (!object) return null

  const displayName =
    "displayName" in object
      ? (object.displayName as { uk?: string; en?: string } | undefined)
      : undefined

  return (
    <>
      <ValidationErrorsPanel errors={objectErrors} />
      <Accordion
        type="multiple"
        defaultValue={["general", "typeSettings"]}
        className="w-full"
      >
        {/* Група: Основні */}
        <AccordionItem value="general">
          <AccordionTrigger className="px-3 py-2 text-xs font-medium">
            {t("properties.group.general")}
          </AccordionTrigger>
          <AccordionContent className="space-y-2 px-3 pb-3">
            <SettingRow label={t("metadata.field.name")}>
              <NameEditor
                key={`${objectRef.kind}/${object.name}`}
                kind={objectRef.kind}
                currentName={object.name}
                renameObject={renameObject}
                updateTabObjectRef={updateTabObjectRef}
              />
            </SettingRow>
            <SettingRow label={t("metadata.field.type")}>
              <Badge variant="outline" className="text-[10px]">
                {t(`metadata.kind.${objectRef.kind}`)}
              </Badge>
            </SettingRow>
            <SettingRow label={t("editor.displayNameUk")}>
              <Input
                className="h-7 text-xs"
                value={displayName?.uk ?? ""}
                onChange={(e) =>
                  handleUpdate({
                    displayName: {
                      ...displayName,
                      uk: e.target.value || undefined,
                    },
                  } as Partial<MetadataObject>)
                }
              />
            </SettingRow>
            <SettingRow label={t("editor.displayNameEn")}>
              <Input
                className="h-7 text-xs"
                value={displayName?.en ?? ""}
                onChange={(e) =>
                  handleUpdate({
                    displayName: {
                      ...displayName,
                      en: e.target.value || undefined,
                    },
                  } as Partial<MetadataObject>)
                }
              />
            </SettingRow>
          </AccordionContent>
        </AccordionItem>

        {/* Група: Налаштування типу */}
        <AccordionItem value="typeSettings">
          <AccordionTrigger className="px-3 py-2 text-xs font-medium">
            {t("metadata.section.settings")}
          </AccordionTrigger>
          <AccordionContent className="space-y-2 px-3 pb-3">
            <TypeSettings
              kind={objectRef.kind}
              object={object}
              onUpdate={handleUpdate}
            />
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      {/* Посилання на діалоги (Модулі G, H) */}
      {hasStandardAttributes && (
        <div className="space-y-1 border-t border-border px-3 py-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-full text-xs"
            onClick={() => setStdAttrDialogOpen(true)}
          >
            {t("properties.standardAttributes")}
            {hasCustomDescriptions && (
              <span className="ml-1.5 inline-block size-1.5 rounded-full bg-primary" />
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-full text-xs"
            onClick={() => setIndexesDialogOpen(true)}
          >
            {t("properties.additionalIndexes")}
            {hasCustomIndexes && (
              <span className="ml-1.5 inline-block size-1.5 rounded-full bg-primary" />
            )}
          </Button>
          <StandardAttributesDialog
            open={stdAttrDialogOpen}
            onOpenChange={setStdAttrDialogOpen}
            kind={objectRef.kind}
            objectName={objectRef.name}
            object={object}
            onUpdateObject={handleUpdate}
          />
          <AdditionalIndexesDialog
            open={indexesDialogOpen}
            onOpenChange={setIndexesDialogOpen}
            kind={objectRef.kind}
            objectName={objectRef.name}
          />
        </div>
      )}
    </>
  )
}

// --- Kind-specific settings ---

function TypeSettings({
  kind,
  object,
  onUpdate,
}: {
  kind: MetadataKind
  object: MetadataObject
  onUpdate: (u: Partial<MetadataObject>) => void
}) {
  switch (kind) {
    case "Catalog":
      return <CatalogTypeSettings object={object} onUpdate={onUpdate} />
    case "Document":
      return <DocumentTypeSettings object={object} onUpdate={onUpdate} />
    case "InformationRegister":
      return <InfoRegisterTypeSettings object={object} onUpdate={onUpdate} />
    case "AccumulationRegister":
      return <AccumRegisterTypeSettings object={object} onUpdate={onUpdate} />
    case "Constant":
      return <ConstantTypeSettings object={object} onUpdate={onUpdate} />
    case "CustomTable":
      return <CustomTableTypeSettings object={object} onUpdate={onUpdate} />
    case "Enumeration":
      return <EmptySettings />
    default:
      return null
  }
}

function EmptySettings() {
  return <span className="text-xs text-muted-foreground">—</span>
}

function CatalogTypeSettings({
  object,
  onUpdate,
}: {
  object: MetadataObject
  onUpdate: (u: Partial<MetadataObject>) => void
}) {
  const { t } = useTranslation()
  const o = object as Extract<MetadataObject, { kind: "Catalog" }>

  return (
    <>
      <SettingRow label={t("metadata.setting.codeLength")}>
        <Input
          type="number"
          className="h-7 text-xs"
          value={o.codeLength}
          min={1}
          onChange={(e) =>
            onUpdate({
              codeLength: parseInt(e.target.value, 10) || 9,
            } as Partial<MetadataObject>)
          }
        />
      </SettingRow>
      <SettingRow label={t("metadata.setting.codeType")}>
        <Select
          value={o.codeType}
          onValueChange={(v) =>
            onUpdate({ codeType: v } as Partial<MetadataObject>)
          }
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="String" className="text-xs">
              String
            </SelectItem>
            <SelectItem value="Number" className="text-xs">
              Number
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label={t("metadata.setting.descriptionLength")}>
        <Input
          type="number"
          className="h-7 text-xs"
          value={o.descriptionLength}
          min={1}
          onChange={(e) =>
            onUpdate({
              descriptionLength: parseInt(e.target.value, 10) || 150,
            } as Partial<MetadataObject>)
          }
        />
      </SettingRow>
      <SettingRow label={t("metadata.setting.hierarchyType")}>
        <Select
          value={o.hierarchyType}
          onValueChange={(v) =>
            onUpdate({ hierarchyType: v } as Partial<MetadataObject>)
          }
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="None" className="text-xs">
              None
            </SelectItem>
            <SelectItem value="FoldersAndItems" className="text-xs">
              Folders & Items
            </SelectItem>
            <SelectItem value="ItemsOnly" className="text-xs">
              Items Only
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label={t("metadata.setting.autonumber")}>
        <Switch
          checked={o.autonumber}
          onCheckedChange={(v) =>
            onUpdate({ autonumber: v } as Partial<MetadataObject>)
          }
        />
      </SettingRow>
      <SettingRow label={t("metadata.setting.codeUnique")}>
        <Switch
          checked={o.codeUnique}
          onCheckedChange={(v) =>
            onUpdate({ codeUnique: v } as Partial<MetadataObject>)
          }
        />
      </SettingRow>
      <SettingRow label={t("metadata.setting.mainPresentation")}>
        <Select
          value={o.mainPresentation}
          onValueChange={(v) =>
            onUpdate({ mainPresentation: v } as Partial<MetadataObject>)
          }
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Code" className="text-xs">
              Code
            </SelectItem>
            <SelectItem value="Description" className="text-xs">
              Description
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">
          {t("properties.owners")}
        </Label>
        <MetadataRefMultiPicker
          value={o.owners}
          allowedKinds={["Catalog"]}
          onChange={(refs) =>
            onUpdate({ owners: refs } as Partial<MetadataObject>)
          }
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">
          {t("metadata.setting.predefinedItems")}
        </Label>
        <div className="space-y-1">
          {(o.predefinedItems ?? []).map((item, idx) => (
            <div key={idx} className="flex items-center gap-1">
              <Input
                className="h-7 flex-1 font-mono text-xs"
                value={item.name}
                onChange={(e) => {
                  const updated = [...(o.predefinedItems ?? [])]
                  updated[idx] = { ...updated[idx], name: e.target.value }
                  onUpdate({
                    predefinedItems: updated,
                  } as Partial<MetadataObject>)
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => {
                  const updated = (o.predefinedItems ?? []).filter(
                    (_, i) => i !== idx
                  )
                  onUpdate({
                    predefinedItems: updated,
                  } as Partial<MetadataObject>)
                }}
              >
                <span className="text-xs">✕</span>
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-full text-xs"
            onClick={() => {
              const items = o.predefinedItems ?? []
              onUpdate({
                predefinedItems: [
                  ...items,
                  { name: `Item${items.length + 1}` },
                ],
              } as Partial<MetadataObject>)
            }}
          >
            + {t("metadata.setting.predefinedItems")}
          </Button>
        </div>
      </div>
    </>
  )
}

function DocumentTypeSettings({
  object,
  onUpdate,
}: {
  object: MetadataObject
  onUpdate: (u: Partial<MetadataObject>) => void
}) {
  const { t } = useTranslation()
  const o = object as Extract<MetadataObject, { kind: "Document" }>

  return (
    <>
      <SettingRow label={t("metadata.setting.numberLength")}>
        <Input
          type="number"
          className="h-7 text-xs"
          value={o.numberLength}
          min={1}
          onChange={(e) =>
            onUpdate({
              numberLength: parseInt(e.target.value, 10) || 11,
            } as Partial<MetadataObject>)
          }
        />
      </SettingRow>
      <SettingRow label={t("metadata.setting.numberType")}>
        <Select
          value={o.numberType}
          onValueChange={(v) =>
            onUpdate({ numberType: v } as Partial<MetadataObject>)
          }
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="String" className="text-xs">
              String
            </SelectItem>
            <SelectItem value="Number" className="text-xs">
              Number
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label={t("metadata.setting.autonumber")}>
        <Switch
          checked={o.autonumber}
          onCheckedChange={(v) =>
            onUpdate({ autonumber: v } as Partial<MetadataObject>)
          }
        />
      </SettingRow>
      <SettingRow label={t("metadata.setting.numberPeriodicity")}>
        <Select
          value={o.numberPeriodicity}
          onValueChange={(v) =>
            onUpdate({ numberPeriodicity: v } as Partial<MetadataObject>)
          }
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="None" className="text-xs">
              None
            </SelectItem>
            <SelectItem value="Year" className="text-xs">
              Year
            </SelectItem>
            <SelectItem value="Quarter" className="text-xs">
              Quarter
            </SelectItem>
            <SelectItem value="Month" className="text-xs">
              Month
            </SelectItem>
            <SelectItem value="Day" className="text-xs">
              Day
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
    </>
  )
}

function InfoRegisterTypeSettings({
  object,
  onUpdate,
}: {
  object: MetadataObject
  onUpdate: (u: Partial<MetadataObject>) => void
}) {
  const { t } = useTranslation()
  const o = object as Extract<MetadataObject, { kind: "InformationRegister" }>

  return (
    <>
      <SettingRow label={t("metadata.setting.periodicity")}>
        <Select
          value={o.periodicity}
          onValueChange={(v) =>
            onUpdate({ periodicity: v } as Partial<MetadataObject>)
          }
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="NonPeriodic" className="text-xs">
              Non-periodic
            </SelectItem>
            <SelectItem value="Day" className="text-xs">
              Day
            </SelectItem>
            <SelectItem value="Month" className="text-xs">
              Month
            </SelectItem>
            <SelectItem value="Quarter" className="text-xs">
              Quarter
            </SelectItem>
            <SelectItem value="Year" className="text-xs">
              Year
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label={t("metadata.setting.writeMode")}>
        <Select
          value={o.writeMode}
          onValueChange={(v) =>
            onUpdate({ writeMode: v } as Partial<MetadataObject>)
          }
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Independent" className="text-xs">
              Independent
            </SelectItem>
            <SelectItem value="RecorderSubordinate" className="text-xs">
              Recorder Subordinate
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">
          {t("properties.recorderTypes")}
        </Label>
        <MetadataRefMultiPicker
          value={o.recorderTypes}
          allowedKinds={["Document"]}
          onChange={(refs) =>
            onUpdate({ recorderTypes: refs } as Partial<MetadataObject>)
          }
        />
      </div>
    </>
  )
}

function AccumRegisterTypeSettings({
  object,
  onUpdate,
}: {
  object: MetadataObject
  onUpdate: (u: Partial<MetadataObject>) => void
}) {
  const { t } = useTranslation()
  const o = object as Extract<MetadataObject, { kind: "AccumulationRegister" }>

  return (
    <>
      <SettingRow label={t("metadata.setting.registerType")}>
        <Select
          value={o.registerType}
          onValueChange={(v) =>
            onUpdate({ registerType: v } as Partial<MetadataObject>)
          }
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Balance" className="text-xs">
              Balance
            </SelectItem>
            <SelectItem value="Turnover" className="text-xs">
              Turnover
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">
          {t("properties.recorderTypes")}
        </Label>
        <MetadataRefMultiPicker
          value={o.recorderTypes}
          allowedKinds={["Document"]}
          onChange={(refs) =>
            onUpdate({ recorderTypes: refs } as Partial<MetadataObject>)
          }
        />
      </div>
    </>
  )
}

function ConstantTypeSettings({
  object,
  onUpdate,
}: {
  object: MetadataObject
  onUpdate: (u: Partial<MetadataObject>) => void
}) {
  const { t } = useTranslation()
  const o = object as Extract<MetadataObject, { kind: "Constant" }>

  return (
    <>
      <SettingRow label={t("metadata.setting.valueType")}>
        <FieldTypeSelect
          value={o.valueType as FieldType}
          onChange={(v) =>
            onUpdate({ valueType: v } as Partial<MetadataObject>)
          }
          excludeTypes={["Ref"]}
        />
      </SettingRow>
      <SettingRow label={t("metadata.setting.defaultValue")}>
        <Input
          className="h-7 text-xs"
          value={
            typeof o.defaultValue === "string" ||
            typeof o.defaultValue === "number"
              ? String(o.defaultValue)
              : ""
          }
          onChange={(e) =>
            onUpdate({
              defaultValue: e.target.value || null,
            } as Partial<MetadataObject>)
          }
        />
      </SettingRow>
    </>
  )
}

function CustomTableTypeSettings({
  object,
  onUpdate,
}: {
  object: MetadataObject
  onUpdate: (u: Partial<MetadataObject>) => void
}) {
  const { t } = useTranslation()
  const o = object as Extract<MetadataObject, { kind: "CustomTable" }>

  return (
    <SettingRow label={t("metadata.setting.autoAddPrimaryKey")}>
      <Switch
        checked={o.autoAddPrimaryKey}
        onCheckedChange={(v) =>
          onUpdate({ autoAddPrimaryKey: v } as Partial<MetadataObject>)
        }
      />
    </SettingRow>
  )
}
