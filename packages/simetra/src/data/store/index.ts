// Ядро T4 (спайк 1): точка входу для спайків 2 і 3. Не публічний API
// `simetra/data` — спайк не змінює експортів пакета.
export { createCoreSession, inspectCore, mergeVersioned } from "./core"
export type * from "./types"
