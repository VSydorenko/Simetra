import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@workspace/ui/components/accordion"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
import { ScrollArea } from "@workspace/ui/components/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { HugeiconsIcon } from "@hugeicons/react"
import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons"
import { AttributeTable } from "./attribute-table"
import type { MetadataKind, TabularSection } from "@simetra/core"
import { useMetadataStore } from "@/stores/metadata-store"

interface TabularSectionsEditorProps {
  kind: MetadataKind
  objectName: string
  tabularSections: TabularSection[]
}

export function TabularSectionsEditor({
  kind,
  objectName,
  tabularSections,
}: TabularSectionsEditorProps) {
  const { t } = useTranslation()
  const { addTabularSection, removeTabularSection } = useMetadataStore()
  const [expandedSections, setExpandedSections] = useState<string[]>(
    tabularSections.map((s) => s.name)
  )

  const handleAdd = useCallback(() => {
    let i = 1
    const existing = new Set(tabularSections.map((s) => s.name))
    while (existing.has(`section_${i}`)) i++
    const section: TabularSection = {
      name: `section_${i}`,
      attributes: [],
    }
    addTabularSection(kind, objectName, section)
    setExpandedSections((prev) => [...prev, section.name])
  }, [kind, objectName, tabularSections, addTabularSection])

  const handleRemove = useCallback(
    (sectionName: string) => {
      removeTabularSection(kind, objectName, sectionName)
      setExpandedSections((prev) => prev.filter((s) => s !== sectionName))
    },
    [kind, objectName, removeTabularSection]
  )

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 border-b border-border px-1.5 py-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-green-600 hover:text-green-600"
              aria-label={t("editor.addTabularSection")}
              onClick={handleAdd}
            >
              <HugeiconsIcon
                icon={Add01Icon}
                strokeWidth={2}
                className="size-3.5"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("editor.addTabularSection")}
          </TooltipContent>
        </Tooltip>
      </div>

      <ScrollArea className="flex-1">
        {tabularSections.length === 0 ? (
          <div className="flex h-20 items-center justify-center text-xs text-muted-foreground">
            {t("editor.emptyTabularSections")}
          </div>
        ) : (
          <Accordion
            type="multiple"
            value={expandedSections}
            onValueChange={setExpandedSections}
            className="px-2"
          >
            {tabularSections.map((section) => (
              <AccordionItem key={section.name} value={section.name}>
                <div className="flex items-center gap-2">
                  <AccordionTrigger className="flex-1 py-1.5 text-xs hover:no-underline">
                    <div className="flex items-center gap-2">
                      <span className="font-mono">{section.name}</span>
                      <Badge variant="outline" className="px-1 py-0 text-[9px]">
                        {section.attributes.length}
                      </Badge>
                    </div>
                  </AccordionTrigger>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-destructive hover:text-destructive"
                        aria-label={t("editor.deleteTabularSection")}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleRemove(section.name)
                        }}
                      >
                        <HugeiconsIcon
                          icon={Delete02Icon}
                          strokeWidth={2}
                          className="size-3.5"
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      {t("editor.deleteTabularSection")}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <AccordionContent className="pb-2">
                  <div className="h-48 rounded border border-border">
                    <AttributeTable
                      kind={kind}
                      objectName={objectName}
                      field="attributes"
                      attributes={section.attributes}
                      tabularSectionName={section.name}
                    />
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </ScrollArea>
    </div>
  )
}
