import type { MetadataRef } from '@simetra/core'
import type {
  DataProvider,
  ListOptions,
  ListResult,
  RefOption,
  FilterExpression,
} from '@simetra/data-provider'
import { tableName, toSnakeCase } from '@simetra/generator-pg'

/** Конфігурація підключення до PostgREST / Supabase */
export interface PostgRestConfig {
  /** PostgREST base URL, наприклад http://localhost:3000 */
  url: string
  /**
   * Supabase project publishable key або legacy anon key.
   * Account token з dashboard/account/tokens тут не підходить.
   */
  anonKey?: string
  /** SQL table prefix (наприклад "app_"), передається в tableName() */
  tablePrefix?: string
}

/**
 * PostgREST / Supabase адаптер для DataProvider.
 * Використовує generic fetch — не залежить від @supabase/supabase-js.
 */
export class PostgRestDataProvider implements DataProvider {
  private readonly config: PostgRestConfig

  constructor(config: PostgRestConfig) {
    this.config = config
  }

  async list(
    objectRef: MetadataRef,
    options?: ListOptions,
  ): Promise<ListResult> {
    const table = this.resolveTable(objectRef)
    const page = options?.page ?? 1
    const pageSize = options?.pageSize ?? 25
    const offset = (page - 1) * pageSize

    const params = new URLSearchParams()
    params.set('select', '*')

    // Сортування
    const sortBy = options?.sortBy ?? 'id'
    const sortDir = options?.sortDirection ?? 'asc'
    params.set('order', `${sortBy}.${sortDir}`)

    // Пагінація
    params.set('limit', String(pageSize))
    params.set('offset', String(offset))

    // Пошук по presentation-полях (залежить від kind об'єкта)
    if (options?.search) {
      const q = options.search
      const searchFields = getPresentationFields(objectRef.kind)
      const conditions = searchFields
        .map((f) => `${f}.ilike.*${q}*`)
        .join(',')
      params.set('or', `(${conditions})`)
    }

    // Фільтри
    if (options?.filters) {
      for (const f of options.filters) {
        params.set(f.field, formatFilter(f))
      }
    }

    const url = `${this.config.url}/${table}?${params.toString()}`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        ...this.baseHeaders(),
        'Prefer': 'count=exact',
      },
    })

    this.assertOk(res)

    const data = (await res.json()) as Record<string, unknown>[]
    const total = parseContentRange(
      res.headers.get('Content-Range'),
    )

    return { data, total, page, pageSize }
  }

  async get(
    objectRef: MetadataRef,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const table = this.resolveTable(objectRef)
    const url = `${this.config.url}/${table}?id=eq.${id}`

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        ...this.baseHeaders(),
        'Accept': 'application/vnd.pgrst.object+json',
      },
    })

    // PostgREST повертає 406 якщо запис не знайдено
    if (res.status === 406) return null

    this.assertOk(res)
    return (await res.json()) as Record<string, unknown>
  }

  async create(
    objectRef: MetadataRef,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const table = this.resolveTable(objectRef)
    const url = `${this.config.url}/${table}`

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.baseHeaders(),
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(data),
    })

    this.assertOk(res)
    const rows = (await res.json()) as Record<string, unknown>[]
    return rows[0]
  }

  async update(
    objectRef: MetadataRef,
    id: string,
    data: Partial<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const table = this.resolveTable(objectRef)
    const url = `${this.config.url}/${table}?id=eq.${id}`

    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        ...this.baseHeaders(),
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(data),
    })

    this.assertOk(res)
    const rows = (await res.json()) as Record<string, unknown>[]
    return rows[0]
  }

  async delete(
    objectRef: MetadataRef,
    id: string,
  ): Promise<void> {
    const table = this.resolveTable(objectRef)
    const url = `${this.config.url}/${table}?id=eq.${id}`

    const res = await fetch(url, {
      method: 'DELETE',
      headers: this.baseHeaders(),
    })

    this.assertOk(res)
  }

  async searchRef(
    targetRef: MetadataRef,
    query: string,
    options?: { limit?: number },
  ): Promise<RefOption[]> {
    const table = this.resolveTable(targetRef)
    const limit = options?.limit ?? 20
    const encoded = encodeURIComponent(query)

    const searchFields = getPresentationFields(targetRef.kind)
    const conditions = searchFields
      .map((f) => `${f}.ilike.*${encoded}*`)
      .join(',')
    const selectFields = ['id', ...searchFields].join(',')
    const url =
      `${this.config.url}/${table}` +
      `?or=(${conditions})` +
      `&limit=${limit}` +
      `&select=${selectFields}`

    const res = await fetch(url, {
      method: 'GET',
      headers: this.baseHeaders(),
    })

    this.assertOk(res)
    const rows = (await res.json()) as Record<string, unknown>[]

    return rows.map((r) => ({
      id: String(r.id),
      display: formatRefDisplay(r),
    }))
  }

  async getRefDisplay(
    targetRef: MetadataRef,
    id: string,
  ): Promise<string> {
    const table = this.resolveTable(targetRef)
    const selectFields = getPresentationFields(targetRef.kind).join(',')
    const url =
      `${this.config.url}/${table}?id=eq.${id}&select=${selectFields}`

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        ...this.baseHeaders(),
        'Accept': 'application/vnd.pgrst.object+json',
      },
    })

    // Fallback на id якщо запис не знайдено
    if (res.status === 406) return id

    this.assertOk(res)
    const row = (await res.json()) as Record<string, unknown>
    return formatRefDisplay(row) || id
  }

  async postDocument(
    objectRef: MetadataRef,
    id: string,
  ): Promise<void> {
    const rpcName = `post_${toSnakeCase(objectRef.name)}`
    const url = `${this.config.url}/rpc/${rpcName}`

    const res = await fetch(url, {
      method: 'POST',
      headers: this.baseHeaders(),
      body: JSON.stringify({ p_doc_id: id }),
    })

    this.assertOk(res)
  }

  async unpostDocument(
    objectRef: MetadataRef,
    id: string,
  ): Promise<void> {
    const rpcName = `unpost_${toSnakeCase(objectRef.name)}`
    const url = `${this.config.url}/rpc/${rpcName}`

    const res = await fetch(url, {
      method: 'POST',
      headers: this.baseHeaders(),
      body: JSON.stringify({ p_doc_id: id }),
    })

    this.assertOk(res)
  }

  async getConstants(): Promise<Record<string, unknown>> {
    const table = this.resolveConstantsTable()
    const url = `${this.config.url}/${table}`

    const res = await fetch(url, {
      method: 'GET',
      headers: this.baseHeaders(),
    })

    this.assertOk(res)
    const rows = (await res.json()) as {
      key: string
      value: unknown
    }[]

    const result: Record<string, unknown> = {}
    for (const row of rows) {
      result[row.key] = row.value
    }
    return result
  }

  async updateConstant(
    name: string,
    value: unknown,
  ): Promise<void> {
    const table = this.resolveConstantsTable()
    const url = `${this.config.url}/${table}?key=eq.${name}`

    const res = await fetch(url, {
      method: 'PATCH',
      headers: this.baseHeaders(),
      body: JSON.stringify({ value }),
    })

    this.assertOk(res)
  }

  // --- Private helpers ---

  /** Базові headers для всіх запитів */
  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.config.anonKey) {
      headers['apikey'] = this.config.anonKey
      headers['Authorization'] =
        `Bearer ${this.config.anonKey}`
    }
    return headers
  }

  /** Resolve table name для metadata-об'єкта */
  private resolveTable(ref: MetadataRef): string {
    return tableName(
      this.config.tablePrefix ?? '',
      ref.kind,
      ref.name,
    )
  }

  /** Таблиця констант — singleTable strategy */
  private resolveConstantsTable(): string {
    const prefix = this.config.tablePrefix ?? ''
    return `${prefix}constants`
  }

  /** Перевірити HTTP response, кинути помилку якщо !ok */
  private assertOk(res: Response): void {
    if (!res.ok) {
      throw new Error(
        `PostgREST error ${res.status}: ${res.statusText}`,
      )
    }
  }
}

// --- Утиліти ---

/** Конвертація FilterExpression в PostgREST filter string */
function formatFilter(f: FilterExpression): string {
  if (f.operator === 'in') {
    const vals = Array.isArray(f.value)
      ? (f.value as unknown[]).join(',')
      : String(f.value)
    return `in.(${vals})`
  }
  return `${f.operator}.${f.value}`
}

/** Парсинг Content-Range header: "0-24/100" → 100 */
function parseContentRange(header: string | null): number {
  if (!header) return 0
  const match = header.match(/\/(\d+|\*)$/)
  if (!match || match[1] === '*') return 0
  return parseInt(match[1], 10)
}

/**
 * Presentation-поля залежать від kind об'єкта.
 * Catalog/CustomTable → code, description
 * Document → number, date
 * Enumeration → code (predefined values)
 */
function getPresentationFields(
  kind: string,
): string[] {
  switch (kind) {
    case 'Document':
      return ['number', 'date']
    case 'Enumeration':
      return ['code']
    default:
      return ['code', 'description']
  }
}

/** Форматування display для RefOption */
function formatRefDisplay(
  row: Record<string, unknown>,
): string {
  // Спробуємо Catalog-style: code — description
  const code = row.code ? String(row.code) : ''
  const desc = row.description ? String(row.description) : ''
  if (code && desc) return `${code} — ${desc}`
  if (code || desc) return code || desc

  // Document-style: number від date
  const num = row.number ? String(row.number) : ''
  const date = row.date ? String(row.date) : ''
  if (num && date) return `${num} від ${date}`
  if (num || date) return num || date

  return ''
}
