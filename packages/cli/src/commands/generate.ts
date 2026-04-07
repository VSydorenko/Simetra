import { defineCommand } from "citty"
import { writeFileSync, mkdirSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"
import { PostgresGenerator } from "@simetra/generator-pg"
import { buildProjectModel } from "../build-model"
import { validateGeneratorOptions } from "../validate-options"

// Безпечна перевірка шляху — запобігає path traversal
function isSafePath(path: string): boolean {
  return !path.includes("..") && !path.startsWith("/")
}

export const generate = defineCommand({
  meta: {
    name: "generate",
    description: "Генерація SQL з метаданих проєкту",
  },
  args: {
    target: {
      type: "string",
      description: "Цільова база даних (postgresql)",
      default: "postgresql",
    },
    input: {
      type: "string",
      description: "Шлях до директорії з метаданими",
      default: ".",
    },
    output: {
      type: "string",
      description: "Шлях для збереження результату",
      default: "./output",
    },
    schema: {
      type: "string",
      description: "SQL schema (default: public)",
      default: "public",
    },
    "enum-strategy": {
      type: "string",
      description: "Стратегія enum: pgEnum, lookupTable",
      default: "pgEnum",
    },
    "constants-strategy": {
      type: "string",
      description: "Стратегія констант: singleTable, separateTables",
      default: "singleTable",
    },
    "output-mode": {
      type: "string",
      description: "Режим виводу: singleFile, perObject",
      default: "singleFile",
    },
  },
  async run({ args }) {
    const inputDir = resolve(args.input)
    const outputDir = resolve(args.output)

    if (args.target !== "postgresql") {
      console.error(`Непідтримувана ціль: ${args.target}. Доступні: postgresql`)
      process.exit(1)
    }

    // Валідація стратегій та побудова options
    let options
    try {
      options = validateGeneratorOptions({
        'enum-strategy': args["enum-strategy"],
        'constants-strategy': args["constants-strategy"],
        'output-mode': args["output-mode"],
        schema: args.schema,
      })
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    // Побудова ProjectModel із метаданих
    let projectModel
    try {
      projectModel = buildProjectModel(inputDir)
    } catch (err) {
      console.error(
        err instanceof Error ? err.message : String(err),
      )
      process.exit(1)
    }

    const generator = new PostgresGenerator()
    const result = generator.generate(projectModel, options)

    // Вивід warnings
    if (result.warnings.length > 0) {
      console.warn("\nПопередження:")
      for (const w of result.warnings) {
        console.warn(`  ⚠ ${w}`)
      }
    }

    // Запис результату
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }

    for (const file of result.files) {
      // Захист від path traversal у згенерованих шляхах
      if (!isSafePath(file.path)) {
        console.error(`Небезпечний шлях у результаті генерації: ${file.path}`)
        process.exit(1)
      }
      const filePath = join(outputDir, file.path)
      writeFileSync(filePath, file.content, "utf-8")
      console.log(`✓ ${file.path}`)
    }

    console.log(`\nГенерація завершена. Файлів: ${result.files.length}`)
  },
})
