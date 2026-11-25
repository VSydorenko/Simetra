import { defineConfig } from "vitest/config"

// Шлях guard і прибиральника переривання покритий на обох стеках: на
// postgres — проєктом `db` (за маскою), на Supabase — проєктом `db-supabase`
const INTERRUPT = "test/db/interrupt.db.test.ts"

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
          // Типовий DB-проєкт — стек профілю postgres: базовий стан, переривання
          // й усі DB-тести, крім прив'язаних до Supabase
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
          // Стеків postgres на машині кілька (ADR-0124): один прогін на стек, сторож
          // бере вільний, а стек після прогону такий самий, як до нього
          globalSetup: ["./test/db/stack-guard.postgres.ts"],
          // Дрейф ролі між тестами файлу (спека профілю §10.3, запобіжник 3)
          setupFiles: ["./test/db/db-setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          // Кейси, яким потрібен саме стек Supabase (схеми `auth`, `storage`,
          // `realtime`, ролі провайдера, пулер, пресет): лишаються на ньому,
          // а проєкт `db` іде на стек postgres
          name: "db-supabase",
          include: ["**/*.supabase.db.test.ts", INTERRUPT],
          exclude: ["**/node_modules/**", "**/dist/**"],
          fileParallelism: false,
          globalSetup: ["./test/db/stack-guard.supabase.ts"],
        },
      },
      {
        extends: true,
        test: {
          // Бенчмарк меж прав (спека прав §5.4): стек Supabase і його сторож, як у
          // `db-supabase`, але поза `test:db` і CI — прогін хвилинний, а результат —
          // заміри машини
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
