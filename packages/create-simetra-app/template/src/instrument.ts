// Точки інструментування (спека П4-D §4.1, Дх9): у шаблоні — обробники без дії. E2e-збірка
// підміняє модуль аліасом `#instrument`, код застосунку не змінюється.

/** Обгортає клієнтський транспорт; без інструментування повертає його як є. */
export function wrapTransport<T>(transport: T): T {
  return transport
}

/** Обгортає порт бази; без інструментування повертає його як є. */
export function wrapDatabase<T>(database: T): T {
  return database
}

/** Бачить підсумкову відповідь Server Function даних; без дії. */
export function onDataResponse(_response: unknown): void {}

/** Кінець гідратації; без дії. */
export function markHydrated(): void {}
