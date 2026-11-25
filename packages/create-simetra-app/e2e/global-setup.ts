// Стеків `postgres` на машині кілька (ADR-0124): той самий сторож, що й у
// DB-проєктах vitest, бере вільний (замок, перевірка диска, тег прогону в env
// воркерів, звірка стека наприкінці).
// Playwright бере повернену функцію як teardown.
import { setupFor } from "../../simetra/test/db/stack-guard"

export default setupFor("postgres")
