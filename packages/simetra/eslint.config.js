import js from "@eslint/js"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"
import { standardColumnConfigs } from "./eslint.standard-columns.js"
import { tierZoneConfigs } from "./eslint.tier-zones.js"

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    // `no-floating-promises` потребує типів (спека П4-B §3); інші яруси
    // лишаються на парсері без типів, бо типізований лінт помітно дорожчий.
    // allowDefaultProject — закритий перелік віртуальних фікстур
    // test/tier-boundary.test.ts: фікстура поза ним дає `Parsing error`, і
    // тестові хелпери кидають, а не мовчки зеленіють. typescript-eslint не
    // приймає `**`, а межа default project (8) рахує відкриті файли.
    files: ["src/data/**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "src/data/__fixture.ts",
            "src/data/a/b/__fixture.ts",
            "src/data/facade/__fixture.ts",
            "src/data/nested/__fixture.ts",
            "src/data/__tests__/__fixture.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: { "@typescript-eslint/no-floating-promises": "error" },
  },
  ...tierZoneConfigs,
  ...standardColumnConfigs,
])
