// Раннер наборів pgTAP у Vitest: набір іде одним простим запитом у
// транзакції, яку відкриває й відкочує раннер, тож набір не лишає на стеку
// нічого, навіть розширення `pgtap`. Вивід TAP — текст рядків результатів.
import pg from "pg"

/** What a pgTAP suite reported. */
export interface TapResult {
  /** `null` — the output had no plan line. */
  planned: number | null
  passed: number[]
  failed: { n: number; line: string; diag: string[] }[]
  bailOut: string | null
}

/** Parses TAP lines; `# …` lines after a failed test are its diagnostics. */
export function parseTap(lines: readonly string[]): TapResult {
  const result: TapResult = {
    planned: null,
    passed: [],
    failed: [],
    bailOut: null,
  }
  let last: TapResult["failed"][number] | undefined
  for (const raw of lines) {
    const line = raw.trimEnd()
    const plan = /^1\.\.(\d+)/.exec(line)
    const test = /^(not )?ok (\d+)\b/.exec(line)
    if (plan !== null) result.planned = Number(plan[1])
    else if (test !== null) {
      const n = Number(test[2])
      if (test[1] === undefined) {
        result.passed.push(n)
        last = undefined
      } else {
        last = { n, line, diag: [] }
        result.failed.push(last)
      }
    } else if (line.startsWith("Bail out!"))
      result.bailOut = line.slice("Bail out!".length).trim()
    else if (line.startsWith("#") && last !== undefined)
      last.diag.push(line.slice(1).trim())
  }
  return result
}

// Оператор, що керує транзакцією, звільнив би набір з-під `ROLLBACK` раннера:
// `commit` зафіксував би все, що набір створив, на спільному стеку. `alter
// system` пише поза транзакцією — у postgresql.auto.conf
const FORBIDDEN =
  /^(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction|alter\s+system)\b/i

/**
 * Throws when a statement of the suite controls the transaction or is
 * `alter system`: the runner owns the transaction of the suite. Comments,
 * strings, quoted identifiers and dollar-quoted bodies are not statements.
 */
export function checkSuite(sql: string): void {
  for (const statement of statements(sql)) {
    const match = FORBIDDEN.exec(statement)
    if (match !== null)
      throw new Error(
        `A pgTAP suite must not contain ${/^alter/i.test(match[1] ?? "") ? "alter system" : "transaction control"} ("${statement.slice(0, 60)}"): the runner opens the transaction and rolls it back`
      )
  }
}

// Текст набору без коментарів, рядків і тіл у dollar-quote, поділений за `;`.
// Сканер, а не регулярні вирази: `$$` усередині рядка чи `--` у тілі функції
// інакше зламали б поділ
function statements(sql: string): string[] {
  let out = ""
  for (let i = 0; i < sql.length;) {
    const rest = sql.slice(i)
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i)
      i = end === -1 ? sql.length : end
      out += " "
      continue
    }
    if (rest.startsWith("/*")) {
      // Блокові коментарі Postgres вкладаються
      let depth = 0
      do {
        if (sql.startsWith("/*", i)) {
          depth++
          i += 2
        } else if (sql.startsWith("*/", i)) {
          depth--
          i += 2
        } else i++
      } while (depth > 0 && i < sql.length)
      out += " "
      continue
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest)
    if (dollar !== null) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length)
      i = end === -1 ? sql.length : end + dollar[0].length
      out += " "
      continue
    }
    const quote = sql[i]
    if (quote === "'" || quote === '"') {
      // Подвоєна лапка — екранована, рядок триває
      for (i++; i < sql.length; i++)
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) i++
          else break
        }
      i++
      out += " "
      continue
    }
    out += sql[i]
    i++
  }
  return out
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "")
}

/**
 * Runs suite `sql` at `url` in a transaction it rolls back, on a new client
 * per suite, and parses the text of every result row as TAP. An SQL error of
 * the suite rejects with the Postgres message.
 */
export async function runPgTap(url: string, sql: string): Promise<TapResult> {
  checkSuite(sql)
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query("BEGIN")
    // Без параметрів node-postgres шле простий запит: увесь набір — одним
    // викликом, і результат — масив, по одному на оператор
    const results = (await client.query(sql)) as unknown as
      pg.QueryResult | pg.QueryResult[]
    const lines = (Array.isArray(results) ? results : [results]).flatMap(
      (result) =>
        result.rows.flatMap((row: Record<string, unknown>) =>
          Object.values(row).flatMap((value) =>
            typeof value === "string" ? value.split("\n") : []
          )
        )
    )
    return parseTap(lines)
  } finally {
    // Збій `ROLLBACK` (обірване з'єднання) не має затерти помилку набору:
    // сервер і так відкочує транзакцію клієнта, що від'єднався
    await client.query("ROLLBACK").catch(() => {})
    await client.end()
  }
}
