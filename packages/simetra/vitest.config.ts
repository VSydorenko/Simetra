import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    // `pnpm test` (turbo) запускає юніт-тести обох пакетів одночасно: з
    // типовою кількістю воркерів на пакет їх удвічі більше за ядра, і тест із
    // кількома компіляціями впирається в 5-секундний таймаут не через себе.
    // Половина ядер на пакет — без переплати, таймаут лишається типовим.
    maxWorkers: "50%",
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
          // Тести, прив'язані до Supabase, — окремий проєкт `db-supabase`
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/*.supabase.db.test.ts",
          ],
          // Усі тести б'ють в одну базу стеку
          fileParallelism: false,
          // Стек один на машину: один прогін за раз і стек після прогону такий
          // самий, як до нього
          globalSetup: ["./test/db/stack-guard.supabase.ts"],
        },
      },
      {
        extends: true,
        test: {
          // Кейси, яким потрібен саме стек Supabase (схеми `auth`, `storage`,
          // `realtime`, ролі провайдера, пулер, пресет): лишаються на ньому й
          // тоді, коли проєкт `db` перейде на стек postgres
          name: "db-supabase",
          include: ["**/*.supabase.db.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          fileParallelism: false,
          globalSetup: ["./test/db/stack-guard.supabase.ts"],
        },
      },
      {
        extends: true,
        test: {
          // Стек профілю postgres: поки на ньому лише базовий стан і
          // переривання — решта DB-тестів іде на Supabase до перемикання
          // типового профілю
          name: "db-pg",
          include: ["test/db/pgtap.db.test.ts", "test/db/interrupt.db.test.ts"],
          fileParallelism: false,
          globalSetup: ["./test/db/stack-guard.postgres.ts"],
        },
      },
      {
        extends: true,
        test: {
          // Бенчмарк меж прав (спека прав §5.4): той самий стек і сторож, що й `db`, але
          // поза `test:db` і CI — прогін хвилинний, а результат — заміри машини
          name: "bench",
          include: ["bench/**/*.bench.db.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          fileParallelism: false,
          globalSetup: ["./test/db/stack-guard.supabase.ts"],
          // Засів і оператори на сотнях тисяч рядків — хвилини, не секунди
          testTimeout: 30 * 60_000,
          hookTimeout: 30 * 60_000,
        },
      },
    ],
  },
})
