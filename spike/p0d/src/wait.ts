// Очікування умови з таймаутом (хартія: не sleep). Перевірка кожні 10 мс,
// помилка з описом — коли умова не настала за відведений час.
export async function waitFor(what: string, cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout ${timeoutMs}ms: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
