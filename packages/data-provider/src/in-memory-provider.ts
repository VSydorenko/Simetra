import type { MetadataRef } from '@simetra/core'
import type {
  DataProvider,
  FilterExpression,
  ListOptions,
  ListResult,
  RefOption,
} from './index'

type Row = Record<string, unknown>

/** Ключ для зовнішнього Map — ідентифікує тип об'єкта */
function refKey(ref: MetadataRef): string {
  return `${ref.kind}.${ref.name}`
}

/**
 * In-memory реалізація DataProvider для тестів, Storybook і dev preview.
 * Зберігає дані у Map без жодних зовнішніх залежностей.
 */
export class InMemoryDataProvider implements DataProvider {
  private store = new Map<string, Map<string, Row>>()
  private constants = new Map<string, unknown>()

  /** Отримує або створює колекцію для об'єкта */
  private collection(ref: MetadataRef): Map<string, Row> {
    const key = refKey(ref)
    let col = this.store.get(key)
    if (!col) {
      col = new Map<string, Row>()
      this.store.set(key, col)
    }
    return col
  }

  async list(
    objectRef: MetadataRef,
    options?: ListOptions,
  ): Promise<ListResult> {
    const col = this.collection(objectRef)
    let rows = Array.from(col.values())

    // Фільтрація
    if (options?.filters?.length) {
      rows = rows.filter((row) =>
        options.filters!.every((f) => matchFilter(row, f)),
      )
    }

    // Пошук по всіх string-полях
    if (options?.search) {
      const q = options.search.toLowerCase()
      rows = rows.filter((row) =>
        Object.values(row).some(
          (v) => typeof v === 'string' && v.toLowerCase().includes(q),
        ),
      )
    }

    // Сортування
    if (options?.sortBy) {
      const dir = options.sortDirection === 'desc' ? -1 : 1
      const field = options.sortBy
      rows.sort((a, b) => {
        const va = a[field]
        const vb = b[field]
        if (va == null && vb == null) return 0
        if (va == null) return -dir
        if (vb == null) return dir
        if (va < vb) return -dir
        if (va > vb) return dir
        return 0
      })
    }

    const total = rows.length
    const page = options?.page ?? 1
    const pageSize = options?.pageSize ?? 25
    const start = (page - 1) * pageSize
    const data = rows.slice(start, start + pageSize)

    return { data, total, page, pageSize }
  }

  async get(objectRef: MetadataRef, id: string): Promise<Row | null> {
    return this.collection(objectRef).get(id) ?? null
  }

  async create(objectRef: MetadataRef, data: Row): Promise<Row> {
    const id = crypto.randomUUID()
    const row: Row = { ...data, id }
    this.collection(objectRef).set(id, row)
    return row
  }

  async update(
    objectRef: MetadataRef,
    id: string,
    data: Partial<Row>,
  ): Promise<Row> {
    const col = this.collection(objectRef)
    const existing = col.get(id)
    if (!existing) {
      throw new Error(`Record ${id} not found in ${refKey(objectRef)}`)
    }
    const updated = { ...existing, ...data, id }
    col.set(id, updated)
    return updated
  }

  async delete(objectRef: MetadataRef, id: string): Promise<void> {
    this.collection(objectRef).delete(id)
  }

  async searchRef(
    targetRef: MetadataRef,
    query: string,
    options?: { limit?: number },
  ): Promise<RefOption[]> {
    const col = this.collection(targetRef)
    const q = query.toLowerCase()
    const limit = options?.limit ?? 10
    const results: RefOption[] = []

    for (const row of col.values()) {
      if (results.length >= limit) break
      const code = typeof row.code === 'string' ? row.code : ''
      const desc = typeof row.description === 'string' ? row.description : ''
      if (code.toLowerCase().includes(q) || desc.toLowerCase().includes(q)) {
        results.push({
          id: row.id as string,
          display: desc || code || (row.id as string),
        })
      }
    }

    return results
  }

  async getRefDisplay(targetRef: MetadataRef, id: string): Promise<string> {
    const row = this.collection(targetRef).get(id)
    if (!row) return id
    if (typeof row.description === 'string' && row.description) {
      return row.description
    }
    if (typeof row.code === 'string' && row.code) {
      return row.code
    }
    return id
  }

  async postDocument(objectRef: MetadataRef, id: string): Promise<void> {
    const col = this.collection(objectRef)
    const existing = col.get(id)
    if (!existing) {
      throw new Error(`Document ${id} not found in ${refKey(objectRef)}`)
    }
    col.set(id, { ...existing, posted: true })
  }

  async unpostDocument(objectRef: MetadataRef, id: string): Promise<void> {
    const col = this.collection(objectRef)
    const existing = col.get(id)
    if (!existing) {
      throw new Error(`Document ${id} not found in ${refKey(objectRef)}`)
    }
    col.set(id, { ...existing, posted: false })
  }

  async getConstants(): Promise<Record<string, unknown>> {
    return Object.fromEntries(this.constants)
  }

  async updateConstant(name: string, value: unknown): Promise<void> {
    this.constants.set(name, value)
  }
}

/** Перевіряє чи рядок відповідає фільтру */
function matchFilter(row: Row, filter: FilterExpression): boolean {
  const val = row[filter.field]

  switch (filter.operator) {
    case 'eq':
      return val === filter.value
    case 'neq':
      return val !== filter.value
    case 'gt':
      return (val as number) > (filter.value as number)
    case 'gte':
      return (val as number) >= (filter.value as number)
    case 'lt':
      return (val as number) < (filter.value as number)
    case 'lte':
      return (val as number) <= (filter.value as number)
    case 'like':
      return (
        typeof val === 'string' &&
        typeof filter.value === 'string' &&
        val.includes(filter.value)
      )
    case 'ilike':
      return (
        typeof val === 'string' &&
        typeof filter.value === 'string' &&
        val.toLowerCase().includes(filter.value.toLowerCase())
      )
    case 'in':
      return Array.isArray(filter.value) && filter.value.includes(val)
    case 'is':
      return val === filter.value
    default:
      return true
  }
}
