import { defineConfig } from "vitest/config"

// DB-файли, уже перенесені на стек postgres (план ПГ-2b, Р6): `db-pg` їх
// бере, а `db`, ще на Supabase, виключає тим самим комітом — кейс під час
// переносу не губиться й не задвоюється
export const ON_POSTGRES: string[] = []

// Шлях guard і прибиральника переривання покритий на обох стеках: на
// Supabase — проєктом `db-supabase`, тож `db` його не бере, інакше файл ішов
// би двічі за `test:db`
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
          name: "db",
          include: ["**/*.db.test.ts"],
          // Тести, прив'язані до Supabase, — окремий проєкт `db-supabase`
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/*.supabase.db.test.ts",
            "**/*.postgres.db.test.ts",
            INTERRUPT,
            ...ON_POSTGRES,
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
          include: ["**/*.supabase.db.test.ts", INTERRUPT],
          exclude: ["**/node_modules/**", "**/dist/**"],
          fileParallelism: false,
          globalSetup: ["./test/db/stack-guard.supabase.ts"],
        },
      },
      {
        extends: true,
        test: {
          // Стек профілю postgres: базовий стан, переривання й тести, прив'язані
          // до цього стека (`*.postgres.db.test.ts`); решта DB-тестів іде на
          // Supabase до перемикання типового профілю
          name: "db-pg",
          include: [
            "test/db/pgtap.db.test.ts",
            INTERRUPT,
            "**/*.postgres.db.test.ts",
            ...ON_POSTGRES,
          ],
          exclude: ["**/node_modules/**", "**/dist/**"],
          fileParallelism: false,
          globalSetup: ["./test/db/stack-guard.postgres.ts"],
          // Дрейф ролі між тестами файлу (спека профілю §10.3, запобіжник 3)
          setupFiles: ["./test/db/db-setup.ts"],
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
