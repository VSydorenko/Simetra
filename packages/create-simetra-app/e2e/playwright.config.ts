import { defineConfig } from "@playwright/test"

/**
 * Матриця ніг e2e (шов #210): рядок — це нога `{ браузер, збірка }`. У М3 один
 * рядок; нові ноги (WebKit, dev-збірка) додаються рядками, а не новим кодом
 * фікстур: фікстура бере збірку з метаданих проєкту.
 */
export const MATRIX = [{ browser: "chromium", build: "production" }] as const

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  globalSetup: "./global-setup.ts",
  // Хибно-зелене: повтор ховає нестабільність, `.only` — решту набору
  retries: 0,
  forbidOnly: true,
  // Одна база й один сервер на прогін: файли й тести йдуть послідовно
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  reporter: [["list"], ["json", { outputFile: "../test-results/report.json" }]],
  projects: MATRIX.map(({ browser, build }) => ({
    name: `${browser}-${build}`,
    metadata: { browser, build },
    use: { browserName: browser },
  })),
})
