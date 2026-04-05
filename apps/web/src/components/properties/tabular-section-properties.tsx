import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@workspace/ui/components/accordion"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { StandardAttributesDialog } from "@/components/editor/standard-attributes-dialog"
import { KIND_TO_KEY } from "@/lib/metadata-defaults"
import { useMetadataStore, type ValidationError } from "@/stores/metadata-store"
import { type TabularSectionSelection } from "@/stores/ui-store"
import type { MetadataObject, MetadataRef, TabularSection } from "@simetra/core"

interface TabularSectionPropertiesProps {
  selection: TabularSectionSelection
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

function TabularSectionNameEditor({
  objectRef,
  currentName,
  renameTabularSection,
}: {
  objectRef: MetadataRef
  currentName: string
  renameTabularSection: (
    kind: MetadataRef['kind'],
    name: string,
    oldSectionName: string,
    newSectionName: string
  ) => ValidationError[] | null
}) {
  const [draft, setDraft] = useState(currentName)

  useEffect(() => {
    setDraft(currentName)
  }, [currentName])

  const commit = useCallback(() => {
    const trimmed = draft.trim()
    if (!trimmed || trimmed === currentName) {
      setDraft(currentName)
      return
    }

    const errors = renameTabularSection(
      objectRef.kind,
      objectRef.name,
      currentName,
      trimmed,
    )

    if (errors) {
      setDraft(currentName)
      return
    }
  }, [
    currentName,
    draft,
    objectRef,
    renameTabularSection,
  ])

  return (
    <Input
      className="h-7 font-mono text-xs"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit()
          ;(event.target as HTMLInputElement).blur()
        } else if (event.key === "Escape") {
          setDraft(currentName)
          ;(event.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

export function TabularSectionProperties({
  selection,
}: TabularSectionPropertiesProps) {
  const { t } = useTranslation()
  const model = useMetadataStore((state) => state.model)
  const renameTabularSection = useMetadataStore(
    (state) => state.renameTabularSection,
  )
  const updateTabularSection = useMetadataStore(
    (state) => state.updateTabularSection,
  )
  const [stdAttrDialogOpen, setStdAttrDialogOpen] = useState(false)

  const object = useMemo(() => {
    const key = KIND_TO_KEY[selection.objectRef.kind]
    const objects = model[key] as MetadataObject[]
    return (
      objects.find((candidate) => candidate.name === selection.objectRef.name) ??
      null
    )
  }, [model, selection.objectRef])

  const section = useMemo(() => {
    if (!object || !("tabularSections" in object)) {
      return null
    }

    return (
      (object.tabularSections as TabularSection[]).find(
        (candidate) => candidate.name === selection.tabularSectionName,
      ) ?? null
    )
  }, [object, selection.tabularSectionName])

  const displayName = section?.displayName

  const handleDisplayNameChange = useCallback(
    (locale: "uk" | "en", value: string) => {
      if (!section) {
        return
      }

      updateTabularSection(
        selection.objectRef.kind,
        selection.objectRef.name,
        section.name,
        {
          displayName: {
            ...section.displayName,
            [locale]: value || undefined,
          },
        },
      )
    },
    [section, selection.objectRef, updateTabularSection],
  )

  if (!object || !section) {
    return null
  }

  return (
    <>
      <Accordion
        type="multiple"
        defaultValue={["general"]}
        className="w-full"
      >
        <AccordionItem value="general">
          <AccordionTrigger className="px-3 py-2 text-xs font-medium">
            {t("properties.group.general")}
          </AccordionTrigger>
          <AccordionContent className="space-y-2 px-3 pb-3">
            <SettingRow label={t("metadata.field.name")}>
              <TabularSectionNameEditor
                objectRef={selection.objectRef}
                currentName={section.name}
                renameTabularSection={renameTabularSection}
              />
            </SettingRow>
            <SettingRow label={t("metadata.field.type")}>
              <Badge variant="outline" className="text-[10px]">
                {t("metadata.section.tabularSections")}
              </Badge>
            </SettingRow>
            <SettingRow label={t("editor.displayNameUk")}>
              <Input
                className="h-7 text-xs"
                value={displayName?.uk ?? ""}
                onChange={(event) =>
                  handleDisplayNameChange("uk", event.target.value)
                }
              />
            </SettingRow>
            <SettingRow label={t("editor.displayNameEn")}>
              <Input
                className="h-7 text-xs"
                value={displayName?.en ?? ""}
                onChange={(event) =>
                  handleDisplayNameChange("en", event.target.value)
                }
              />
            </SettingRow>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <div className="space-y-1 border-t border-border px-3 py-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-full text-xs"
          onClick={() => setStdAttrDialogOpen(true)}
        >
          {t("properties.standardAttributes")}
        </Button>
        <StandardAttributesDialog
          open={stdAttrDialogOpen}
          onOpenChange={setStdAttrDialogOpen}
          kind={selection.objectRef.kind}
          objectName={selection.objectRef.name}
          object={object}
          onUpdateObject={() => {}}
          tabularSectionName={section.name}
        />
      </div>
    </>
  )
}