import { defineCommand } from "citty"
import { writeFileSync, mkdirSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"
import {
  projectSchema,
  projectModelSchema,
  catalogSchema,
  documentSchema,
  enumerationSchema,
  informationRegisterSchema,
  accumulationRegisterSchema,
  constantsFileSchema,
  customTableSchema,
  type Catalog,
  type Document as SimetraDocument,
  type Enumeration,
  type InformationRegister,
  type AccumulationRegister,
  type Constant,
  type CustomTable,
} from "@simetra/core"
import { PostgresGenerator } from "@simetra/generator-pg"
import type { GeneratorOptions } from "@simetra/generator-api"
import { readMetadataFiles } from "../read-metadata"

// Маппінг директорій до kind та відповідних Zod-схем
const DIR_TO_KIND = {
  catalogs: { kind: "Catalog", schema: catalogSchema },
  documents: { kind: "Document", schema: documentSchema },
  enumerations: { kind: "Enumeration", schema: enumerationSchema },
  "information-registers": {
    kind: "InformationRegister",
    schema: informationRegisterSchema,
  },
  "accumulation-registers": {
    kind: "AccumulationRegister",
    schema: accumulationRegisterSchema,
  },
  "custom-tables": { kind: "CustomTable", schema: customTableSchema },
} as const

const VALID_ENUM_STRATEGIES = ["pgEnum", "lookupTable"] as const
const VALID_CONSTANTS_STRATEGIES = ["singleTable", "separateTables"] as const

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

    // Валідація стратегій
    const enumStrategy = args["enum-strategy"]
    if (
      !VALID_ENUM_STRATEGIES.includes(
        enumStrategy as (typeof VALID_ENUM_STRATEGIES)[number]
      )
    ) {
      console.error(
        `Невідома enum-strategy: ${enumStrategy}. Доступні: ${VALID_ENUM_STRATEGIES.join(", ")}`
      )
      process.exit(1)
    }

    const constantsStrategy = args["constants-strategy"]
    if (
      !VALID_CONSTANTS_STRATEGIES.includes(
        constantsStrategy as (typeof VALID_CONSTANTS_STRATEGIES)[number]
      )
    ) {
      console.error(
        `Невідома constants-strategy: ${constantsStrategy}. Доступні: ${VALID_CONSTANTS_STRATEGIES.join(", ")}`
      )
      process.exit(1)
    }

    // Зчитування файлів метаданих
    const metadataFiles = readMetadataFiles(inputDir)

    // Парсинг project.meta.json
    const projectContent = metadataFiles.get("project.meta.json")
    if (!projectContent) {
      console.error(`Файл project.meta.json не знайдено в ${inputDir}`)
      process.exit(1)
    }

    let projectRaw: unknown
    try {
      projectRaw = JSON.parse(projectContent)
    } catch {
      console.error("Помилка парсингу project.meta.json: невалідний JSON")
      process.exit(1)
    }

    const projectResult = projectSchema.safeParse(projectRaw)
    if (!projectResult.success) {
      console.error("Помилка валідації project.meta.json:")
      for (const issue of projectResult.error.issues) {
        console.error(`  - ${issue.path.join(".")}: ${issue.message}`)
      }
      process.exit(1)
    }

    // Збираємо об'єкти метаданих за типами
    const catalogs: Catalog[] = []
    const documents: SimetraDocument[] = []
    const enumerations: Enumeration[] = []
    const informationRegisters: InformationRegister[] = []
    const accumulationRegisters: AccumulationRegister[] = []
    const constants: Constant[] = []
    const customTables: CustomTable[] = []

    for (const [filePath, content] of metadataFiles) {
      if (filePath === "project.meta.json") continue

      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch {
        console.error(`Помилка парсингу ${filePath}: невалідний JSON`)
        process.exit(1)
      }

      // Визначаємо тип за директорією
      const dirName = filePath.split("/")[0]

      // Константи — окремий формат (масив у wrapper)
      if (dirName === "constants") {
        const result = constantsFileSchema.safeParse(parsed)
        if (!result.success) {
          console.error(`Помилка валідації ${filePath}:`)
          for (const issue of result.error.issues) {
            console.error(`  - ${issue.path.join(".")}: ${issue.message}`)
          }
          process.exit(1)
        }
        constants.push(...result.data.constants)
        continue
      }

      // Типові об'єкти метаданих
      const kindInfo = DIR_TO_KIND[dirName as keyof typeof DIR_TO_KIND]
      if (!kindInfo) {
        console.warn(
          `Невідома директорія метаданих: ${dirName}, пропускаємо ${filePath}`
        )
        continue
      }

      const result = kindInfo.schema.safeParse(parsed)
      if (!result.success) {
        console.error(`Помилка валідації ${filePath}:`)
        for (const issue of result.error.issues) {
          console.error(`  - ${issue.path.join(".")}: ${issue.message}`)
        }
        process.exit(1)
      }

      switch (kindInfo.kind) {
        case "Catalog":
          catalogs.push(result.data as Catalog)
          break
        case "Document":
          documents.push(result.data as SimetraDocument)
          break
        case "Enumeration":
          enumerations.push(result.data as Enumeration)
          break
        case "InformationRegister":
          informationRegisters.push(result.data as InformationRegister)
          break
        case "AccumulationRegister":
          accumulationRegisters.push(result.data as AccumulationRegister)
          break
        case "CustomTable":
          customTables.push(result.data as CustomTable)
          break
      }
    }

    // Побудова ProjectModel
    const projectModel = projectModelSchema.parse({
      project: projectResult.data,
      catalogs,
      documents,
      enumerations,
      informationRegisters,
      accumulationRegisters,
      constants,
      customTables,
    })

    const options: GeneratorOptions = {
      enumStrategy: enumStrategy as GeneratorOptions["enumStrategy"],
      constantsStrategy:
        constantsStrategy as GeneratorOptions["constantsStrategy"],
      outputMode: args["output-mode"] as GeneratorOptions["outputMode"],
      schema: args.schema,
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
