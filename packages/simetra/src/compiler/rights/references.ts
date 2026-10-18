import { PROJECT_FILE } from "../stages/files"
import type { ResolvedReference } from "../stages/identity"

/**
 * Ціль посилання з файлу проєкту за вказівником і роллю: елементи проєкту
 * (виміри, джерела) називають цілі іменем, а правила й контракти читають уже
 * резолвлений id з індексу, не ім'я вдруге.
 */
export function projectTarget(
  pointer: string,
  role: ResolvedReference["role"],
  ctx: { references: readonly ResolvedReference[] }
): string | undefined {
  return ctx.references.find(
    (r) =>
      r.from.file === PROJECT_FILE &&
      r.from.pointer === pointer &&
      r.role === role
  )?.to.id
}

/**
 * Попередні стадії гарантують наявність (id, резолв, перевірене правило);
 * відсутність — дефект компілятора, а не помилка метаданих.
 */
export function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("internal: missing rights input")
  return value
}
