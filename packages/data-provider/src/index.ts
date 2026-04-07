import type { MetadataRef } from '@simetra/core'

/**
 * Опції фільтрації списку
 */
export interface FilterExpression {
  field: string
  operator:
    | 'eq'
    | 'neq'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'like'
    | 'ilike'
    | 'in'
    | 'is'
  value: unknown
}

/**
 * Опції для запиту списку записів
 */
export interface ListOptions {
  page?: number
  pageSize?: number
  sortBy?: string
  sortDirection?: 'asc' | 'desc'
  filters?: FilterExpression[]
  search?: string
}

/**
 * Результат запиту списку
 */
export interface ListResult<T = Record<string, unknown>> {
  data: T[]
  total: number
  page: number
  pageSize: number
}

/**
 * Опція для вибору ref-посилання
 */
export interface RefOption {
  id: string
  display: string
}

/**
 * Абстрактний контракт data access для Simetra runtime.
 * Не прив'язаний до конкретного SDK чи бази даних.
 * Конкретні адаптери (PostgREST, Supabase, mock) реалізують цей інтерфейс.
 *
 * Generic параметр T — тип запису. За замовчуванням Record<string, unknown>.
 * Адаптери можуть звузити T для конкретних use cases.
 */
export interface DataProvider<T = Record<string, unknown>> {
  /** Отримати список записів об'єкта */
  list(objectRef: MetadataRef, options?: ListOptions): Promise<ListResult<T>>

  /** Отримати один запис за id */
  get(objectRef: MetadataRef, id: string): Promise<T | null>

  /** Створити новий запис */
  create(objectRef: MetadataRef, data: T): Promise<T>

  /** Оновити запис за id */
  update(objectRef: MetadataRef, id: string, data: Partial<T>): Promise<T>

  /** Видалити запис за id */
  delete(objectRef: MetadataRef, id: string): Promise<void>

  /** Пошук записів для ref-поля (autocomplete) */
  searchRef(
    targetRef: MetadataRef,
    query: string,
    options?: { limit?: number },
  ): Promise<RefOption[]>

  /** Отримати display-значення для ref-поля */
  getRefDisplay(targetRef: MetadataRef, id: string): Promise<string>

  /** Провести документ */
  postDocument(objectRef: MetadataRef, id: string): Promise<void>

  /** Скасувати проведення документа */
  unpostDocument(objectRef: MetadataRef, id: string): Promise<void>

  /** Отримати всі константи (singleTable strategy) */
  getConstants(): Promise<Record<string, unknown>>

  /** Оновити значення однієї константи */
  updateConstant(name: string, value: unknown): Promise<void>
}
