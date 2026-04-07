import { useState, useEffect, useCallback } from 'react'
import type { Constant } from '@simetra/core'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Switch } from '@workspace/ui/components/switch'
import { Button } from '@workspace/ui/components/button'
import { useDataProvider } from '../context'

export interface ConstantsFormProps {
  constants: Constant[]
}

/** Отримати display label для константи */
function getDisplayLabel(c: Constant): string {
  return c.displayName?.uk ?? c.displayName?.en ?? c.name
}

export function ConstantsForm({ constants }: ConstantsFormProps) {
  const dataProvider = useDataProvider()

  const [values, setValues] = useState<Record<string, unknown>>({})
  const [initialValues, setInitialValues] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Завантаження поточних значень констант
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    dataProvider.getConstants().then((data) => {
      if (cancelled) return
      setValues(data)
      setInitialValues(data)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [dataProvider])

  const handleChange = useCallback((name: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }))
  }, [])

  // Зберегти тільки змінені константи
  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const promises: Promise<void>[] = []
      for (const c of constants) {
        if (values[c.name] !== initialValues[c.name]) {
          promises.push(dataProvider.updateConstant(c.name, values[c.name]))
        }
      }
      await Promise.all(promises)
      setInitialValues({ ...values })
    } finally {
      setSaving(false)
    }
  }, [constants, values, initialValues, dataProvider])

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        Завантаження...
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {constants.map((c) => (
        <div key={c.name} className="flex flex-col gap-1.5">
          <Label htmlFor={`const-${c.name}`}>{getDisplayLabel(c)}</Label>
          {renderControl(c, values[c.name], (v) => handleChange(c.name, v))}
        </div>
      ))}

      <div className="flex justify-end pt-4">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Збереження...' : 'Зберегти'}
        </Button>
      </div>
    </div>
  )
}

/** Рендер контролу відповідно до valueType константи */
function renderControl(
  c: Constant,
  value: unknown,
  onChange: (value: unknown) => void,
) {
  const id = `const-${c.name}`

  switch (c.valueType) {
    case 'Boolean':
      return (
        <Switch
          id={id}
          checked={Boolean(value)}
          onCheckedChange={(checked) => onChange(checked)}
        />
      )

    case 'Integer':
    case 'Numeric':
      return (
        <Input
          id={id}
          type="number"
          value={value != null ? String(value) : ''}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '') {
              onChange(null)
              return
            }
            onChange(
              c.valueType === 'Integer'
                ? parseInt(raw, 10)
                : parseFloat(raw),
            )
          }}
          className="max-w-sm"
        />
      )

    case 'Date':
      return (
        <Input
          id={id}
          type="date"
          value={value != null ? String(value) : ''}
          onChange={(e) => onChange(e.target.value || null)}
          className="max-w-sm"
        />
      )

    case 'DateTime':
      return (
        <Input
          id={id}
          type="datetime-local"
          value={value != null ? String(value) : ''}
          onChange={(e) => onChange(e.target.value || null)}
          className="max-w-sm"
        />
      )

    case 'String':
    default:
      return (
        <Input
          id={id}
          value={value != null ? String(value) : ''}
          onChange={(e) => onChange(e.target.value)}
          className="max-w-sm"
        />
      )
  }
}
