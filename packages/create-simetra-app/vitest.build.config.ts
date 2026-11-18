import { defineConfig } from "vitest/config"

// Гейт складу збірки (`*.build.test.ts`): збирає шаблон, тож повільний і не
// входить у `unit`. Файли йдуть послідовно: збірки не ділять теку, але ділять
// процесор і мережу реєстру.
export default defineConfig({
  test: {
    include: ["e2e/**/*.build.test.ts"],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
})
