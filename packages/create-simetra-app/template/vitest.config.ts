import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
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
          // Стеків postgres на машині кілька (ADR-0124), вільний бере той самий сторож, що й у `simetra`
          globalSetup: ["../../simetra/test/db/stack-guard.postgres.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
})
