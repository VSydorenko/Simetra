import { defineConfig } from "vitest/config"

// Unit-тести скриптів пакета (`scripts/**`): без стека й без збірки шаблону.
// Гейт збірки — окремий конфіг `vitest.build.config.ts`.
export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
  },
})
