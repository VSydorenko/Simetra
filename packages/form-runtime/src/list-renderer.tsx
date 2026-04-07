import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from '@tanstack/react-table'
import type {
  MetadataRef,
  FormSchema,
  FormLayoutElement,
  FormFieldElement,
  Attribute,
} from '@simetra/core'
import { getStandardAttributes } from '@simetra/core'
import type { ListOptions } from '@simetra/data-provider'
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@workspace/ui/components/table'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Badge } from '@workspace/ui/components/badge'
import { useDataProvider, useMetadata } from './context'

export interface ListRendererProps {
  objectRef: MetadataRef
  formModel: FormSchema
  onRowClick?: (id: string) => void
  onCreateClick?: () => void
}

const DEFAULT_PAGE_SIZE = 25

// MetadataKind → ключ колекції в ProjectModel
const KIND_TO_COLLECTION: Record<string, string> = {
  Catalog: 'catalogs',
  Document: 'documents',
  Enumeration: 'enumerations',
  InformationRegister: 'informationRegisters',
  AccumulationRegister: 'accumulationRegisters',
  Constant: 'constants',
  CustomTable: 'customTables',
}

/** Витягнути імена колонок з FormSchema layout */
function extractListColumns(layout?: FormLayoutElement): string[] {
  if (!layout) return []
  if (layout.element === 'Group') {
    return layout.children
      .filter((c): c is FormFieldElement => c.element === 'Field')
      .map((f) => f.ref)
  }
  if (layout.element === 'Field') return [layout.ref]
  return []
}

/** Знайти metadata об'єкт з ProjectModel за ref */
function findMetadataObject(
  model: Record<string, unknown>,
  ref: MetadataRef,
): Record<string, unknown> | undefined {
  const collectionKey = KIND_TO_COLLECTION[ref.kind]
  if (!collectionKey) return undefined
  const collection = model[collectionKey] as { name: string }[] | undefined
  return collection?.find((obj) => obj.name === ref.name) as
    | Record<string, unknown>
    | undefined
}

/** Побудувати settings для getStandardAttributes */
function buildSettings(
  kind: string,
  object: Record<string, unknown>,
): Record<string, unknown> {
  switch (kind) {
    case 'Catalog':
      return {
        hierarchyType: (object.hierarchyType as string) ?? 'None',
        owners: (object.owners as unknown[]) ?? [],
      }
    case 'CustomTable':
      return {
        autoAddPrimaryKey: (object.autoAddPrimaryKey as boolean) ?? true,
      }
    default:
      return {}
  }
}

/** Форматування значення комірки за типом атрибуту */
function formatCellValue(value: unknown, type?: string): string {
  if (value == null) return ''
  if (type === 'Boolean') return ''
  if (type === 'Date' || type === 'DateTime') {
    const d = new Date(String(value))
    if (!isNaN(d.getTime())) {
      return type === 'Date'
        ? d.toLocaleDateString('uk-UA')
        : d.toLocaleString('uk-UA')
    }
  }
  return String(value)
}

/**
 * Hook для batch-резолвінгу display values для Ref-колонок.
 * Збирає всі унікальні UUID із data, резолвить через dataProvider.getRefDisplay,
 * кешує результати між page-перемиканнями.
 */
function useRefDisplayMap(
  data: Record<string, unknown>[],
  refColumns: { columnName: string; targetRef: MetadataRef }[],
  dataProvider: ReturnType<typeof useDataProvider>,
): Map<string, string> {
  const [displayMap, setDisplayMap] = useState<Map<string, string>>(new Map())
  // Глобальний кеш між page-перемиканнями
  const cacheRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    if (refColumns.length === 0 || data.length === 0) return

    let cancelled = false

    // Збираємо пари {key, targetRef, id} для яких немає кешу (з дедуплікацією)
    const seen = new Set<string>()
    const toResolve: { key: string; targetRef: MetadataRef; id: string }[] = []
    for (const { columnName, targetRef } of refColumns) {
      for (const row of data) {
        const id = row[columnName]
        if (typeof id !== 'string' || !id) continue
        const key = `${targetRef.kind}:${targetRef.name}:${id}`
        if (!cacheRef.current.has(key) && !seen.has(key)) {
          seen.add(key)
          toResolve.push({ key, targetRef, id })
        }
      }
    }

    if (toResolve.length === 0) {
      // Все вже в кеші — оновити стан
      setDisplayMap(new Map(cacheRef.current))
      return
    }

    // Резолвимо паралельно, batch не більше 50 за раз
    const resolveAll = async () => {
      const results = await Promise.allSettled(
        toResolve.map(({ key, targetRef, id }) =>
          dataProvider.getRefDisplay(targetRef, id).then((display) => ({
            key,
            display,
          })),
        ),
      )

      if (cancelled) return

      for (const result of results) {
        if (result.status === 'fulfilled') {
          cacheRef.current.set(result.value.key, result.value.display)
        }
      }
      setDisplayMap(new Map(cacheRef.current))
    }

    void resolveAll()

    return () => {
      cancelled = true
    }
  }, [data, refColumns, dataProvider])

  return displayMap
}

export function ListRenderer({
  objectRef,
  formModel,
  onRowClick,
  onCreateClick,
}: ListRendererProps) {
  const dataProvider = useDataProvider()
  const model = useMetadata()

  const [data, setData] = useState<Record<string, unknown>[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(DEFAULT_PAGE_SIZE)
  const [sortBy, setSortBy] = useState<string | undefined>()
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  // Знайти metadata об'єкт для отримання атрибутів
  const metadataObject = useMemo(
    () =>
      findMetadataObject(
        model as unknown as Record<string, unknown>,
        objectRef,
      ),
    [model, objectRef],
  )

  // Всі атрибути (стандартні + user-defined)
  const allAttributes = useMemo(() => {
    if (!metadataObject) return []
    const settings = buildSettings(objectRef.kind, metadataObject)
    const stdAttrs = getStandardAttributes(
      objectRef.kind as Parameters<typeof getStandardAttributes>[0],
      settings,
    )
    const stdAsAttrs: Attribute[] = stdAttrs.map((sa) => ({
      name: sa.name,
      type: sa.type as Attribute['type'],
      required: false,
      indexed: sa.indexed,
      unique: false,
      defaultValue: null,
      ...(sa.ref ? { ref: sa.ref as Attribute['ref'] } : {}),
      ...(sa.allowedTypes
        ? { allowedTypes: sa.allowedTypes as Attribute['allowedTypes'] }
        : {}),
    }))
    const userAttrs = (metadataObject.attributes as Attribute[]) ?? []
    return [...stdAsAttrs, ...userAttrs]
  }, [metadataObject, objectRef.kind])

  // Колонки із layout
  const columnRefs = useMemo(
    () => extractListColumns(formModel.layout),
    [formModel.layout],
  )

  // Ref-колонки для batch display resolution
  const refColumns = useMemo(() => {
    const result: { columnName: string; targetRef: MetadataRef }[] = []
    for (const colName of columnRefs) {
      const attr = allAttributes.find((a) => a.name === colName)
      if (attr?.type === 'Ref' && attr.ref) {
        result.push({ columnName: colName, targetRef: attr.ref })
      }
    }
    return result
  }, [columnRefs, allAttributes])

  // Захист від stale list-відповідей при швидкій зміні пошуку/сортування/сторінки
  const fetchIdRef = useRef(0)

  // Завантаження даних
  const fetchData = useCallback(async () => {
    const currentFetchId = ++fetchIdRef.current
    setLoading(true)
    try {
      const options: ListOptions = {
        page,
        pageSize,
        sortBy,
        sortDirection,
        search: search || undefined,
      }
      const result = await dataProvider.list(objectRef, options)
      // Ігноруємо stale відповідь
      if (currentFetchId !== fetchIdRef.current) return
      setData(result.data)
      setTotal(result.total)
    } finally {
      if (currentFetchId === fetchIdRef.current) {
        setLoading(false)
      }
    }
  }, [dataProvider, objectRef, page, pageSize, sortBy, sortDirection, search])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  // Toggle сортування при кліку на заголовок
  const handleSort = useCallback(
    (columnId: string) => {
      if (sortBy === columnId) {
        setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortBy(columnId)
        setSortDirection('asc')
      }
      setPage(1)
    },
    [sortBy],
  )

  // Визначити атрибут за ім'ям
  const findAttribute = useCallback(
    (name: string): Attribute | undefined =>
      allAttributes.find((a) => a.name === name),
    [allAttributes],
  )

  // Batch display resolution для Ref-колонок
  const refDisplayMap = useRefDisplayMap(data, refColumns, dataProvider)

  // Побудова колонок для @tanstack/react-table
  const tableColumns = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () =>
      columnRefs.map((ref): ColumnDef<Record<string, unknown>> => {
        const attr = findAttribute(ref)
        const header =
          attr?.displayName?.uk ?? attr?.displayName?.en ?? ref

        return {
          id: ref,
          header: () => (
            <button
              type="button"
              className="flex items-center gap-1 text-left font-medium"
              onClick={() => handleSort(ref)}
            >
              {header}
              {sortBy === ref && (
                <span className="text-xs">
                  {sortDirection === 'asc' ? '↑' : '↓'}
                </span>
              )}
            </button>
          ),
          cell: ({ row }) => {
            const value = row.original[ref]
            // Булеві значення — Badge
            if (attr?.type === 'Boolean') {
              return (
                <Badge variant={value ? 'default' : 'secondary'}>
                  {value ? 'Так' : 'Ні'}
                </Badge>
              )
            }
            // Ref-значення — показуємо display name замість UUID
            if (attr?.type === 'Ref' && attr.ref && typeof value === 'string') {
              const displayKey = `${attr.ref.kind}:${attr.ref.name}:${value}`
              const display = refDisplayMap.get(displayKey)
              return (
                <span className="truncate">
                  {display ?? value}
                </span>
              )
            }
            return (
              <span className="truncate">
                {formatCellValue(value, attr?.type)}
              </span>
            )
          },
        }
      }),
    [columnRefs, findAttribute, handleSort, sortBy, sortDirection, refDisplayMap],
  )

  const table = useReactTable({
    data,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
  })

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // Пошук із скиданням на першу сторінку
  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value)
      setPage(1)
    },
    [],
  )

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar: пошук + кнопка створити */}
      <div className="flex items-center gap-2">
        <Input
          placeholder="Пошук..."
          value={search}
          onChange={handleSearchChange}
          className="max-w-sm"
        />
        {onCreateClick && (
          <Button onClick={onCreateClick}>Створити</Button>
        )}
      </div>

      {/* Таблиця */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell
                  colSpan={tableColumns.length}
                  className="text-center text-muted-foreground"
                >
                  Завантаження...
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={tableColumns.length}
                  className="text-center text-muted-foreground"
                >
                  Записів не знайдено
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={onRowClick ? 'cursor-pointer hover:bg-muted/50' : ''}
                  onClick={() => {
                    const id = row.original.id as string | undefined
                    if (id && onRowClick) onRowClick(id)
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Пагінація */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          Сторінка {page} з {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Попередня
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Наступна
          </Button>
        </div>
      </div>
    </div>
  )
}
