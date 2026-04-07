import { describe, it, expectTypeOf } from 'vitest'
import type { MetadataRef } from '@simetra/core'
import type {
  DataProvider,
  ListOptions,
  ListResult,
  RefOption,
  FilterExpression,
} from '..'

describe('DataProvider types', () => {
  it('list повертає Promise<ListResult<T>>', () => {
    expectTypeOf<DataProvider['list']>().parameters.toMatchTypeOf<
      [MetadataRef, ListOptions?]
    >()
    expectTypeOf<DataProvider['list']>().returns.toEqualTypeOf<
      Promise<ListResult>
    >()
  })

  it('get повертає Promise<T | null>', () => {
    expectTypeOf<DataProvider['get']>().parameters.toMatchTypeOf<
      [MetadataRef, string]
    >()
    expectTypeOf<DataProvider['get']>().returns.toEqualTypeOf<
      Promise<Record<string, unknown> | null>
    >()
  })

  it('create приймає T і повертає Promise<T>', () => {
    expectTypeOf<DataProvider['create']>().returns.toEqualTypeOf<
      Promise<Record<string, unknown>>
    >()
  })

  it('update приймає Partial<T> і повертає Promise<T>', () => {
    expectTypeOf<DataProvider['update']>().returns.toEqualTypeOf<
      Promise<Record<string, unknown>>
    >()
  })

  it('delete повертає Promise<void>', () => {
    expectTypeOf<DataProvider['delete']>().returns.toEqualTypeOf<
      Promise<void>
    >()
  })

  it('searchRef повертає Promise<RefOption[]>', () => {
    expectTypeOf<DataProvider['searchRef']>().returns.toEqualTypeOf<
      Promise<RefOption[]>
    >()
  })

  it('getRefDisplay повертає Promise<string>', () => {
    expectTypeOf<DataProvider['getRefDisplay']>().returns.toEqualTypeOf<
      Promise<string>
    >()
  })

  it('postDocument / unpostDocument повертають Promise<void>', () => {
    expectTypeOf<DataProvider['postDocument']>().returns.toEqualTypeOf<
      Promise<void>
    >()
    expectTypeOf<DataProvider['unpostDocument']>().returns.toEqualTypeOf<
      Promise<void>
    >()
  })

  it('getConstants повертає Promise<Record<string, unknown>>', () => {
    expectTypeOf<DataProvider['getConstants']>().returns.toEqualTypeOf<
      Promise<Record<string, unknown>>
    >()
  })

  it('updateConstant приймає name і value', () => {
    expectTypeOf<DataProvider['updateConstant']>().parameters.toMatchTypeOf<
      [string, unknown]
    >()
    expectTypeOf<DataProvider['updateConstant']>().returns.toEqualTypeOf<
      Promise<void>
    >()
  })

  it('generic DataProvider звужує тип запису', () => {
    type Product = { id: string; name: string; price: number }
    type ProductProvider = DataProvider<Product>
    expectTypeOf<ProductProvider['get']>().returns.toEqualTypeOf<
      Promise<Product | null>
    >()
    expectTypeOf<ProductProvider['list']>().returns.toEqualTypeOf<
      Promise<ListResult<Product>>
    >()
  })

  it('ListOptions приймає всі опціональні поля', () => {
    const full: ListOptions = {
      page: 1,
      pageSize: 25,
      sortBy: 'name',
      sortDirection: 'asc',
      filters: [],
      search: 'test',
    }
    expectTypeOf(full).toMatchTypeOf<ListOptions>()
  })

  it('ListResult generic визначає тип data', () => {
    type Typed = ListResult<{ id: string }>
    expectTypeOf<Typed['data']>().toEqualTypeOf<{ id: string }[]>()
  })

  it('RefOption має id та display як string', () => {
    expectTypeOf<RefOption['id']>().toEqualTypeOf<string>()
    expectTypeOf<RefOption['display']>().toEqualTypeOf<string>()
  })

  it('FilterExpression operator — union рядків', () => {
    expectTypeOf<FilterExpression['field']>().toEqualTypeOf<string>()
    expectTypeOf<FilterExpression['operator']>().toMatchTypeOf<string>()
  })
})
