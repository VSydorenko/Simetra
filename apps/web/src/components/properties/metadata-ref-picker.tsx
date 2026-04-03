import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@workspace/ui/components/button'
import { Badge } from '@workspace/ui/components/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@workspace/ui/components/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@workspace/ui/components/command'
import { useMetadataStore } from '@/stores/metadata-store'
import { KIND_TO_KEY } from '@/lib/metadata-defaults'
import type { FieldType, MetadataKind, MetadataRef } from '@simetra/core'

/** Відповідність reference FieldType → дозволений MetadataKind */
const REF_TYPE_TO_KIND: Partial<Record<FieldType, MetadataKind>> = {
  CatalogRef: 'Catalog',
  DocumentRef: 'Document',
  EnumRef: 'Enumeration',
}

/** Дозволені kinds для multi-picker (без AnyRef — окрема логіка) */
const REFERENCEABLE_KINDS: MetadataKind[] = ['Catalog', 'Document', 'Enumeration']

/** Хук для отримання списку доступних обʼєктів за kinds */
function useAvailableObjects(allowedKinds: MetadataKind[]): MetadataRef[] {
  const model = useMetadataStore((s) => s.model)

  return useMemo(() => {
    const result: MetadataRef[] = []
    for (const kind of allowedKinds) {
      const key = KIND_TO_KEY[kind]
      const objects = model[key] as { name: string }[]
      for (const obj of objects) {
        result.push({ kind, name: obj.name })
      }
    }
    return result
  }, [model, allowedKinds])
}

// ---------------------------------------------------------------------------
// MetadataRefPicker — single-select combobox для attribute.ref
// ---------------------------------------------------------------------------

interface MetadataRefPickerProps {
  /** Поточне значення ref (імʼя цільового обʼєкта) */
  value: string | undefined
  /** FieldType для визначення дозволеного kind */
  fieldType: FieldType
  /** Callback при зміні значення */
  onChange: (value: string | undefined) => void
}

export function MetadataRefPicker({ value, fieldType, onChange }: MetadataRefPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const targetKind = REF_TYPE_TO_KIND[fieldType]
  const allowedKinds = useMemo(
    () => (targetKind ? [targetKind] : []),
    [targetKind],
  )
  const availableObjects = useAvailableObjects(allowedKinds)

  // Перевірка чи вибраний обʼєкт існує в моделі
  const targetExists = useMemo(
    () => !value || availableObjects.some((o) => o.name === value),
    [value, availableObjects],
  )

  const handleSelect = useCallback(
    (name: string) => {
      // Якщо обрали той самий — скидаємо
      onChange(name === value ? undefined : name)
      setOpen(false)
    },
    [value, onChange],
  )

  const handleClear = useCallback(() => {
    onChange(undefined)
    setOpen(false)
  }, [onChange])

  if (!targetKind) return null

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              role="combobox"
              aria-expanded={open}
              className="h-7 w-full justify-between text-xs font-normal"
            >
              <span className={value ? '' : 'text-muted-foreground'}>
                {value ?? t('refPicker.placeholder')}
              </span>
              <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
        <PopoverContent className="w-[200px] p-0" align="start">
          <Command>
            <CommandInput
              placeholder={t('refPicker.searchPlaceholder')}
              className="h-8 text-xs"
            />
            <CommandList>
              <CommandEmpty className="py-3 text-center text-xs">
                {t('refPicker.noResults')}
              </CommandEmpty>
              <CommandGroup heading={t(`metadata.kindPlural.${targetKind}`)}>
                {value && (
                  <CommandItem
                    value="__clear__"
                    onSelect={handleClear}
                    className="text-xs text-muted-foreground"
                  >
                    {t('refPicker.clear')}
                  </CommandItem>
                )}
                {availableObjects.map((ref) => (
                  <CommandItem
                    key={ref.name}
                    value={ref.name}
                    onSelect={() => handleSelect(ref.name)}
                    className="text-xs"
                  >
                    <Check
                      className={`mr-2 h-3 w-3 ${value === ref.name ? 'opacity-100' : 'opacity-0'}`}
                    />
                    {ref.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
        {value && (
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-input hover:bg-accent"
            onClick={handleClear}
            aria-label={t('refPicker.clear')}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {value && !targetExists && (
        <p className="text-[10px] text-destructive">
          {t('refPicker.targetNotFound', { name: value })}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// MetadataRefMultiPicker — multi-select combobox для owners/recorderTypes/etc.
// ---------------------------------------------------------------------------

interface MetadataRefMultiPickerProps {
  /** Поточні вибрані посилання */
  value: MetadataRef[]
  /** Дозволені kinds */
  allowedKinds: MetadataKind[]
  /** Callback при зміні */
  onChange: (refs: MetadataRef[]) => void
}

export function MetadataRefMultiPicker({
  value,
  allowedKinds,
  onChange,
}: MetadataRefMultiPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const availableObjects = useAvailableObjects(allowedKinds)

  const selectedSet = useMemo(
    () => new Set(value.map((r) => `${r.kind}/${r.name}`)),
    [value],
  )

  const toggleRef = useCallback(
    (ref: MetadataRef) => {
      const key = `${ref.kind}/${ref.name}`
      if (selectedSet.has(key)) {
        onChange(value.filter((r) => `${r.kind}/${r.name}` !== key))
      } else {
        onChange([...value, ref])
      }
    },
    [value, selectedSet, onChange],
  )

  const removeRef = useCallback(
    (ref: MetadataRef) => {
      onChange(value.filter((r) => !(r.kind === ref.kind && r.name === ref.name)))
    },
    [value, onChange],
  )

  const showKindLabel = allowedKinds.length > 1

  return (
    <div className="space-y-1.5">
      {/* Вибрані елементи як badges */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((ref) => (
            <Badge
              key={`${ref.kind}/${ref.name}`}
              variant="default"
              className="gap-1 px-1.5 py-0 text-[10px]"
            >
              {showKindLabel && (
                <span className="text-muted-foreground">
                  {t(`metadata.kind.${ref.kind}`)}:
                </span>
              )}
              {ref.name}
              <button
                type="button"
                className="ml-0.5 hover:text-destructive"
                onClick={() => removeRef(ref)}
                aria-label={t('action.delete')}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      {/* Popover combobox для додавання */}
      {availableObjects.length === 0 && value.length === 0 ? (
        <span className="text-xs text-muted-foreground">—</span>
      ) : (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            disabled={availableObjects.length === 0}
            className="h-7 w-full justify-between text-xs font-normal"
          >
            <span className="text-muted-foreground">
              {t('refPicker.addPlaceholder')}
            </span>
            <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[200px] p-0" align="start">
          <Command>
            <CommandInput
              placeholder={t('refPicker.searchPlaceholder')}
              className="h-8 text-xs"
            />
            <CommandList>
              <CommandEmpty className="py-3 text-center text-xs">
                {t('refPicker.noResults')}
              </CommandEmpty>
              {allowedKinds.map((kind) => {
                const kindObjects = availableObjects.filter((o) => o.kind === kind)
                if (kindObjects.length === 0) return null
                return (
                  <CommandGroup
                    key={kind}
                    heading={showKindLabel ? t(`metadata.kindPlural.${kind}`) : undefined}
                  >
                    {kindObjects.map((ref) => {
                      const key = `${ref.kind}/${ref.name}`
                      const isSelected = selectedSet.has(key)
                      return (
                        <CommandItem
                          key={key}
                          value={`${ref.kind} ${ref.name}`}
                          onSelect={() => toggleRef(ref)}
                          className="text-xs"
                        >
                          <Check
                            className={`mr-2 h-3 w-3 ${isSelected ? 'opacity-100' : 'opacity-0'}`}
                          />
                          {ref.name}
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                )
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// AllowedTypesMultiPicker — multi-select для AnyRef allowedTypes
// ---------------------------------------------------------------------------

interface AllowedTypesMultiPickerProps {
  value: MetadataRef[]
  onChange: (refs: MetadataRef[]) => void
}

export function AllowedTypesMultiPicker({ value, onChange }: AllowedTypesMultiPickerProps) {
  return (
    <MetadataRefMultiPicker
      value={value}
      allowedKinds={REFERENCEABLE_KINDS}
      onChange={onChange}
    />
  )
}

// ---------------------------------------------------------------------------
// Inline SVG icons — мінімальні, щоб не тягнути lucide-react залежність
// ---------------------------------------------------------------------------

function ChevronsUpDown({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m7 15 5 5 5-5" />
      <path d="m7 9 5-5 5 5" />
    </svg>
  )
}

function Check({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function X({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
