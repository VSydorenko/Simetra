import { useMemo, useCallback } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from '@tanstack/react-table'
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
import { Checkbox } from '@workspace/ui/components/checkbox'

export interface RuntimeDataTableColumn {
  name: string
  type: string
  displayName?: { uk?: string; en?: string }
}

export interface RuntimeDataTableProps {
  columns: RuntimeDataTableColumn[]
  value: Record<string, unknown>[]
  onChange: (rows: Record<string, unknown>[]) => void
  allowAdd?: boolean
  allowDelete?: boolean
  allowReorder?: boolean
}

/** Рендер клітинки за типом атрибуту */
function renderCellEditor(
  col: RuntimeDataTableColumn,
  value: unknown,
  onCellChange: (val: unknown) => void,
) {
  switch (col.type) {
    case 'Boolean':
      return (
        <Checkbox
          checked={!!value}
          onCheckedChange={(checked) => onCellChange(!!checked)}
          className="mx-auto block"
        />
      )
    case 'Integer':
      return (
        <Input
          type="number"
          step="1"
          className="h-6 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-1"
          value={value != null ? String(value) : ''}
          onChange={(e) => {
            const parsed = parseInt(e.target.value, 10)
            onCellChange(isNaN(parsed) ? null : parsed)
          }}
        />
      )
    case 'Numeric':
      return (
        <Input
          type="number"
          className="h-6 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-1"
          value={value != null ? String(value) : ''}
          onChange={(e) => {
            const parsed = parseFloat(e.target.value)
            onCellChange(isNaN(parsed) ? null : parsed)
          }}
        />
      )
    default:
      // String, Text, Date, Ref та інші — текстовий Input
      return (
        <Input
          className="h-6 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-1"
          value={String(value ?? '')}
          onChange={(e) => onCellChange(e.target.value)}
        />
      )
  }
}

export function RuntimeDataTable({
  columns,
  value,
  onChange,
  allowAdd = true,
  allowDelete = true,
}: RuntimeDataTableProps) {
  const handleCellChange = useCallback(
    (rowIndex: number, columnName: string, cellValue: unknown) => {
      const updated = value.map((row, i) =>
        i === rowIndex ? { ...row, [columnName]: cellValue } : row,
      )
      onChange(updated)
    },
    [value, onChange],
  )

  const handleAddRow = useCallback(() => {
    const emptyRow: Record<string, unknown> = {
      line_number: value.length + 1,
    }
    for (const col of columns) {
      // Значення за замовчуванням залежить від типу
      if (col.type === 'Boolean') {
        emptyRow[col.name] = false
      } else if (col.type === 'Integer' || col.type === 'Numeric') {
        emptyRow[col.name] = null
      } else {
        emptyRow[col.name] = ''
      }
    }
    onChange([...value, emptyRow])
  }, [value, onChange, columns])

  const handleDeleteRow = useCallback(
    (rowIndex: number) => {
      // Перенумерація line_number після видалення
      const updated = value
        .filter((_, i) => i !== rowIndex)
        .map((row, i) => ({ ...row, line_number: i + 1 }))
      onChange(updated)
    },
    [value, onChange],
  )

  const tableColumns = useMemo<ColumnDef<Record<string, unknown>>[]>(() => {
    const cols: ColumnDef<Record<string, unknown>>[] = [
      {
        id: 'line_number',
        header: '№',
        size: 50,
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.index + 1}</span>
        ),
      },
      ...columns.map(
        (col): ColumnDef<Record<string, unknown>> => ({
          id: col.name,
          header: col.displayName?.uk ?? col.displayName?.en ?? col.name,
          cell: ({ row }) =>
            renderCellEditor(col, row.original[col.name], (val) =>
              handleCellChange(row.index, col.name, val),
            ),
        }),
      ),
    ]

    if (allowDelete) {
      cols.push({
        id: 'actions',
        header: '',
        size: 40,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => handleDeleteRow(row.index)}
            aria-label="Видалити рядок"
          >
            ✕
          </Button>
        ),
      })
    }

    return cols
  }, [columns, allowDelete, handleCellChange, handleDeleteRow])

  const table = useReactTable({
    data: value,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <div className="space-y-2">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} style={{ width: header.getSize() }}>
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
            {table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
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
            ) : (
              <TableRow>
                <TableCell
                  colSpan={tableColumns.length}
                  className="h-16 text-center text-muted-foreground"
                >
                  Немає даних
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {allowAdd && (
        <Button variant="outline" size="sm" onClick={handleAddRow}>
          Додати рядок
        </Button>
      )}
    </div>
  )
}
