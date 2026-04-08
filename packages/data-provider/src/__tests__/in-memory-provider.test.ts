import type { MetadataRef } from '@simetra/core'
import { describe, expect, it, beforeEach } from 'vitest'
import { InMemoryDataProvider } from '../in-memory-provider'

const catalogRef: MetadataRef = { kind: 'Catalog', name: 'Products' }
const docRef: MetadataRef = { kind: 'Document', name: 'SalesOrder' }

describe('InMemoryDataProvider', () => {
  let provider: InMemoryDataProvider

  beforeEach(() => {
    provider = new InMemoryDataProvider()
  })

  // ---------- CRUD ----------

  describe('create / get', () => {
    it('створює запис з генерованим id і повертає його', async () => {
      const row = await provider.create(catalogRef, {
        code: '001',
        description: 'Widget',
      })

      expect(row.id).toBeDefined()
      expect(row.code).toBe('001')
      expect(row.description).toBe('Widget')

      const fetched = await provider.get(catalogRef, row.id as string)
      expect(fetched).toEqual(row)
    })

    it('get повертає null для неіснуючого id', async () => {
      const result = await provider.get(catalogRef, 'no-such-id')
      expect(result).toBeNull()
    })
  })

  describe('update', () => {
    it('мержить partial дані в існуючий запис', async () => {
      const row = await provider.create(catalogRef, {
        code: '001',
        description: 'Old',
      })
      const updated = await provider.update(catalogRef, row.id as string, {
        description: 'New',
      })

      expect(updated.description).toBe('New')
      expect(updated.code).toBe('001')
      expect(updated.id).toBe(row.id)
    })

    it('кидає помилку при оновленні неіснуючого запису', async () => {
      await expect(
        provider.update(catalogRef, 'no-such-id', { code: 'x' }),
      ).rejects.toThrow('not found')
    })
  })

  describe('delete', () => {
    it('видаляє запис', async () => {
      const row = await provider.create(catalogRef, { code: '001' })
      await provider.delete(catalogRef, row.id as string)

      const result = await provider.get(catalogRef, row.id as string)
      expect(result).toBeNull()
    })
  })

  // ---------- list ----------

  describe('list', () => {
    beforeEach(async () => {
      await provider.create(catalogRef, {
        code: '001',
        description: 'Alpha',
        price: 10,
      })
      await provider.create(catalogRef, {
        code: '002',
        description: 'Beta',
        price: 20,
      })
      await provider.create(catalogRef, {
        code: '003',
        description: 'Gamma',
        price: 5,
      })
    })

    it('повертає всі записи з пагінацією за замовчуванням', async () => {
      const result = await provider.list(catalogRef)
      expect(result.data).toHaveLength(3)
      expect(result.total).toBe(3)
      expect(result.page).toBe(1)
      expect(result.pageSize).toBe(25)
    })

    it('пагінація обмежує результат', async () => {
      const page1 = await provider.list(catalogRef, { page: 1, pageSize: 2 })
      expect(page1.data).toHaveLength(2)
      expect(page1.total).toBe(3)

      const page2 = await provider.list(catalogRef, { page: 2, pageSize: 2 })
      expect(page2.data).toHaveLength(1)
    })

    it('сортування за полем asc', async () => {
      const result = await provider.list(catalogRef, {
        sortBy: 'price',
        sortDirection: 'asc',
      })
      const prices = result.data.map((r) => r.price)
      expect(prices).toEqual([5, 10, 20])
    })

    it('сортування за полем desc', async () => {
      const result = await provider.list(catalogRef, {
        sortBy: 'price',
        sortDirection: 'desc',
      })
      const prices = result.data.map((r) => r.price)
      expect(prices).toEqual([20, 10, 5])
    })

    it('фільтрація eq', async () => {
      const result = await provider.list(catalogRef, {
        filters: [{ field: 'code', operator: 'eq', value: '002' }],
      })
      expect(result.data).toHaveLength(1)
      expect(result.data[0].description).toBe('Beta')
    })

    it('фільтрація gt', async () => {
      const result = await provider.list(catalogRef, {
        filters: [{ field: 'price', operator: 'gt', value: 10 }],
      })
      expect(result.data).toHaveLength(1)
      expect(result.data[0].code).toBe('002')
    })

    it('фільтрація ilike', async () => {
      const result = await provider.list(catalogRef, {
        filters: [{ field: 'description', operator: 'ilike', value: 'alp' }],
      })
      expect(result.data).toHaveLength(1)
      expect(result.data[0].code).toBe('001')
    })

    it('фільтрація in', async () => {
      const result = await provider.list(catalogRef, {
        filters: [
          { field: 'code', operator: 'in', value: ['001', '003'] },
        ],
      })
      expect(result.data).toHaveLength(2)
    })

    it('search шукає по всіх string полях', async () => {
      const result = await provider.list(catalogRef, { search: 'gamma' })
      expect(result.data).toHaveLength(1)
      expect(result.data[0].code).toBe('003')
    })

    it('повертає порожній результат для неіснуючого objectRef', async () => {
      const otherRef: MetadataRef = { kind: 'Catalog', name: 'Unknown' }
      const result = await provider.list(otherRef)
      expect(result.data).toEqual([])
      expect(result.total).toBe(0)
    })
  })

  // ---------- searchRef / getRefDisplay ----------

  describe('searchRef', () => {
    it('шукає по code і description case-insensitive', async () => {
      await provider.create(catalogRef, {
        code: 'P001',
        description: 'Молоко',
      })
      await provider.create(catalogRef, {
        code: 'P002',
        description: 'Масло',
      })

      const results = await provider.searchRef(catalogRef, 'мол')
      expect(results).toHaveLength(1)
      expect(results[0].display).toBe('Молоко')
    })

    it('обмежує кількість результатів через limit', async () => {
      for (let i = 0; i < 20; i++) {
        await provider.create(catalogRef, {
          code: `P${i}`,
          description: `Item ${i}`,
        })
      }

      const results = await provider.searchRef(catalogRef, 'Item', {
        limit: 5,
      })
      expect(results).toHaveLength(5)
    })
  })

  describe('getRefDisplay', () => {
    it('повертає description як display', async () => {
      const row = await provider.create(catalogRef, {
        code: 'P001',
        description: 'Молоко',
      })
      const display = await provider.getRefDisplay(
        catalogRef,
        row.id as string,
      )
      expect(display).toBe('Молоко')
    })

    it('повертає code коли description порожній', async () => {
      const row = await provider.create(catalogRef, { code: 'P001' })
      const display = await provider.getRefDisplay(
        catalogRef,
        row.id as string,
      )
      expect(display).toBe('P001')
    })

    it('повертає id для неіснуючого запису', async () => {
      const display = await provider.getRefDisplay(catalogRef, 'unknown-id')
      expect(display).toBe('unknown-id')
    })
  })

  // ---------- postDocument / unpostDocument ----------

  describe('postDocument / unpostDocument', () => {
    it('встановлює posted: true', async () => {
      const doc = await provider.create(docRef, {
        number: 'SO-001',
        posted: false,
      })
      await provider.postDocument(docRef, doc.id as string)

      const updated = await provider.get(docRef, doc.id as string)
      expect(updated?.posted).toBe(true)
    })

    it('встановлює posted: false', async () => {
      const doc = await provider.create(docRef, {
        number: 'SO-001',
        posted: true,
      })
      await provider.unpostDocument(docRef, doc.id as string)

      const updated = await provider.get(docRef, doc.id as string)
      expect(updated?.posted).toBe(false)
    })

    it('кидає помилку для неіснуючого документа', async () => {
      await expect(
        provider.postDocument(docRef, 'no-such-id'),
      ).rejects.toThrow('not found')
    })
  })

  // ---------- constants ----------

  describe('getConstants / updateConstant', () => {
    it('повертає порожній об\'єкт за замовчуванням', async () => {
      const result = await provider.getConstants()
      expect(result).toEqual({})
    })

    it('оновлює і повертає константи', async () => {
      await provider.updateConstant('CompanyName', 'Simetra Inc.')
      await provider.updateConstant('DefaultCurrency', 'UAH')

      const result = await provider.getConstants()
      expect(result).toEqual({
        CompanyName: 'Simetra Inc.',
        DefaultCurrency: 'UAH',
      })
    })

    it('перезаписує існуючу константу', async () => {
      await provider.updateConstant('CompanyName', 'Old')
      await provider.updateConstant('CompanyName', 'New')

      const result = await provider.getConstants()
      expect(result.CompanyName).toBe('New')
    })
  })
})
