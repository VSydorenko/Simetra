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
          // Файл, що пройшов аудит ізоляції, вмикає `describe.concurrent`.
          // Стеля — CPU одного процесу (pg-delta): за заміром 8 тестів разом
          // не швидші за 4, а більше одночасних тестів лише розтягує кожен
          // ближче до тайм-ауту
          maxConcurrency: 4,
          // Стек один на машину: один прогін за раз і стек після прогону такий
          // самий, як до нього
          globalSetup: ["../simetra/test/db/stack-guard.ts"],
          // Тег прогону в іменах тіней двигуна й облік їхніх провізій
          setupFiles: ["./src/__tests__/support/db-setup.ts"],
          // Тінь двигуна — це створення й наповнення окремої бази: на раннері CI
          // це довше за типові 5 с, а перерваний за тайм-аутом тест лишає
          // тінь, яку облік провізій назве лише наприкінці файлу.
          testTimeout: 60_000,
        },
      },
    ],
  },
})
