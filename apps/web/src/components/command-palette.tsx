import { useTranslation } from 'react-i18next'
import { useMemo } from 'react'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from '@workspace/ui/components/command'
import { useUiStore } from '@/stores/ui-store'
import { useMetadataStore } from '@/stores/metadata-store'
import { useProjectStore } from '@/stores/project-store'
import type { MetadataKind } from '@simetra/core'

const METADATA_KINDS: MetadataKind[] = [
  'Catalog',
  'Document',
  'Enumeration',
  'InformationRegister',
  'AccumulationRegister',
  'Constant',
  'CustomTable',
]

/** Генерує унікальне ім'я для нового обʼєкта: NewCatalog1, NewCatalog2... */
function generateName(kind: MetadataKind, existingNames: string[]): string {
  const base = `New${kind}`
  let i = 1
  while (existingNames.includes(`${base}${i}`)) i++
  return `${base}${i}`
}

export function CommandPalette() {
  const { t } = useTranslation()
  const open = useUiStore((s) => s.commandPaletteOpen)
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen)
  const model = useMetadataStore((s) => s.model)
  const selectObject = useUiStore((s) => s.selectObject)

  const close = () => setOpen(false)

  const handleSave = () => {
    close()
    void useProjectStore.getState().saveProject()
  }
  const handleExport = () => {
    close()
    void useProjectStore.getState().exportProject()
  }
  const handleUndo = () => {
    close()
    useMetadataStore.temporal.getState().undo()
  }
  const handleRedo = () => {
    close()
    useMetadataStore.temporal.getState().redo()
  }

  const handleCreateObject = (kind: MetadataKind) => {
    close()
    const { model: m, createObject } = useMetadataStore.getState()
    const kindToKey: Record<MetadataKind, keyof typeof m> = {
      Catalog: 'catalogs',
      Document: 'documents',
      Enumeration: 'enumerations',
      InformationRegister: 'informationRegisters',
      AccumulationRegister: 'accumulationRegisters',
      Constant: 'constants',
      CustomTable: 'customTables',
    }
    const existing = (m[kindToKey[kind]] as { name: string }[]).map(
      (o) => o.name,
    )
    const name = generateName(kind, existing)

    // Мінімальний обʼєкт для створення — kind + name обовʼязково
    const obj = { kind, name } as Parameters<typeof createObject>[0]
    createObject(obj)
    selectObject({ kind, name })
  }

  // Зібрати всі обʼєкти для пошуку
  const allObjects = useMemo(
    () => [
      ...model.catalogs.map((o) => ({
        kind: 'Catalog' as const,
        name: o.name,
      })),
      ...model.documents.map((o) => ({
        kind: 'Document' as const,
        name: o.name,
      })),
      ...model.enumerations.map((o) => ({
        kind: 'Enumeration' as const,
        name: o.name,
      })),
      ...model.informationRegisters.map((o) => ({
        kind: 'InformationRegister' as const,
        name: o.name,
      })),
      ...model.accumulationRegisters.map((o) => ({
        kind: 'AccumulationRegister' as const,
        name: o.name,
      })),
      ...model.constants.map((o) => ({
        kind: 'Constant' as const,
        name: o.name,
      })),
      ...model.customTables.map((o) => ({
        kind: 'CustomTable' as const,
        name: o.name,
      })),
    ],
    [model],
  )

  const handleSelectObject = (kind: MetadataKind, name: string) => {
    close()
    selectObject({ kind, name })
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={t('commandPalette.placeholder')}
      description={t('commandPalette.placeholder')}
      className="z-command-palette"
    >
      <CommandInput placeholder={t('commandPalette.placeholder')} />
      <CommandList>
        <CommandEmpty>{t('commandPalette.noResults')}</CommandEmpty>

        <CommandGroup heading={t('commandPalette.group.actions')}>
          <CommandItem onSelect={handleSave}>
            {t('action.save')}
            <CommandShortcut>Ctrl+S</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleExport}>
            {t('action.export')}
          </CommandItem>
          <CommandItem onSelect={handleUndo}>
            {t('action.undo')}
            <CommandShortcut>Ctrl+Z</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleRedo}>
            {t('action.redo')}
            <CommandShortcut>Ctrl+Shift+Z</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading={t('commandPalette.group.create')}>
          {METADATA_KINDS.map((kind) => (
            <CommandItem
              key={`create-${kind}`}
              onSelect={() => handleCreateObject(kind)}
            >
              {t('tree.addObject', { kind: t(`metadata.kind.${kind}`) })}
            </CommandItem>
          ))}
        </CommandGroup>

        {allObjects.length > 0 && (
          <CommandGroup heading={t('commandPalette.group.objects')}>
            {allObjects.map((obj) => (
              <CommandItem
                key={`${obj.kind}/${obj.name}`}
                onSelect={() => handleSelectObject(obj.kind, obj.name)}
              >
                <span className="text-muted-foreground">
                  {t(`metadata.kind.${obj.kind}`)}
                </span>
                <span className="font-mono">{obj.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
