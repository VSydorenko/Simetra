import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@workspace/ui/components/accordion'
import { Button } from '@workspace/ui/components/button'
import { Badge } from '@workspace/ui/components/badge'
import { ScrollArea } from '@workspace/ui/components/scroll-area'
import { AttributeTable } from './attribute-table'
import type { MetadataKind, TabularSection } from '@simetra/core'
import { useMetadataStore } from '@/stores/metadata-store'

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
    tabularSections.map((s) => s.name),
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
    [kind, objectName, removeTabularSection],
  )

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={handleAdd}>
          {t('editor.addTabularSection')}
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {tabularSections.length === 0 ? (
          <div className="flex h-20 items-center justify-center text-xs text-muted-foreground">
            {t('editor.emptyTabularSections')}
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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[10px] text-destructive hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRemove(section.name)
                    }}
                  >
                    ×
                  </Button>
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
