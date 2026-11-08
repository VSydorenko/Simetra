import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

// Стенд спайку 3 (Postgres + Centrifugo в docker): поза `test` і `test:db`,
// запуск вручну — `vitest run -c test/realtime/vitest.stand.config.ts`.
export default defineConfig({
  root: resolve(import.meta.dirname, "../.."),
  test: {
    include: ["test/realtime/*.stand.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
})
