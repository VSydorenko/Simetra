// Ядро T4 зі спайку 1 (гілка spike/t4-core): полігон бере його з джерел пакета.
export * from '../../../../packages/simetra/src/data/store/index'
export { FakeServer } from '../../../../packages/simetra/src/data/store/testing/fake-source'
import type { ObjectSpec, OrderBy } from '../../../../packages/simetra/src/data/store/index'

export const ITEM = 'Catalog.Item'
export const itemSpec: ObjectSpec = {
  ref: { kind: 'Catalog', name: 'Item' },
  fields: { num: 'number', name: 'string', amount: 'numeric-text', status: 'string' },
  lazy: ['note'],
  sections: ['lines'],
}
export const ORDER: OrderBy = [{ attribute: 'num', direction: 'asc' }] as OrderBy
