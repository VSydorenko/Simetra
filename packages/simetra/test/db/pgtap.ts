// Раннер наборів pgTAP у Vitest: набір іде одним простим запитом у
// транзакції, яку відкриває й відкочує раннер, тож набір не лишає на стеку
// нічого, навіть розширення `pgtap`. Вивід TAP — текст рядків результатів.
// Набір під роллю запиту йде в тегованій копії `simetra_template`: так він
// бачить стан, який платформа дає новій базі, а не базу тестів прогону
import { randomUUID } from "node:crypto"
import pg from "pg"
import {
  PROVIDER_API_ROLES,
  quoteIdent,
  SESSION_CLAIMS_SETTING,
  type ApiRolePurpose,
} from "simetra/model"
import { testDatabaseName } from "./connection"

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

// Під роллю запиту набір не змінює роль сам: сесія раннера — суперкористувач,
// і `set role`/`set session authorization` у наборі пройшли б, а повернення
// до ролі запиту перед кінцем сховало б це від звірки `current_user`.
// `set_config('role', …)` статично не видно (рядок), його ловить та звірка
const ROLE_SWITCH =
  /^(re)?set\s+((local|session)\s+)?(role|session\s+authorization)\b/i

/**
 * Throws when a statement of the suite controls the transaction or is
 * `alter system`: the runner owns the transaction of the suite. With `role`,
 * a role switch (`set role`, `reset role`, `set session authorization`) is
 * refused too: the runner owns the role of the suite. Comments, strings,
 * quoted identifiers and dollar-quoted bodies are not statements.
 */
export function checkSuite(sql: string, opts: { role?: boolean } = {}): void {
  for (const statement of statements(sql)) {
    const match = FORBIDDEN.exec(statement)
    if (match !== null)
      throw new Error(
        `A pgTAP suite must not contain ${/^alter/i.test(match[1] ?? "") ? "alter system" : "transaction control"} ("${statement.slice(0, 60)}"): the runner opens the transaction and rolls it back`
      )
    if (opts.role === true && ROLE_SWITCH.test(statement))
      throw new Error(
        `A pgTAP suite under a request role must not contain a role switch ("${statement.slice(0, 60)}"): the runner sets the role and checks it after the suite`
      )
  }
}

/** How the runner runs a suite: under a request role, with session claims. */
export interface PgTapOptions {
  role?: string
  claims?: Record<string, unknown>
}

// Заголовок — перший рядок набору: так його видно, не розбираючи SQL
const HEADER = /^--\s*pgtap:(.*)$/
const HEADER_BODY = /^\s*role=(\S+)\s+claims=(.+?)\s*$/

/**
 * Options of suite `sql` from its first line
 * `-- pgtap: role=<purpose> claims=<json>`; `undefined` — no header, the
 * suite runs as is. `roleFor` maps a purpose to the role of the profile.
 */
export function suiteOptions(
  sql: string,
  roleFor: (purpose: ApiRolePurpose) => string | null
): PgTapOptions | undefined {
  const header = HEADER.exec(sql.split("\n", 1)[0] ?? "")
  if (header === null) return undefined
  const body = HEADER_BODY.exec(header[1] ?? "")
  if (body === null)
    throw new Error(
      `A malformed pgtap header "${header[0]}": write -- pgtap: role=<purpose> claims=<json>`
    )
  const purpose = body[1] ?? ""
  // Перелік призначень — ключі ролей API профілю, однакові в усіх профілях
  if (!Object.hasOwn(PROVIDER_API_ROLES.postgres, purpose))
    throw new Error(
      `An unknown role purpose "${purpose}" in the pgtap header: use ${Object.keys(PROVIDER_API_ROLES.postgres).join(", ")}`
    )
  const role = roleFor(purpose as ApiRolePurpose)
  if (role === null)
    throw new Error(
      `The pgtap header asks for the ${purpose} role, and the profile has no ${purpose} role`
    )
  let claims: unknown
  try {
    claims = JSON.parse(body[2] ?? "")
  } catch {
    claims = undefined
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims))
    throw new Error(
      `The claims of the pgtap header must be a JSON object: ${body[2]}`
    )
  return { role, claims: claims as Record<string, unknown> }
}

// Символ, що може стояти в ідентифікаторі чи числі: після нього `$y$` — ще
// ідентифікатор, а не початок dollar-quote
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
  // Чи попередній токен — ідентифікатор (чи число), що впритул триває. Саме
  // токен, а не символ: `$`, що закрив dollar-quote, ідентифікатора не
  // продовжує, і `$$a$$E'…'` лексер Postgres читає як E-рядок
  let prevIdent = false
  // Кінець рядка з лапкою на позиції `from`; у `E'…'` зворотна скісна
  // екранує наступний символ, і `\'` рядка не закриває
  const skipQuoted = (from: number, escapes: boolean): number => {
    const quote = sql[from]
    let j = from + 1
    for (; j < sql.length; j++) {
      if (escapes && sql[j] === "\\") j++
      else if (sql[j] === quote) {
        // Подвоєна лапка — екранована, рядок триває
        if (sql[j + 1] === quote) j++
        else break
      }
    }
    return j + 1
  }
  for (let i = 0; i < sql.length;) {
    const rest = sql.slice(i)
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i)
      i = end === -1 ? sql.length : end
      out += " "
      prevIdent = false
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
      prevIdent = false
      continue
    }
    const dollar = prevIdent
      ? null
      : /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(rest)
    if (dollar !== null) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length)
      i = end === -1 ? sql.length : end + dollar[0].length
      out += " "
      prevIdent = false
      continue
    }
    // `E'` на початку токена — E-рядок: лексер бере довший збіг, ніж
    // ідентифікатор `E`
    const eString = !prevIdent && /^[Ee]'/.test(rest)
    if (eString || sql[i] === "'" || sql[i] === '"') {
      i = eString ? skipQuoted(i + 1, true) : skipQuoted(i, false)
      out += " "
      prevIdent = false
      continue
    }
    // Ідентифікатор цілком: обрізаний `case1` рахувався б як `case`
    const word = prevIdent
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
        prevIdent = true
        continue
      }
      out += atomic > 0 ? " " : word[0]
      i += word[0].length
      prevIdent = true
      continue
    }
    // Крапка з комою в тілі `begin atomic` не ділить оператора набору
    out += atomic > 0 ? " " : sql[i]
    prevIdent = IDENT.test(sql[i] ?? "")
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

/** The part of a client the runner uses on its connection. */
export interface SuiteClient {
  query(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[] }>
}

/**
 * Runs suite `sql` on `client` in a transaction it rolls back. With `role`:
 * `pgtap` first (the request role cannot create it), the claims as
 * `SESSION_CLAIMS_SETTING`, `SET LOCAL ROLE`, the suite, then a check that
 * the suite ended as `role`.
 */
export async function runSuite(
  client: SuiteClient,
  sql: string,
  opts: PgTapOptions = {}
): Promise<TapResult> {
  checkSuite(sql, { role: opts.role !== undefined })
  try {
    await client.query("BEGIN")
    // Локальне налаштування живе лише до кінця транзакції: `commit` чи
    // `rollback`, що проскочив повз `checkSuite`, його скидає
    const marker = randomUUID()
    await client.query("select set_config($1, $2, true)", [MARKER, marker])
    if (opts.role !== undefined)
      await client.query("create extension if not exists pgtap")
    if (opts.claims !== undefined)
      await client.query("select set_config($1, $2, true)", [
        SESSION_CLAIMS_SETTING,
        JSON.stringify(opts.claims),
      ])
    if (opts.role !== undefined)
      await client.query(`SET LOCAL ROLE ${quoteIdent(opts.role)}`)
    // Без параметрів node-postgres шле простий запит: увесь набір — одним
    // викликом, і результат — масив, по одному на оператор
    const results = (await client.query(sql)) as unknown as
      pg.QueryResult | pg.QueryResult[]
    const { rows } = await client.query(
      "select current_setting($1, true) as value, current_user::text as role",
      [MARKER]
    )
    if (rows[0]?.value !== marker)
      throw new Error(
        "The pgTAP suite ended the runner's transaction (a commit or rollback got past checkSuite): what it did may be committed on the stack — check it by hand"
      )
    if (opts.role !== undefined && rows[0]?.role !== opts.role)
      throw new Error(
        `The pgTAP suite ended as ${String(rows[0]?.role)}, not ${opts.role}: a role switch got past checkSuite`
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
  }
}

/**
 * Runs suite `sql` on a new client per suite and parses the text of every
 * result row as TAP. `url` is the stack superuser. Without options the suite
 * runs in the database of `url`; with `role` or `claims` the runner creates a
 * run-tagged copy of `simetra_template`, runs the suite there and drops the
 * copy. An SQL error of the suite rejects with the Postgres message; so does
 * a suite that ended the runner's transaction or its role.
 */
export async function runPgTap(
  url: string,
  sql: string,
  opts: PgTapOptions = {}
): Promise<TapResult> {
  if (opts.role === undefined && opts.claims === undefined)
    return onClient(url, (client) => runSuite(client, sql))
  // Перевірка до створення бази: відхилений набір не коштує копії шаблону
  checkSuite(sql, { role: opts.role !== undefined })
  const name = testDatabaseName("pgtap")
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  try {
    // Копію створює й видаляє суперкористувач: до шаблону з
    // `datallowconn = false` раннер не під'єднується, а `TEMPLATE` його
    // копіює без з'єднання
    await admin.query(
      `CREATE DATABASE ${quoteIdent(name)} TEMPLATE simetra_template`
    )
    const target = new URL(url)
    target.pathname = `/${name}`
    return await onClient(target.toString(), (client) =>
      runSuite(client, sql, opts)
    )
  } finally {
    // `FORCE` — на випадок бекенда клієнта набору, що ще не завершився після
    // обірваного з'єднання: копія — лише цього раннера
    await admin.query(
      `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`
    )
    await admin.end()
  }
}

async function onClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}
