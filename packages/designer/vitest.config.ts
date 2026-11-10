import { defineConfig } from "vitest/config"

// DB-файли, уже перенесені на стек postgres (план ПГ-2b, Р6): `db-pg` їх
// бере, а `db`, ще на Supabase, виключає тим самим комітом — кейс під час
// переносу не губиться й не задвоюється
export const ON_POSTGRES: string[] = [
  // Корпус рушія (задача 10)
  "src/schema-engine/__tests__/promotion-equivalence.db.test.ts",
  "src/schema-engine/__tests__/fingerprint-coverage.db.test.ts",
  "src/schema-engine/__tests__/engine-scope.db.test.ts",
  "src/schema-engine/__tests__/engine-apply-port.db.test.ts",
  "src/schema-engine/__tests__/savepoint-extract.db.test.ts",
  "src/schema-engine/__tests__/read-only.db.test.ts",
  "src/schema-engine/__tests__/function-checks.db.test.ts",
  "src/schema-engine/__tests__/fingerprint.db.test.ts",
  "src/schema-engine/__tests__/apply-database.db.test.ts",
]

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
          // DB-тести потребують локального стеку — вони окремий проєкт `db`;
          // гейт пакування потребує свіжого `pnpm build:packages` — проєкт `packaging`
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/*.db.test.ts",
            "**/*.pack.test.ts",
          ],
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
            ...ON_POSTGRES,
          ],
          // Усі тести б'ють в одну базу стеку
          fileParallelism: false,
          // Файл, що пройшов аудит ізоляції, вмикає `describe.concurrent`.
          // Стеля — CPU одного процесу (pg-delta): за заміром 8 тестів разом
          // не швидші за 4, а більше одночасних тестів лише розтягує кожен
          // ближче до тайм-ауту
          maxConcurrency: 4,
          // Стек один на машину: один прогін за раз і стек після прогону такий
          // самий, як до нього
          globalSetup: ["../simetra/test/db/stack-guard.supabase.ts"],
          // Тег прогону в іменах тіней двигуна й облік їхніх провізій
          setupFiles: ["./src/__tests__/support/db-setup.ts"],
          // Тінь двигуна — це створення й наповнення окремої бази: на раннері CI
          // це довше за типові 5 с, а перерваний за тайм-аутом тест лишає
          // тінь, яку облік провізій назве лише наприкінці файлу.
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          // Кейси, яким потрібен саме стек Supabase (схеми `auth`, `storage`,
          // `realtime`, ролі провайдера, пулер, пресет): лишаються на ньому й
          // тоді, коли проєкт `db` перейде на стек postgres. Налаштування — ті
          // самі, що в `db`, і з тих самих причин
          name: "db-supabase",
          include: ["**/*.supabase.db.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          fileParallelism: false,
          maxConcurrency: 4,
          globalSetup: ["../simetra/test/db/stack-guard.supabase.ts"],
          setupFiles: ["./src/__tests__/support/db-setup.ts"],
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          // Тести, прив'язані до стека postgres. Налаштування — ті самі, що в
          // `db`, і з тих самих причин; сторож — свій, бо стек інший
          name: "db-pg",
          include: ["**/*.postgres.db.test.ts", ...ON_POSTGRES],
          exclude: ["**/node_modules/**", "**/dist/**"],
          fileParallelism: false,
          maxConcurrency: 4,
          globalSetup: ["../simetra/test/db/stack-guard.postgres.ts"],
          setupFiles: ["./src/__tests__/support/db-setup.ts"],
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: "packaging",
          include: ["test/packaging/**/*.pack.test.ts"],
          // Пакування й `npm install` у тимчасовий проєкт — I/O і мережа:
          // паралельні файли лише б'ються за диск
          fileParallelism: false,
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
})
