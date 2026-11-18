/**
 * Голий `403 Forbidden` CSRF-фільтра Start клієнт Start перетворює на
 * `Error("Forbidden")`. Один предикат для обох місць, що це розпізнають
 * (транспорт даних і функція сесії), щоб вони не розійшлися.
 */
export function isStartRefusal(error: unknown): boolean {
  return error instanceof Error && error.message === "Forbidden"
}
