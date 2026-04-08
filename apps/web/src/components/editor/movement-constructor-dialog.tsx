import { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { ScrollArea } from "@workspace/ui/components/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import type {
  AccumulationRegister,
  Attribute,
  Document,
  InformationRegister,
  MetadataRef,
  PostingMovement,
} from "@simetra/core"
import { getStandardAttributes } from "@simetra/core"
import { toast } from "@workspace/ui/components/sonner"
import { useMetadataStore, type ValidationError } from "@/stores/metadata-store"
import { buildExpressionOptions } from "@/lib/build-expression-options"
import {
  isExpressionInvalid,
  validateExpressionCompatibility,
  validateExpressionFields,
} from "@/lib/expression-validation"

interface MovementConstructorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  registerRef: MetadataRef
  document: Document
  existingMovement?: PostingMovement | null
  onSave: (movement: PostingMovement) => ValidationError[] | null
}

interface MovementDraft {
  movementType: string
  source: string
  condition: string | null
  mappings: {
    dimensions: Record<string, string>
    resources: Record<string, string>
    attributes: Record<string, string>
  }
}

// Ключ-маркер для вільного вводу в Select
const FREE_INPUT_SENTINEL = "__free_input__"

export function MovementConstructorDialog({
  open,
  onOpenChange,
  registerRef,
  document: doc,
  existingMovement,
  onSave,
}: MovementConstructorDialogProps) {
  const [revisionKey, setRevisionKey] = useState(0)

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (isOpen) {
        setRevisionKey((k) => k + 1)
      }
      onOpenChange(isOpen)
    },
    [onOpenChange]
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        {open && (
          <MovementConstructorBody
            key={revisionKey}
            registerRef={registerRef}
            document={doc}
            existingMovement={existingMovement}
            onSave={onSave}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MovementConstructorBody({
  registerRef,
  document: doc,
  existingMovement,
  onSave,
  onCancel,
}: {
  registerRef: MetadataRef
  document: Document
  existingMovement?: PostingMovement | null
  onSave: (movement: PostingMovement) => ValidationError[] | null
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const model = useMetadataStore((s) => s.model)

  // Знаходимо регістр у моделі
  const register = useMemo(():
    | AccumulationRegister
    | InformationRegister
    | undefined => {
    if (registerRef.kind === "AccumulationRegister") {
      return model.accumulationRegisters.find(
        (r) => r.name === registerRef.name
      )
    }
    return model.informationRegisters.find((r) => r.name === registerRef.name)
  }, [model, registerRef])

  // Ініціалізація draft з existingMovement або дефолтних значень
  const buildInitialDraft = useCallback((): MovementDraft => {
    if (existingMovement) {
      return {
        movementType: existingMovement.movementType,
        source: existingMovement.source,
        condition: existingMovement.condition ?? null,
        mappings: {
          dimensions: { ...existingMovement.mappings.dimensions },
          resources: { ...existingMovement.mappings.resources },
          attributes: { ...existingMovement.mappings.attributes },
        },
      }
    }

    // Порожні маппінги для кожного поля регістру
    const emptyMappings = {
      dimensions: {} as Record<string, string>,
      resources: {} as Record<string, string>,
      attributes: {} as Record<string, string>,
    }
    if (register) {
      for (const d of register.dimensions) emptyMappings.dimensions[d.name] = ""
      for (const r of register.resources) emptyMappings.resources[r.name] = ""
      for (const a of register.attributes) emptyMappings.attributes[a.name] = ""
    }

    return {
      movementType: "Receipt",
      source: "document",
      condition: null,
      mappings: emptyMappings,
    }
  }, [existingMovement, register])

  const [draft, setDraft] = useState<MovementDraft>(buildInitialDraft)
  const [snapshotStr] = useState(() => JSON.stringify(buildInitialDraft()))

  const isDirty = JSON.stringify(draft) !== snapshotStr

  // Оновлення окремих полів draft
  const setMovementType = useCallback((value: string) => {
    setDraft((prev) => ({ ...prev, movementType: value }))
  }, [])

  const setSource = useCallback((value: string) => {
    setDraft((prev) => ({ ...prev, source: value }))
  }, [])

  const setCondition = useCallback((value: string) => {
    setDraft((prev) => ({ ...prev, condition: value || null }))
  }, [])

  const setMapping = useCallback(
    (
      group: "dimensions" | "resources" | "attributes",
      field: string,
      value: string
    ) => {
      setDraft((prev) => ({
        ...prev,
        mappings: {
          ...prev.mappings,
          [group]: {
            ...prev.mappings[group],
            [field]: value,
          },
        },
      }))
    },
    []
  )

  // Динамічний тип руху — потребує вибору поля документа
  const isDynamicType =
    draft.movementType !== "Receipt" && draft.movementType !== "Expense"
  const dynamicTypeField = isDynamicType
    ? draft.movementType.replace("doc.", "")
    : ""

  // Поля документа для динамічного типу руху (стандартні + custom)
  const docFieldsForDynamicType = useMemo(() => {
    const standard = getStandardAttributes('Document')
      .filter((a) => a.name !== 'id')
      .map((a) => a.name)
    const custom = doc.attributes.map((a) => a.name)
    return [...standard, ...custom]
  }, [doc.attributes])

  // Джерела для Select
  const sourceOptions = useMemo(() => {
    const opts = [
      { value: "document", label: t("movements.sourceDocument") },
    ]
    for (const ts of doc.tabularSections) {
      opts.push({
        value: `tabularSection:${ts.name}`,
        label: t("movements.sourceTs", { name: ts.name }),
      })
    }
    return opts
  }, [doc.tabularSections, t])

  // Атрибути вибраної ТЧ (для валідації field references)
  const selectedTsAttributes = useMemo(() => {
    if (draft.source.startsWith('tabularSection:')) {
      const tsName = draft.source.slice('tabularSection:'.length)
      const ts = doc.tabularSections.find((t) => t.name === tsName)
      return ts?.attributes
    }
    return undefined
  }, [draft.source, doc.tabularSections])

  // Блокування Save при наявності невалідних виразів
  const hasInvalidExpressions = useMemo(() => {
    if (!register) {
      return false
    }

    const mappingsByGroup: Array<
      [keyof MovementDraft["mappings"], Attribute[]]
    > = [
      ["dimensions", register.dimensions],
      ["resources", register.resources],
      ["attributes", register.attributes],
    ]

    return mappingsByGroup.some(([groupName, fields]) =>
      fields.some((field) => {
        const expr = draft.mappings[groupName][field.name] ?? ""
        if (!expr) {
          return false
        }

        return (
          isExpressionInvalid(expr, draft.source) ||
          validateExpressionFields(
            expr,
            draft.source,
            doc.attributes,
            selectedTsAttributes,
            doc.tabularSections
          ) !== null
        )
      })
    )
  }, [
    doc.attributes,
    doc.tabularSections,
    draft.mappings,
    draft.source,
    register,
    selectedTsAttributes,
  ])

  // Save
  const handleSave = useCallback(() => {
    // Збираємо тільки непорожні маппінги
    const cleanMappings = (rec: Record<string, string>) => {
      const result: Record<string, string> = {}
      for (const [k, v] of Object.entries(rec)) {
        if (v) result[k] = v
      }
      return result
    }

    const movement: PostingMovement = {
      register: {
        kind: registerRef.kind as
          | "AccumulationRegister"
          | "InformationRegister",
        name: registerRef.name,
      },
      movementType: draft.movementType,
      source: draft.source,
      condition: draft.condition,
      mappings: {
        dimensions: cleanMappings(draft.mappings.dimensions),
        resources: cleanMappings(draft.mappings.resources),
        attributes: cleanMappings(draft.mappings.attributes),
      },
    }
    const errors = onSave(movement)
    if (errors) {
      toast.error(errors[0].message)
      return
    }
    onCancel()
  }, [draft, registerRef, onSave, onCancel])

  if (!register) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {t("movements.constructorTitle", { name: registerRef.name })}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("movements.registerNotFound")}
        </p>
      </>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t("movements.constructorTitle", { name: registerRef.name })}
        </DialogTitle>
        <DialogDescription>
          {t("metadata.kind." + registerRef.kind)}: {registerRef.name}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {/* Верхня частина — налаштування руху */}
        <div className="grid grid-cols-3 gap-3">
          {/* Тип руху */}
          <div className="space-y-1">
            <Label className="text-xs">{t("movements.movementType")}</Label>
            <Select
              value={isDynamicType ? "dynamic" : draft.movementType}
              onValueChange={(v) => {
                if (v === "dynamic") {
                  // Встановити перше доступне поле
                  const first = docFieldsForDynamicType[0] ?? ""
                  setMovementType(first ? `doc.${first}` : "Receipt")
                } else {
                  setMovementType(v)
                }
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Receipt">
                  {t("movements.receipt")}
                </SelectItem>
                <SelectItem value="Expense">
                  {t("movements.expense")}
                </SelectItem>
                <SelectItem value="dynamic">
                  {t("movements.dynamic")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Динамічне поле документа (якщо dynamic) */}
          {isDynamicType && (
            <div className="space-y-1">
              <Label className="text-xs">
                {t("movements.dynamicField")}
              </Label>
              <Select
                value={dynamicTypeField}
                onValueChange={(v) => setMovementType(`doc.${v}`)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {docFieldsForDynamicType.map((f) => (
                    <SelectItem key={f} value={f}>
                      doc.{f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Джерело */}
          <div className="space-y-1">
            <Label className="text-xs">{t("movements.source")}</Label>
            <Select value={draft.source} onValueChange={setSource}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sourceOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Умова */}
          <div className="space-y-1">
            <Label className="text-xs">
              {t("movements.condition")}
            </Label>
            <Input
              className="h-8 text-xs"
              placeholder={t("movements.condition")}
              value={draft.condition ?? ""}
              onChange={(e) => setCondition(e.target.value)}
            />
          </div>
        </div>

        {/* Таблиця маппінгу */}
        <div className="rounded-md border">
          {/* Header */}
          <div className="grid grid-cols-[180px_1fr_32px_20px] gap-2 border-b bg-muted/50 px-3 py-1.5">
            <span className="text-xs font-medium">
              {t("movements.registerField")}
            </span>
            <span className="text-xs font-medium">
              {t("movements.expression")}
            </span>
            <span />
            <span />
          </div>
          <ScrollArea className="max-h-72">
            <div className="space-y-1 p-2">
              <MappingGroup
                title={t("movements.dimensionsGroup")}
                fields={register.dimensions}
                mappings={draft.mappings.dimensions}
                group="dimensions"
                document={doc}
                source={draft.source}
                onSetMapping={setMapping}
              />
              <MappingGroup
                title={t("movements.resourcesGroup")}
                fields={register.resources}
                mappings={draft.mappings.resources}
                group="resources"
                document={doc}
                source={draft.source}
                onSetMapping={setMapping}
              />
              <MappingGroup
                title={t("movements.attributesGroup")}
                fields={register.attributes}
                mappings={draft.mappings.attributes}
                group="attributes"
                document={doc}
                source={draft.source}
                onSetMapping={setMapping}
              />
            </div>
          </ScrollArea>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t("action.cancel")}
        </Button>
        <Button size="sm" disabled={!isDirty || hasInvalidExpressions} onClick={handleSave}>
          {t("action.save")}
        </Button>
      </DialogFooter>
    </>
  )
}

// --- Група маппінгу (dimensions / resources / attributes) ---
function MappingGroup({
  title,
  fields,
  mappings,
  group,
  document,
  source,
  onSetMapping,
}: {
  title: string
  fields: Attribute[]
  mappings: Record<string, string>
  group: "dimensions" | "resources" | "attributes"
  document: Document
  source: string
  onSetMapping: (
    group: "dimensions" | "resources" | "attributes",
    field: string,
    value: string
  ) => void
}) {
  const { t } = useTranslation()
  const translate = useCallback(
    (key: string, options?: Record<string, unknown>): string => {
      return t(key, options)
    },
    [t]
  )

  if (fields.length === 0) return null

  return (
    <div>
      <h4 className="mb-1 text-xs font-medium text-muted-foreground">
        {title}
      </h4>
      <div className="space-y-1">
        {fields.map((field) => (
          <MappingRow
            key={field.name}
            targetField={field}
            value={mappings[field.name] ?? ""}
            document={document}
            source={source}
            onChange={(v) => onSetMapping(group, field.name, v)}
            t={translate}
          />
        ))}
      </div>
    </div>
  )
}

// --- Рядок маппінгу ---
function MappingRow({
  targetField,
  value,
  document,
  source,
  onChange,
  t,
}: {
  targetField: Attribute
  value: string
  document: Document
  source: string
  onChange: (value: string) => void
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  const expressionGroups = useMemo(
    () => buildExpressionOptions(document, source, targetField, t),
    [document, source, targetField, t]
  )

  // Чи ввід ручний — якщо значення не серед опцій Select
  const allSelectValues = useMemo(() => {
    const vals = new Set<string>()
    for (const g of expressionGroups) {
      for (const o of g.options) {
        if (o.value) vals.add(o.value)
      }
    }
    return vals
  }, [expressionGroups])

  // forceManual — юзер явно увімкнув ручний режим
  const [forceManual, setForceManual] = useState(false)

  // manualMode — computed: або юзер увімкнув, або значення відсутнє серед опцій
  const manualMode = forceManual || (!!value && !allSelectValues.has(value))

  const selectedTsAttributes = useMemo(() => {
    if (!source.startsWith("tabularSection:")) {
      return undefined
    }

    const tsName = source.slice("tabularSection:".length)
    return document.tabularSections.find((ts) => ts.name === tsName)?.attributes
  }, [document.tabularSections, source])

  const errorMessage = useMemo(() => {
    if (!value) {
      return null
    }

    if (isExpressionInvalid(value, source)) {
      return t("movements.invalidExpression")
    }

    return validateExpressionFields(
      value,
      source,
      document.attributes,
      selectedTsAttributes,
      document.tabularSections
    )
  }, [
    document.attributes,
    document.tabularSections,
    selectedTsAttributes,
    source,
    t,
    value,
  ])

  const warningMessage = useMemo(() => {
    if (!value || errorMessage) {
      return null
    }

    return validateExpressionCompatibility(value, targetField, {
      source,
      document,
    })
  }, [document, errorMessage, source, targetField, value])

  const handleSelectChange = useCallback(
    (v: string) => {
      if (v === FREE_INPUT_SENTINEL) {
        setForceManual(true)
        return
      }
      setForceManual(false)
      onChange(v)
    },
    [onChange]
  )

  return (
    <div className="space-y-1 px-1">
      <div className="grid grid-cols-[180px_1fr_32px_20px] items-center gap-2">
        <span className="truncate font-mono text-xs">{targetField.name}</span>
        {manualMode ? (
          <Input
            className={`h-7 font-mono text-xs ${
              errorMessage
                ? "border-destructive"
                : warningMessage
                  ? "border-amber-500"
                  : ""
            }`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t("movements.manualInput")}
          />
        ) : (
          <Select value={value || undefined} onValueChange={handleSelectChange}>
            <SelectTrigger
              className={`h-7 text-xs ${
                errorMessage
                  ? "border-destructive"
                  : warningMessage
                    ? "border-amber-500"
                    : ""
              }`}
            >
              <SelectValue placeholder={t("movements.selectExpression")} />
            </SelectTrigger>
            <SelectContent>
              {expressionGroups.map((g) => (
                <SelectGroup key={g.group}>
                  <SelectLabel>{g.group}</SelectLabel>
                  {g.options.map((o) =>
                    o.value ? (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ) : null
                  )}
                </SelectGroup>
              ))}
              <SelectGroup>
                <SelectItem value={FREE_INPUT_SENTINEL}>
                  {t("movements.manualInput")}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0"
          title={
            manualMode
              ? t("movements.selectExpression")
              : t("movements.manualInput")
          }
          onClick={() => setForceManual((prev) => !prev)}
        >
          <span className="text-xs">{manualMode ? "▼" : "✎"}</span>
        </Button>
        {errorMessage ? (
          <span className="text-xs text-destructive" title={errorMessage}>
            ⚠
          </span>
        ) : warningMessage ? (
          <span className="text-xs text-amber-500" title={warningMessage}>
            !
          </span>
        ) : (
          <span />
        )}
      </div>
      {errorMessage ? (
        <p className="pl-[188px] text-[11px] text-destructive">
          {errorMessage}
        </p>
      ) : warningMessage ? (
        <p className="pl-[188px] text-[11px] text-amber-600">
          {warningMessage}
        </p>
      ) : null}
    </div>
  )
}
