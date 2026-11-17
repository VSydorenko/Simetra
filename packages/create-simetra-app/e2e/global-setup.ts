// Стек `postgres` один на машину: той самий сторож, що й у DB-проєктах vitest
// (замок, перевірка диска, тег прогону в env воркерів, звірка стека наприкінці).
// Playwright бере повернену функцію як teardown.
import { setupFor } from "../../simetra/test/db/stack-guard"

export default setupFor("postgres")
