import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@workspace/ui/components/accordion'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select'
import { useMetadataStore } from '@/stores/metadata-store'
import type { Project } from '@simetra/core'

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[1fr_1fr] items-center gap-2">
      <Label className="truncate text-xs text-muted-foreground">{label}</Label>
      <div>{children}</div>
    </div>
  )
}

export function ProjectSettings() {
  const { t } = useTranslation()
  const project = useMetadataStore((s) => s.model.project)
  const updateProject = useMetadataStore((s) => s.updateProject)

  const handleUpdate = useCallback(
    (updates: Partial<Project>) => {
      updateProject(updates)
    },
    [updateProject],
  )

  return (
    <Accordion type="multiple" defaultValue={['general', 'database', 'generation']} className="w-full">
      {/* Основні */}
      <AccordionItem value="general">
        <AccordionTrigger className="px-3 py-2 text-xs font-medium">
          {t('properties.group.general')}
        </AccordionTrigger>
        <AccordionContent className="space-y-2 px-3 pb-3">
          <SettingRow label={t('project.name')}>
            <Input
              className="h-7 text-xs"
              value={project.name}
              onChange={(e) => handleUpdate({ name: e.target.value })}
            />
          </SettingRow>
          <SettingRow label={t('editor.displayNameUk')}>
            <Input
              className="h-7 text-xs"
              value={project.displayName?.uk ?? ''}
              onChange={(e) =>
                handleUpdate({
                  displayName: { ...project.displayName, uk: e.target.value || undefined },
                })
              }
            />
          </SettingRow>
          <SettingRow label={t('editor.displayNameEn')}>
            <Input
              className="h-7 text-xs"
              value={project.displayName?.en ?? ''}
              onChange={(e) =>
                handleUpdate({
                  displayName: { ...project.displayName, en: e.target.value || undefined },
                })
              }
            />
          </SettingRow>
        </AccordionContent>
      </AccordionItem>

      {/* Database */}
      <AccordionItem value="database">
        <AccordionTrigger className="px-3 py-2 text-xs font-medium">
          {t('properties.group.database')}
        </AccordionTrigger>
        <AccordionContent className="space-y-2 px-3 pb-3">
          <SettingRow label={t('properties.database.target')}>
            <Input
              className="h-7 text-xs"
              value={project.database.target}
              readOnly
              disabled
            />
          </SettingRow>
          <SettingRow label={t('properties.database.schema')}>
            <Input
              className="h-7 text-xs"
              value={project.database.schema}
              onChange={(e) =>
                handleUpdate({ database: { ...project.database, schema: e.target.value } })
              }
            />
          </SettingRow>
          <SettingRow label={t('properties.database.namingConvention')}>
            <Select
              value={project.database.namingConvention}
              onValueChange={(v) =>
                handleUpdate({
                  database: {
                    ...project.database,
                    namingConvention: v as 'snake_case' | 'camelCase',
                  },
                })
              }
            >
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="snake_case" className="text-xs">snake_case</SelectItem>
                <SelectItem value="camelCase" className="text-xs">camelCase</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </AccordionContent>
      </AccordionItem>

      {/* Generation */}
      <AccordionItem value="generation">
        <AccordionTrigger className="px-3 py-2 text-xs font-medium">
          {t('properties.group.generation')}
        </AccordionTrigger>
        <AccordionContent className="space-y-2 px-3 pb-3">
          <SettingRow label={t('properties.generation.tablePrefix')}>
            <Input
              className="h-7 text-xs"
              value={project.generation.tablePrefix}
              onChange={(e) =>
                handleUpdate({
                  generation: { ...project.generation, tablePrefix: e.target.value },
                })
              }
            />
          </SettingRow>
          <SettingRow label={t('properties.generation.enumStrategy')}>
            <Select
              value={project.generation.enumStrategy}
              onValueChange={(v) =>
                handleUpdate({
                  generation: {
                    ...project.generation,
                    enumStrategy: v as 'pgEnum' | 'lookupTable',
                  },
                })
              }
            >
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pgEnum" className="text-xs">pgEnum</SelectItem>
                <SelectItem value="lookupTable" className="text-xs">lookupTable</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow label={t('properties.generation.constantsStrategy')}>
            <Select
              value={project.generation.constantsStrategy}
              onValueChange={(v) =>
                handleUpdate({
                  generation: {
                    ...project.generation,
                    constantsStrategy: v as 'singleTable' | 'separateTables',
                  },
                })
              }
            >
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="singleTable" className="text-xs">singleTable</SelectItem>
                <SelectItem value="separateTables" className="text-xs">separateTables</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
