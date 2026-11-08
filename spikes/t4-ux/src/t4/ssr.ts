// Прийняття SSR-знімка ядра на клієнті. Знімок без збігу каталогу або
// прострочений не гідрується: клієнт перечитає дані сам (видима зміна
// допустима — це виняток безпеки, а не мерехтіння).
export interface SnapshotMeta {
  subject: string
  catalogHash: string
  issuedAt: number
  ttlMs: number
}

export const rejected: string[] = []

export function acceptSnapshot(meta: SnapshotMeta, catalogHash = 'catalog-v1', now = Date.now()): boolean {
  if (meta.catalogHash !== catalogHash) return reject('catalog')
  if (now - meta.issuedAt > meta.ttlMs) return reject('expired')
  return true
}

function reject(reason: string) {
  rejected.push(reason)
  return false
}
