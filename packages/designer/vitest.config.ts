import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["**/*.test.ts"],
          // DB-тести потребують локального стеку — вони окремий проєкт `db`
          exclude: ["**/node_modules/**", "**/dist/**", "**/*.db.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["**/*.db.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          // Усі тести б'ють в одну базу стеку
          fileParallelism: false,
        },
      },
    ],
  },
})
