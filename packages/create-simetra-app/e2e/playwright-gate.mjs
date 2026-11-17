// Червоне на хибно-зеленому: Playwright виходить з 0, коли тест пропущено
// (`skipped`), нестабільний (`flaky`), перервано чи тестів узагалі нуль. Крок
// читає JSON-звіт прогону й відмовляє на кожному з цих випадків.
import { readFileSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** Усі тести звіту: статус тесту й статуси спроб. */
function* tests(suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      yield {
        title: spec.title,
        status: test.status,
        results: test.results ?? [],
      }
    }
  }
  for (const child of suite.suites ?? []) yield* tests(child)
}

/** Причини відмови; порожній масив — звіт чистий. */
export function checkReport(report) {
  const found = []
  for (const suite of report.suites ?? []) found.push(...tests(suite))
  const problems = []
  if (found.length === 0) problems.push("the report has no tests")
  for (const { title, status, results } of found) {
    if (status !== "expected") problems.push(`${status}: ${title}`)
    else if (results.some((r) => r.status === "interrupted"))
      problems.push(`interrupted: ${title}`)
  }
  if ((report.errors ?? []).length > 0)
    problems.push(`the report carries ${report.errors.length} error(s)`)
  return problems
}

function invokedAsCommand() {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return (
      realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
    )
  } catch {
    return false
  }
}

if (invokedAsCommand()) {
  const path = process.argv[2] ?? "test-results/report.json"
  let report
  try {
    report = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    console.error(`playwright-gate: cannot read ${path}: ${error.message}`)
    process.exit(1)
  }
  const problems = checkReport(report)
  if (problems.length > 0) {
    for (const p of problems) console.error(`playwright-gate: ${p}`)
    process.exit(1)
  }
  console.log("playwright-gate: every test ran and passed on the first try")
}
