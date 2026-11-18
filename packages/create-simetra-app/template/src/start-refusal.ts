/**
 * Голий `403 Forbidden` CSRF-фільтра Start клієнт Start перетворює на
 * `Error("Forbidden")`; транспорт даних розпізнає її цим предикатом.
 */
export function isStartRefusal(error: unknown): boolean {
  return error instanceof Error && error.message === "Forbidden"
}
