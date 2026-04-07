import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PostgRestDataProvider } from '../postgrest-provider'
import type { MetadataRef } from '@simetra/core'

const BASE_URL = 'http://localhost:3000'

const catalogRef: MetadataRef = { kind: 'Catalog', name: 'Products' }
const docRef: MetadataRef = { kind: 'Document', name: 'SalesOrder' }

function mockFetch(
  body: unknown = [],
  status = 200,
  headers: Record<string, string> = {},
) {
  const headersMap = new Map(Object.entries(headers))
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `Error ${status}`,
    json: () => Promise.resolve(body),
    headers: {
      get: (key: string) => headersMap.get(key) ?? null,
    },
  } as unknown as Response)
}

describe('PostgRestDataProvider', () => {
  let provider: PostgRestDataProvider

  beforeEach(() => {
    provider = new PostgRestDataProvider({
      url: BASE_URL,
      tablePrefix: '',
    })
    vi.restoreAllMocks()
  })

  // --- list ---

  it('list — базовий запит', async () => {
    const data = [{ id: '1', code: 'P001' }]
    globalThis.fetch = mockFetch(data, 200, {
      'Content-Range': '0-0/1',
    })

    const result = await provider.list(catalogRef)

    expect(globalThis.fetch).toHaveBeenCalledOnce()
    const url = new URL(
      (globalThis.fetch as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as string,
    )
    // cat_products — physicalObjectName("Catalog", "Products")
    expect(url.pathname).toBe('/cat_products')
    expect(url.searchParams.get('select')).toBe('*')
    expect(url.searchParams.get('order')).toBe('id.asc')
    expect(url.searchParams.get('limit')).toBe('25')
    expect(url.searchParams.get('offset')).toBe('0')

    // Перевірка Prefer header
    const opts = (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mock.calls[0][1] as RequestInit
    expect((opts.headers as Record<string, string>)['Prefer'])
      .toBe('count=exact')

    expect(result).toEqual({
      data,
      total: 1,
      page: 1,
      pageSize: 25,
    })
  })

  it('list — з пагінацією і сортуванням', async () => {
    globalThis.fetch = mockFetch([], 200, {
      'Content-Range': '*/0',
    })

    await provider.list(catalogRef, {
      page: 2,
      pageSize: 10,
      sortBy: 'name',
      sortDirection: 'desc',
    })

    const url = new URL(
      (globalThis.fetch as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as string,
    )
    expect(url.searchParams.get('order')).toBe('name.desc')
    expect(url.searchParams.get('limit')).toBe('10')
    expect(url.searchParams.get('offset')).toBe('10')
  })

  it('list — з search', async () => {
    globalThis.fetch = mockFetch([], 200, {
      'Content-Range': '*/0',
    })

    await provider.list(catalogRef, { search: 'test' })

    const url = new URL(
      (globalThis.fetch as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as string,
    )
    expect(url.searchParams.get('or')).toBe(
      '(code.ilike.*test*,description.ilike.*test*)',
    )
  })

  it('list — з filters', async () => {
    globalThis.fetch = mockFetch([], 200, {
      'Content-Range': '*/0',
    })

    await provider.list(catalogRef, {
      filters: [
        { field: 'status', operator: 'eq', value: 'active' },
      ],
    })

    const url = new URL(
      (globalThis.fetch as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as string,
    )
    expect(url.searchParams.get('status')).toBe('eq.active')
  })

  // --- get ---

  it('get — знайдено', async () => {
    const record = { id: '1', code: 'P001', description: 'Test' }
    globalThis.fetch = mockFetch(record)

    const result = await provider.get(catalogRef, '1')

    const url = new URL(
      (globalThis.fetch as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as string,
    )
    expect(url.pathname).toBe('/cat_products')
    expect(url.searchParams.get('id')).toBe('eq.1')

    // Перевірка Accept header для single object
    const opts = (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mock.calls[0][1] as RequestInit
    expect((opts.headers as Record<string, string>)['Accept'])
      .toBe('application/vnd.pgrst.object+json')

    expect(result).toEqual(record)
  })

  it('get — не знайдено (406)', async () => {
    globalThis.fetch = mockFetch(
      { message: 'Not found' },
      406,
    )

    const result = await provider.get(catalogRef, 'missing')
    expect(result).toBeNull()
  })

  // --- create ---

  it('create — success', async () => {
    const newData = { code: 'P002', description: 'New' }
    const created = { id: '2', ...newData }
    globalThis.fetch = mockFetch([created], 201)

    const result = await provider.create(catalogRef, newData)

    const [url, opts] = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, RequestInit]
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body as string)).toEqual(newData)
    expect(
      (opts.headers as Record<string, string>)['Prefer'],
    ).toBe('return=representation')
    expect(new URL(url).pathname).toBe('/cat_products')
    expect(result).toEqual(created)
  })

  // --- update ---

  it('update — success', async () => {
    const patch = { description: 'Updated' }
    const updated = { id: '1', code: 'P001', ...patch }
    globalThis.fetch = mockFetch([updated])

    const result = await provider.update(
      catalogRef, '1', patch,
    )

    const [url, opts] = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, RequestInit]
    expect(opts.method).toBe('PATCH')
    expect(JSON.parse(opts.body as string)).toEqual(patch)
    const parsed = new URL(url)
    expect(parsed.searchParams.get('id')).toBe('eq.1')
    expect(result).toEqual(updated)
  })

  // --- delete ---

  it('delete — success', async () => {
    globalThis.fetch = mockFetch(undefined, 204)

    await provider.delete(catalogRef, '1')

    const [url, opts] = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, RequestInit]
    expect(opts.method).toBe('DELETE')
    expect(new URL(url).searchParams.get('id')).toBe('eq.1')
  })

  // --- searchRef ---

  it('searchRef — повертає RefOption[]', async () => {
    const rows = [
      { id: '1', code: 'P001', description: 'Product 1' },
      { id: '2', code: 'P002', description: null },
    ]
    globalThis.fetch = mockFetch(rows)

    const result = await provider.searchRef(
      catalogRef, 'P00',
    )

    expect(result).toEqual([
      { id: '1', display: 'P001 — Product 1' },
      { id: '2', display: 'P002' },
    ])

    const url = new URL(
      (globalThis.fetch as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as string,
    )
    expect(url.searchParams.get('limit')).toBe('20')
    expect(url.searchParams.get('select')).toBe(
      'id,code,description',
    )
  })

  // --- getRefDisplay ---

  it('getRefDisplay — success', async () => {
    globalThis.fetch = mockFetch({
      code: 'P001',
      description: 'Product 1',
    })

    const result = await provider.getRefDisplay(catalogRef, '1')
    expect(result).toBe('P001 — Product 1')
  })

  // --- postDocument ---

  it('postDocument — викликає правильну RPC', async () => {
    globalThis.fetch = mockFetch({})

    await provider.postDocument(docRef, 'abc-123')

    const [url, opts] = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, RequestInit]

    expect(new URL(url).pathname).toBe(
      '/rpc/post_sales_order',
    )
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body as string)).toEqual({
      p_doc_id: 'abc-123',
    })
  })

  // --- unpostDocument ---

  it('unpostDocument — викликає правильну RPC', async () => {
    globalThis.fetch = mockFetch({})

    await provider.unpostDocument(docRef, 'abc-123')

    const [url] = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, RequestInit]

    expect(new URL(url).pathname).toBe(
      '/rpc/unpost_sales_order',
    )
  })

  // --- getConstants / updateConstant ---

  it('getConstants — конвертує rows в Record', async () => {
    const rows = [
      { key: 'companyName', value: 'Simetra' },
      { key: 'maxRetries', value: 3 },
    ]
    globalThis.fetch = mockFetch(rows)

    const result = await provider.getConstants()

    expect(result).toEqual({
      companyName: 'Simetra',
      maxRetries: 3,
    })

    const url = new URL(
      (globalThis.fetch as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as string,
    )
    expect(url.pathname).toBe('/constants')
  })

  it('updateConstant — PATCH з правильним body', async () => {
    globalThis.fetch = mockFetch(undefined, 204)

    await provider.updateConstant('companyName', 'New Name')

    const [url, opts] = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, RequestInit]

    expect(opts.method).toBe('PATCH')
    expect(new URL(url).searchParams.get('key')).toBe(
      'eq.companyName',
    )
    expect(JSON.parse(opts.body as string)).toEqual({
      value: 'New Name',
    })
  })

  // --- anonKey ---

  it('anonKey — додає auth headers', async () => {
    const authProvider = new PostgRestDataProvider({
      url: BASE_URL,
      anonKey: 'test-key-123',
    })
    globalThis.fetch = mockFetch(
      { code: 'X', description: 'Y' },
    )

    await authProvider.getRefDisplay(catalogRef, '1')

    const opts = (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mock.calls[0][1] as RequestInit
    const headers = opts.headers as Record<string, string>

    expect(headers['apikey']).toBe('test-key-123')
    expect(headers['Authorization']).toBe(
      'Bearer test-key-123',
    )
  })

  // --- error handling ---

  it('error handling — response !ok кидає Error', async () => {
    globalThis.fetch = mockFetch(
      { message: 'Internal error' },
      500,
    )

    await expect(
      provider.list(catalogRef),
    ).rejects.toThrow('PostgREST error 500')
  })

  // --- tablePrefix ---

  it('tablePrefix — додає prefix до table name', async () => {
    const prefixed = new PostgRestDataProvider({
      url: BASE_URL,
      tablePrefix: 'app_',
    })
    globalThis.fetch = mockFetch([], 200, {
      'Content-Range': '*/0',
    })

    await prefixed.list(catalogRef)

    const url = new URL(
      (globalThis.fetch as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as string,
    )
    expect(url.pathname).toBe('/app_cat_products')
  })

  it('list — filter з operator "in"', async () => {
    globalThis.fetch = mockFetch([], 200, {
      'Content-Range': '*/0',
    })

    await provider.list(catalogRef, {
      filters: [
        { field: 'status', operator: 'in', value: ['a', 'b'] },
      ],
    })

    const url = new URL(
      (globalThis.fetch as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as string,
    )
    expect(url.searchParams.get('status')).toBe('in.(a,b)')
  })

  // --- Document kind-aware ref search ---

  it('searchRef для Document — використовує number/date', async () => {
    const rows = [
      { id: '1', number: 'SO-001', date: '2026-01-15' },
    ]
    globalThis.fetch = mockFetch(rows)

    const result = await provider.searchRef(docRef, 'SO')

    const url = new URL(
      (globalThis.fetch as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as string,
    )
    expect(url.searchParams.get('select')).toBe(
      'id,number,date',
    )
    expect(url.searchParams.get('or')).toContain(
      'number.ilike',
    )
    expect(result[0].display).toBe('SO-001 від 2026-01-15')
  })

  it('getRefDisplay для Document — number від date', async () => {
    globalThis.fetch = mockFetch({
      number: 'SO-001',
      date: '2026-01-15',
    })

    const result = await provider.getRefDisplay(docRef, '1')
    expect(result).toBe('SO-001 від 2026-01-15')
  })

  it('list для Document — search по number/date', async () => {
    globalThis.fetch = mockFetch([], 200, {
      'Content-Range': '*/0',
    })

    await provider.list(docRef, { search: 'SO-001' })

    const url = new URL(
      (globalThis.fetch as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as string,
    )
    const orParam = url.searchParams.get('or') ?? ''
    expect(orParam).toContain('number.ilike')
    expect(orParam).toContain('date.ilike')
    expect(orParam).not.toContain('code.ilike')
  })
})
