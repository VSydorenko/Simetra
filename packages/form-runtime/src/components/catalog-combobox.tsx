import { useState, useEffect, useCallback, useRef } from 'react'
import type { MetadataRef } from '@simetra/core'
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
} from '@workspace/ui/components/command'
import { Button } from '@workspace/ui/components/button'
import { cn } from '@workspace/ui/lib/utils'
import { useDataProvider } from '../context'

export interface CatalogComboboxProps {
  targetRef: MetadataRef
  value?: string | null
  onChange?: (value: string | null) => void
  placeholder?: string
  disabled?: boolean
}

interface RefOption {
  id: string
  display: string
}

export function CatalogCombobox({
  targetRef,
  value,
  onChange,
  placeholder = 'Оберіть...',
  disabled,
}: CatalogComboboxProps) {
  const dataProvider = useDataProvider()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [options, setOptions] = useState<RefOption[]>([])
  const [displayValue, setDisplayValue] = useState('')
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)
  // Захист від race conditions при пошуку
  const searchIdRef = useRef(0)

  // Завантажити display value при зміні value prop
  useEffect(() => {
    if (!value) {
      setDisplayValue('')
      return
    }
    let cancelled = false
    dataProvider.getRefDisplay(targetRef, value).then((display) => {
      if (!cancelled) setDisplayValue(display)
    })
    return () => {
      cancelled = true
    }
  }, [dataProvider, targetRef, value])

  const doSearch = useCallback(
    (query: string) => {
      const currentId = ++searchIdRef.current
      setLoading(true)
      dataProvider
        .searchRef(targetRef, query, { limit: 20 })
        .then((results) => {
          // Ігноруємо результат якщо вже був новіший запит
          if (currentId === searchIdRef.current) {
            setOptions(results)
          }
        })
        .finally(() => {
          if (currentId === searchIdRef.current) {
            setLoading(false)
          }
        })
    },
    [dataProvider, targetRef],
  )

  // Debounce пошук при зміні тексту
  const handleSearchChange = useCallback(
    (query: string) => {
      setSearch(query)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => doSearch(query), 300)
    },
    [doSearch],
  )

  // Початковий пошук при відкритті
  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      setOpen(isOpen)
      if (isOpen) {
        setSearch('')
        doSearch('')
      }
    },
    [doSearch],
  )

  const handleSelect = useCallback(
    (id: string) => {
      onChange?.(id)
      setOpen(false)
    },
    [onChange],
  )

  const handleClear = useCallback(() => {
    onChange?.(null)
  }, [onChange])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'w-full justify-between font-normal',
            !value && 'text-muted-foreground',
          )}
        >
          <span className="truncate">
            {value ? displayValue || value : placeholder}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full min-w-[var(--radix-popover-trigger-width)] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Пошук..."
            value={search}
            onValueChange={handleSearchChange}
          />
          <CommandList>
            <CommandEmpty>
              {loading ? 'Завантаження...' : 'Нічого не знайдено'}
            </CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.id}
                data-checked={option.id === value}
                onSelect={() => handleSelect(option.id)}
              >
                {option.display}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        {value && (
          <div className="border-t p-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={handleClear}
            >
              Очистити
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
