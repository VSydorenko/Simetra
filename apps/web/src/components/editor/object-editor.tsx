import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Badge } from "@workspace/ui/components/badge"
import { Label } from "@workspace/ui/components/label"
import { ScrollArea } from "@workspace/ui/components/scroll-area"
import { cn } from "@workspace/ui/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import { AttributeTable } from "./attribute-table"
import { EnumValuesEditor } from "./enum-values-editor"
import { TabularSectionsEditor } from "./tabular-sections-editor"
import { VerticalNav } from "./vertical-nav"
import { SECTION_CONFIG } from "./section-config"
import {
  KIND_ICONS,
  KIND_COLORS,
  KIND_BADGE_CLASSES,
} from "@/lib/metadata-icons"
import { KIND_TO_KEY } from "@/lib/metadata-defaults"
import { useMetadataStore } from "@/stores/metadata-store"
import type {
  MetadataRef,
  MetadataObject,
  Attribute,
  TabularSection,
} from "@simetra/core"

interface ObjectEditorProps {
  objectRef: MetadataRef
  activeSection: string
  onSectionChange: (section: string) => void
}

export function ObjectEditor({
  objectRef,
  activeSection,
  onSectionChange,
}: ObjectEditorProps) {
  const { t } = useTranslation()
  const model = useMetadataStore((s) => s.model)

  const object = useMemo(() => {
    const key = KIND_TO_KEY[objectRef.kind]
    const objects = model[key] as MetadataObject[]
    return objects.find((o) => o.name === objectRef.name) ?? null
  }, [model, objectRef])

  const sections = useMemo(
    () => SECTION_CONFIG[objectRef.kind],
    [objectRef.kind]
  )
  const sectionIds = useMemo(() => sections.map((s) => s.id), [sections])

  // Якщо поточна секція не в списку для цього kind — вибрати першу
  const effectiveSection = sectionIds.includes(activeSection)
    ? activeSection
    : sectionIds[0]

  if (!object) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("editor.noSelection")}
      </div>
    )
  }

  const icon = KIND_ICONS[objectRef.kind]

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Заголовок обʼєкта — readonly, редагування тільки через дерево (F2) або праву панель */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <HugeiconsIcon
          icon={icon}
          size={16}
          className={cn("shrink-0", KIND_COLORS[objectRef.kind])}
        />
        <Badge
          variant="outline"
          className={cn(
            "px-1.5 py-0 text-[10px]",
            KIND_BADGE_CLASSES[objectRef.kind]
          )}
        >
          {t(`metadata.kind.${objectRef.kind}`)}
        </Badge>
        <span className="font-mono text-sm font-medium">{object.name}</span>
        {"displayName" in object && (
          <span className="truncate text-xs text-muted-foreground">
            {(object.displayName as { uk?: string })?.uk ?? ""}
          </span>
        )}
      </div>

      {/* Вертикальна навігація + контент секції */}
      <div className="flex flex-1 overflow-hidden">
        <VerticalNav
          sections={sections}
          activeSection={effectiveSection}
          onSectionChange={onSectionChange}
        />
        <div className="flex-1 overflow-hidden">
          <SectionContent
            kind={objectRef.kind}
            objectName={objectRef.name}
            object={object}
            section={effectiveSection}
          />
        </div>
      </div>
    </div>
  )
}

/** Рендер контенту активної секції */
function SectionContent({
  kind,
  objectName,
  object,
  section,
}: {
  kind: MetadataRef["kind"]
  objectName: string
  object: MetadataObject
  section: string
}) {
  const { t } = useTranslation()

  switch (section) {
    case "main":
      return (
        <MainSectionContent
          kind={kind}
          objectName={objectName}
          object={object}
        />
      )

    case "data":
      return (
        <DataSectionContent
          kind={kind}
          objectName={objectName}
          object={object}
        />
      )

    case "values":
      return (
        <EnumValuesEditor
          objectName={objectName}
          values={
            "values" in object
              ? (object.values as {
                  name: string
                  displayName?: { uk?: string; en?: string }
                  order?: number
                }[])
              : []
          }
        />
      )

    case "numbering":
    case "movements":
    case "settings":
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {t(`metadata.section.${section}`)} — {t("editor.comingSoon")}
        </div>
      )

    default:
      return null
  }
}

/** Комбінований вигляд даних: реквізити + табличні частини або виміри + ресурси + реквізити */
function DataSectionContent({
  kind,
  objectName,
  object,
}: {
  kind: MetadataRef["kind"]
  objectName: string
  object: MetadataObject
}) {
  const isRegister =
    kind === "InformationRegister" || kind === "AccumulationRegister"

  if (isRegister) {
    return (
      <div className="flex h-full flex-col overflow-auto">
        <AttributeTable
          kind={kind}
          objectName={objectName}
          field="dimensions"
          attributes={
            "dimensions" in object ? (object.dimensions as Attribute[]) : []
          }
        />
        <AttributeTable
          kind={kind}
          objectName={objectName}
          field="resources"
          attributes={
            "resources" in object ? (object.resources as Attribute[]) : []
          }
        />
        <AttributeTable
          kind={kind}
          objectName={objectName}
          field="attributes"
          attributes={
            "attributes" in object ? (object.attributes as Attribute[]) : []
          }
        />
      </div>
    )
  }

  const hasTabularSections = kind === "Catalog" || kind === "Document"

  return (
    <div className="flex h-full flex-col overflow-auto">
      <AttributeTable
        kind={kind}
        objectName={objectName}
        field="attributes"
        attributes={
          "attributes" in object ? (object.attributes as Attribute[]) : []
        }
      />
      {hasTabularSections && (
        <TabularSectionsEditor
          kind={kind}
          objectName={objectName}
          tabularSections={
            "tabularSections" in object
              ? (object.tabularSections as TabularSection[])
              : []
          }
        />
      )}
    </div>
  )
}

/** Секція "Основні": readonly огляд displayName + description (редагування — права панель) */
function MainSectionContent({
  object,
}: {
  kind: MetadataRef["kind"]
  objectName: string
  object: MetadataObject
}) {
  const { t } = useTranslation()

  const displayName =
    "displayName" in object
      ? (object.displayName as { uk?: string; en?: string })
      : undefined
  const description =
    "description" in object ? (object.description as string) : undefined

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3">
        {displayName !== undefined && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t("editor.displayNameUk")}
              </Label>
              <span className="block text-sm">{displayName?.uk || "—"}</span>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t("editor.displayNameEn")}
              </Label>
              <span className="block text-sm">{displayName?.en || "—"}</span>
            </div>
          </>
        )}

        {description !== undefined && (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              {t("metadata.field.description")}
            </Label>
            <span className="block text-sm">{description || "—"}</span>
          </div>
        )}
      </div>
    </ScrollArea>
  )
}
