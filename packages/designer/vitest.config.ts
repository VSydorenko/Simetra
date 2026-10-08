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
          // Тінь двигуна — це створення й наповнення окремої бази: на раннері CI
          // це довше за типові 5 с, а перерваний тест лишає тінь-сироту, і
          // наступні тести падають уже на звірці лічильника тіней.
          testTimeout: 60_000,
        },
      },
    ],
  },
})
