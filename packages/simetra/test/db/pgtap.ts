// Раннер наборів pgTAP у Vitest: набір іде одним простим запитом у
// транзакції, яку відкриває й відкочує раннер, тож набір не лишає на стеку
// нічого, навіть розширення `pgtap`. Вивід TAP — текст рядків результатів.
import { randomUUID } from "node:crypto"
import pg from "pg"

/** What a pgTAP suite reported. */
export interface TapResult {
  /** `null` — the output had no plan line. */
  planned: number | null
  passed: number[]
  failed: { n: number; line: string; diag: string[] }[]
  bailOut: string | null
}

/**
 * Parses TAP lines; `# …` lines after a failed test are its diagnostics. A
 * `not ok … # TODO` counts as failed on purpose: a base-state suite has no
 * expected failures, and a TODO left in it must not turn green.
 */
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

// Символ, що може стояти в ідентифікаторі: `x$y$` — ідентифікатор, а не
// початок dollar-quote, а `e'…'` після нього — не рядок з екрануванням
const IDENT = /[A-Za-z0-9_$\u0080-\uffff]/

// Текст набору без коментарів, рядків, тіл у dollar-quote і тіл `begin atomic
// … end`, поділений за `;`. Сканер, а не регулярні вирази: `$$` усередині
// рядка чи `--` у тілі функції інакше зламали б поділ. Розсинхрон сканера з
// лексером Postgres — це пропущений `commit`, тож правила лексера повторено
// там, де вони змінюють межі рядка
const ROUTINE_HEADER = /^\s*create\s+(or\s+replace\s+)?(function|procedure)\b/i

function statements(sql: string): string[] {
  let out = ""
  // Глибина `begin atomic`: усередині оператори тіла функції, а `case … end`
  // закривається тим самим `end`
  let atomic = 0
  const identAt = (j: number): boolean => j >= 0 && IDENT.test(sql[j] ?? "")
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
    const dollar = identAt(i - 1)
      ? null
      : /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(rest)
    if (dollar !== null) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length)
      i = end === -1 ? sql.length : end + dollar[0].length
      out += " "
      continue
    }
    const quote = sql[i]
    if (quote === "'" || quote === '"') {
      // `E'…'`: зворотна скісна екранує наступний символ, і `\'` рядка не
      // закриває
      const escapes =
        quote === "'" && /[Ee]/.test(sql[i - 1] ?? "") && !identAt(i - 2)
      for (i++; i < sql.length; i++) {
        if (escapes && sql[i] === "\\") i++
        else if (sql[i] === quote) {
          // Подвоєна лапка — екранована, рядок триває
          if (sql[i + 1] === quote) i++
          else break
        }
      }
      i++
      out += " "
      continue
    }
    // Ідентифікатор цілком: обрізаний `case1` рахувався б як `case`
    const word = identAt(i - 1)
      ? null
      : /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/.exec(rest)
    if (word !== null) {
      const lower = word[0].toLowerCase()
      // Тіло `begin atomic` буває лише в заголовку `create … function |
      // procedure` того самого оператора: деінде `begin atomic` — імена
      // колонок, і відкрите на них «тіло» сховало б `commit` після них
      const opensAtomic =
        atomic === 0 &&
        lower === "begin" &&
        /^begin\s+atomic\b/i.test(rest) &&
        ROUTINE_HEADER.test(out.slice(out.lastIndexOf(";") + 1))
      if (opensAtomic || (atomic > 0 && lower === "case")) atomic++
      else if (atomic > 0 && lower === "end") {
        atomic--
        i += word[0].length
        out += " "
        continue
      }
      out += atomic > 0 ? " " : word[0]
      i += word[0].length
      continue
    }
    // Крапка з комою в тілі `begin atomic` не ділить оператора набору
    out += atomic > 0 ? " " : sql[i]
    i++
  }
  // Незакрите тіло поглинуло б решту набору разом з будь-яким `commit` у ній
  if (atomic > 0)
    throw new Error(
      "A pgTAP suite has a begin atomic body without its end: the runner cannot tell its statements apart"
    )
  return out
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "")
}

// Ім'я локального налаштування-позначки транзакції раннера
const MARKER = "simetra.pgtap_runner"

/**
 * Runs suite `sql` at `url` in a transaction it rolls back, on a new client
 * per suite, and parses the text of every result row as TAP. An SQL error of
 * the suite rejects with the Postgres message; so does a suite that ended the
 * runner's transaction.
 */
export async function runPgTap(url: string, sql: string): Promise<TapResult> {
  checkSuite(sql)
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query("BEGIN")
    // Локальне налаштування живе лише до кінця транзакції: `commit` чи
    // `rollback`, що проскочив повз `checkSuite`, його скидає
    const marker = randomUUID()
    await client.query("select set_config($1, $2, true)", [MARKER, marker])
    // Без параметрів node-postgres шле простий запит: увесь набір — одним
    // викликом, і результат — масив, по одному на оператор
    const results = (await client.query(sql)) as unknown as
      pg.QueryResult | pg.QueryResult[]
    const { rows } = await client.query<{ value: string | null }>(
      "select current_setting($1, true) as value",
      [MARKER]
    )
    if (rows[0]?.value !== marker)
      throw new Error(
        "The pgTAP suite ended the runner's transaction (a commit or rollback got past checkSuite): what it did may be committed on the stack — check it by hand"
      )
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
    // сервер і так відкочує транзакцію клієнта, що від'єднався. Кінець
    // транзакції набором ловить позначка вище, а не цей виклик
    await client.query("ROLLBACK").catch(() => {})
    await client.end()
  }
}
