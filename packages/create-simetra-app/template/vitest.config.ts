import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    // DB-тестів шаблону поки немає (з'являються в задачах 9–12): порожній
    // проєкт `db` не червонить рівень
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          // Лише unit без бази й збірки: його бере кореневий `pnpm test`
          name: "unit",
          include: ["test/**/*.test.ts", "src/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/*.db.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["test/**/*.db.test.ts", "src/**/*.db.test.ts"],
          exclude: ["**/node_modules/**"],
          // Стек postgres один на машину: той самий сторож, що й у `simetra`
          globalSetup: ["../../simetra/test/db/stack-guard.postgres.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
})
