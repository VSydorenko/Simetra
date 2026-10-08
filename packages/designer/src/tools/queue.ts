import { resolve } from "node:path"

const tails = new Map<string, Promise<unknown>>()

/**
 * Черга викликів однієї теки метаданих. Адаптери (MCP-сервер, CLI) можуть
 * слати виклики паралельно, тож без черги дві мутації читали б той самий стан
 * і друга мовчки затирала б першу, а записана комбінація двох результатів не
 * проходила б компіляцію. Читальні інструменти стоять у тій самій черзі:
 * `writeChanges` пише файли по одному, і компіляція посеред запису побачила б
 * напівзаписане дерево. Ціна — послідовні компіляції; вони короткі, а
 * коректність відповіді важливіша за паралелізм. Ключ — розв'язаний шлях, щоб
 * `./metadata` і абсолютний шлях ділили одну чергу.
 */
export function queueFor(
  dir: string
): <T>(task: () => Promise<T>) => Promise<T> {
  const key = resolve(dir)
  return (task) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(task)
    // Наступне завдання чекає завершення попереднього, а не його успіху.
    const tail = run.catch(() => undefined)
    tails.set(key, tail)
    // Порожню чергу прибираємо, щоб мапа не росла разом із числом тек.
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }
}
