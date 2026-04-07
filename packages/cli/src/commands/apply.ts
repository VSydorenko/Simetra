import { defineCommand } from 'citty'
import { PostgresGenerator } from '@simetra/generator-pg'
import { buildProjectModel } from '../build-model'
import { validateGeneratorOptions } from '../validate-options'
import { connect, executeInTransaction, disconnect } from '../db-client'

// Приховує credentials із connection string у тексті помилки
function sanitizeError(message: string, connectionString: string): string {
  if (!connectionString) return message
  // Вилучаємо userinfo частину (user:password@)
  try {
    const url = new URL(connectionString)
    const sensitiveparts = [
      connectionString,
      url.password,
      url.username,
      `${url.username}:${url.password}`,
    ].filter(Boolean)
    let sanitized = message
    for (const part of sensitiveparts) {
      if (part && sanitized.includes(part)) {
        sanitized = sanitized.replaceAll(part, '[credentials hidden]')
      }
    }
    return sanitized
  } catch {
    // Якщо URL невалідний — замінюємо весь connection string
    return message.replaceAll(connectionString, '[credentials hidden]')
  }
}

export const apply = defineCommand({
  meta: {
    name: 'apply',
    description: 'Застосування згенерованого SQL на PostgreSQL',
  },
  args: {
    'connection-string': {
      type: 'string',
      description:
        'PostgreSQL connection string (або env SIMETRA_DATABASE_URL)',
    },
    input: {
      type: 'string',
      description: 'Шлях до директорії з метаданими',
      default: '.',
    },
    schema: {
      type: 'string',
      description: 'SQL schema (default: public)',
      default: 'public',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Показати SQL без виконання',
      default: false,
    },
    'enum-strategy': {
      type: 'string',
      description: 'Стратегія enum: pgEnum, lookupTable',
      default: 'pgEnum',
    },
    'constants-strategy': {
      type: 'string',
      description: 'Стратегія констант: singleTable, separateTables',
      default: 'singleTable',
    },
  },
  async run({ args }) {
    // 1. Отримання connection string
    const connectionString =
      args['connection-string'] || process.env.SIMETRA_DATABASE_URL || ''

    if (!args['dry-run']) {
      if (!connectionString) {
        console.error(
          'Connection string не вказано. Використай --connection-string або env SIMETRA_DATABASE_URL',
        )
        process.exit(1)
      }

      if (
        !connectionString.startsWith('postgres://') &&
        !connectionString.startsWith('postgresql://')
      ) {
        console.error(
          'Connection string має починатися з postgres:// або postgresql://',
        )
        process.exit(1)
      }

      // Валідація URL-структури connection string
      try {
        const url = new URL(connectionString)
        if (!url.hostname) {
          console.error('Connection string не містить hostname')
          process.exit(1)
        }
      } catch {
        console.error(
          'Connection string не є валідним URL. Очікуваний формат: postgresql://user:password@host:port/database',
        )
        process.exit(1)
      }
    }

    // 2. Валідація стратегій та побудова options
    let options
    try {
      options = validateGeneratorOptions({
        'enum-strategy': args['enum-strategy'],
        'constants-strategy': args['constants-strategy'],
        schema: args.schema,
      })
      // apply завжди використовує singleFile
      options.outputMode = 'singleFile'
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    // 3. Побудова ProjectModel із метаданих
    let projectModel
    try {
      projectModel = buildProjectModel(args.input)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    // 4. Генерація SQL
    const generator = new PostgresGenerator()
    const result = generator.generate(projectModel, options)

    // Вивід warnings
    if (result.warnings.length > 0) {
      console.warn('\nПопередження:')
      for (const w of result.warnings) {
        console.warn(`  ⚠ ${w}`)
      }
    }

    // Об'єднуємо весь SQL в один блок
    const sqlText = result.files.map((f) => f.content).join('\n\n')

    // 5. Dry-run — вивести SQL і вийти
    if (args['dry-run']) {
      console.log(sqlText)
      return
    }

    // 6. Підключення та виконання
    let client
    try {
      console.log('Підключення до PostgreSQL...')
      client = await connect(connectionString)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(
        `Помилка підключення: ${sanitizeError(msg, connectionString)}`,
      )
      process.exit(1)
    }

    try {
      console.log('Виконання SQL у транзакції...')
      await executeInTransaction(client, sqlText)

      // Підсумок виконання
      const tableCount = (sqlText.match(/CREATE TABLE/gi) || []).length
      const indexCount = (sqlText.match(/CREATE INDEX/gi) || []).length
      const functionCount = (
        sqlText.match(/CREATE OR REPLACE FUNCTION/gi) || []
      ).length
      console.log(
        `\n✓ SQL успішно застосовано.` +
          `\n  Таблиць: ${tableCount}` +
          `\n  Індексів: ${indexCount}` +
          `\n  Функцій: ${functionCount}` +
          `\n  Схема: ${args.schema}`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(
        `Помилка виконання SQL: ${sanitizeError(msg, connectionString)}`,
      )
      process.exit(1)
    } finally {
      await disconnect(client)
    }
  },
})
