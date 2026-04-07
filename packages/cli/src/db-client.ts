import postgres from 'postgres'

export interface DbClient {
  sql: postgres.Sql
}

// Підключення до PostgreSQL з connection string
export async function connect(connectionString: string): Promise<DbClient> {
  const sql = postgres(connectionString, {
    connect_timeout: 10,
    // SSL автоматично через ?sslmode=require у рядку
  })
  // Перевірка з'єднання
  await sql`SELECT 1`
  return { sql }
}

// Виконання SQL у транзакції
export async function executeInTransaction(
  client: DbClient,
  sqlText: string,
): Promise<void> {
  await client.sql.begin(async (tx) => {
    await tx.unsafe(sqlText)
  })
}

// Відключення
export async function disconnect(client: DbClient): Promise<void> {
  await client.sql.end()
}
