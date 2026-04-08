/** URL PostgREST API */
export const SIMETRA_API_URL = import.meta.env.VITE_SIMETRA_API_URL as string | undefined

/** Anon key для Supabase (optional) */
export const SIMETRA_ANON_KEY = import.meta.env.VITE_SIMETRA_ANON_KEY as string | undefined

/** Шлях до каталогу metadata (для dev server) */
export const SIMETRA_METADATA_PATH = (import.meta.env.VITE_SIMETRA_METADATA_PATH as string) || '/metadata'

/** Тип data provider: mock або postgrest */
export const SIMETRA_DATA_PROVIDER = (import.meta.env.VITE_SIMETRA_DATA_PROVIDER as string) || 'mock'
