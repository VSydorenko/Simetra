import tseslint from "typescript-eslint"
import { defineConfig } from "eslint/config"
import { frameworkBoundaryConfigs } from "../simetra/eslint.tier-zones.js"

// Межа фреймворку: TanStack Start — лише в `template/` і `e2e/`, які мають
// власні конфіги; пакет-копіювальник (`src/`) його не імпортує.
export default defineConfig([
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [tseslint.configs.base],
    // Тест межі в `simetra` лінтує з іншого процесу: без явного кореня парсер
    // не вибере між двома теками з tsconfig
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
  ...frameworkBoundaryConfigs,
])
