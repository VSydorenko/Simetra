/**
 * Шов тесту: дія, що виконується в транзакції `introspect` між extract і
 * читанням фактів. Окремий модуль без імпортів — його читає `vi.mock` читача
 * фактів, і цикл з файлом підтримки тут неможливий.
 */
export const seam: { beforeFacts: (() => Promise<void>) | undefined } = {
  beforeFacts: undefined,
}
