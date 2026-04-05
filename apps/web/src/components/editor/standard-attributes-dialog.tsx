import { useCallback, useEffect, useMemo, useState } from "react"
import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@workspace/ui/components/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { ScrollArea } from "@workspace/ui/components/scroll-area"
import type {
  MetadataKind,
  MetadataObject,
  LocalizedString,
  StandardAttribute,
  TabularSection,
} from "@simetra/core"
import {
  getStandardAttributes,
  getTabularSectionStandardAttributes,
} from "@simetra/core"
import { extractStandardAttributeSettings } from "@/lib/extract-settings"
import { formatTypeLabel } from "@/lib/format-type-label"
import { useMetadataStore } from "@/stores/metadata-store"

interface StandardAttributesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: MetadataKind
  objectName: string
  object: MetadataObject
  onUpdateObject: (updates: Partial<MetadataObject>) => void
  /** Якщо задано — показати стандартні реквізити табличної частини */
  tabularSectionName?: string
}

type Overrides = Record<string, { description?: LocalizedString }>

export function StandardAttributesDialog({
  open,
  onOpenChange,
  kind,
  objectName,
  object,
  onUpdateObject,
  tabularSectionName,
}: StandardAttributesDialogProps) {
  const { t } = useTranslation()

  const handleCancel = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  // key змінюється при кожному відкритті — скидає внутрішній draft
  const [revisionKey, setRevisionKey] = useState(0)
  const handleOpen = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        handleCancel()
      } else {
        setRevisionKey((k) => k + 1)
      }
    },
    [handleCancel]
  )

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="sm:max-w-2xl">
        {open && (
          <StandardAttributesDialogBody
            key={revisionKey}
            kind={kind}
            objectName={objectName}
            object={object}
            onUpdateObject={onUpdateObject}
            onCancel={handleCancel}
            tabularSectionName={tabularSectionName}
            t={t}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function StandardAttributesDialogBody({
  kind,
  objectName,
  object,
  onUpdateObject,
  onCancel,
  tabularSectionName,
  t,
}: {
  kind: MetadataKind
  objectName: string
  object: MetadataObject
  onUpdateObject: (updates: Partial<MetadataObject>) => void
  onCancel: () => void
  tabularSectionName?: string
  t: TFunction
}) {
  const { i18n } = useTranslation()
  const lang = i18n.language as "uk" | "en"
  const updateTabularSection = useMetadataStore((state) => state.updateTabularSection)

  const section = useMemo(() => {
    if (!tabularSectionName || !("tabularSections" in object)) {
      return null
    }

    return (
      (object.tabularSections as TabularSection[]).find(
        (candidate) => candidate.name === tabularSectionName,
      ) ?? null
    )
  }, [object, tabularSectionName])

  // Закрити діалог якщо секцію видалено поки він відкритий
  useEffect(() => {
    if (tabularSectionName && !section) {
      onCancel()
    }
  }, [tabularSectionName, section, onCancel])

  const attributes = useMemo(() => {
    if (tabularSectionName) {
      return getTabularSectionStandardAttributes()
    }
    const settings = extractStandardAttributeSettings(kind, object)
    return getStandardAttributes(kind, settings)
  }, [kind, object, tabularSectionName])

  const savedOverrides = useMemo(() => {
    if (section) {
      return section.standardAttributeOverrides ?? {}
    }

    return (
      ("standardAttributeOverrides" in object
        ? (object.standardAttributeOverrides as Overrides)
        : {}) ?? {}
    )
  }, [object, section])

  // Ініціалізується один раз при mount (key-reset при відкритті)
  const [draftOverrides, setDraftOverrides] = useState<Overrides>(() =>
    structuredClone(savedOverrides)
  )

  const isDirty = useMemo(() => {
    return JSON.stringify(draftOverrides) !== JSON.stringify(savedOverrides)
  }, [draftOverrides, savedOverrides])

  const handleDescriptionChange = useCallback(
    (attrName: string, locale: "uk" | "en", value: string) => {
      setDraftOverrides((prev) => {
        const current = prev[attrName]?.description ?? {}
        return {
          ...prev,
          [attrName]: {
            ...prev[attrName],
            description: { ...current, [locale]: value || undefined },
          },
        }
      })
    },
    []
  )

  const handleSave = useCallback(() => {
    if (tabularSectionName && section) {
      updateTabularSection(kind, objectName, tabularSectionName, {
        standardAttributeOverrides: draftOverrides,
      })
      onCancel()
      return
    }

    onUpdateObject({
      standardAttributeOverrides: draftOverrides,
    } as Partial<MetadataObject>)
    onCancel()
  }, [
    draftOverrides,
    kind,
    objectName,
    onCancel,
    onUpdateObject,
    section,
    tabularSectionName,
    updateTabularSection,
  ])

  const kindLabel = t(`metadata.kind.${kind}`)
  const title = tabularSectionName
    ? `${kindLabel} ${objectName} / ${tabularSectionName}: ${t("properties.standardAttributes")}`
    : `${kindLabel} ${objectName}: ${t("properties.standardAttributes")}`

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-sm">{title}</DialogTitle>
        <DialogDescription className="text-xs">
          {t("dialog.standardAttributesDescription")}
        </DialogDescription>
      </DialogHeader>
      <ScrollArea className="max-h-[60vh]">
        <Table>
          <TableHeader>
            <TableRow className="h-8">
              <TableHead className="h-8 w-[140px] px-2 text-xs font-medium">
                {t("metadata.field.name")}
              </TableHead>
              <TableHead className="h-8 w-[100px] px-2 text-xs font-medium">
                {t("metadata.field.type")}
              </TableHead>
              <TableHead className="h-8 px-2 text-xs font-medium whitespace-normal">
                {t("metadata.field.description")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {attributes.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="h-16 text-center text-xs whitespace-normal text-muted-foreground"
                >
                  {t("dialog.noStandardAttributes")}
                </TableCell>
              </TableRow>
            ) : (
              attributes.map((attr) => (
                <StandardAttributeRow
                  key={attr.name}
                  attr={attr}
                  lang={lang}
                  override={draftOverrides[attr.name]}
                  onDescriptionChange={handleDescriptionChange}
                  t={t}
                />
              ))
            )}
          </TableBody>
        </Table>
      </ScrollArea>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t("action.cancel")}
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!isDirty}>
          {t("action.save")}
        </Button>
      </DialogFooter>
    </>
  )
}

/** Рядок стандартного реквізиту з редагованим описом */
function StandardAttributeRow({
  attr,
  lang,
  override,
  onDescriptionChange,
  t,
}: {
  attr: StandardAttribute
  lang: "uk" | "en"
  override?: { description?: LocalizedString }
  onDescriptionChange: (
    attrName: string,
    locale: "uk" | "en",
    value: string
  ) => void
  t: TFunction
}) {
  const systemDescription = attr.description[lang] ?? attr.description.uk ?? ""
  const value = override?.description?.[lang] ?? ""

  return (
    <TableRow className="h-8">
      <TableCell className="px-2 py-1">
        <span className="font-mono text-xs">{attr.name}</span>
      </TableCell>
      <TableCell className="px-2 py-1">
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {formatTypeLabel(attr, t)}
        </Badge>
      </TableCell>
      <TableCell className="px-2 py-1 whitespace-normal">
        <Input
          className="h-6 text-xs"
          placeholder={systemDescription}
          value={value}
          onChange={(e) => onDescriptionChange(attr.name, lang, e.target.value)}
        />
      </TableCell>
    </TableRow>
  )
}
