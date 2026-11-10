// Статичний тест: пропуск не ховає перевірку (план ПГ-2b, Global
// Constraints). У файлах проєкту `db` — без `.supabase.` і `.postgres.` у
// назві, вони йдуть на кожному стеку — кейс не пропускається за профілем:
// ні `.skip`/`.todo`, ні `skipIf`/`runIf` з умовою, що читає профіль, ні
// порівняння `testRoleFor(…)` з `null`, за яким кейс тихо виходить. Кейс,
// якому потрібна роль чи об'єкт одного провайдера, живе у файлі з суфіксом
// цього провайдера. Винятки — поіменно нижче, з причиною; виняток без збігу —
// збій.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const REPO = fileURLToPath(new URL("../../../../", import.meta.url))

const ROOTS = ["packages/simetra", "packages/designer"]

// Що читає профіль прогону: функції й дані профілю тестів і T0
const PROFILE = /\b(testProvider|testRoleFor|TEST_STACKS|provider)\b|PROVIDER_/
const ROLE_FOR = /\btestRoleFor\(/

/** Файли проєкту `db`: без `.supabase.` і `.postgres.` у назві. */
function isDbFile(file: string): boolean {
  return (
    file.endsWith(".db.test.ts") &&
    !file.includes(".supabase.") &&
    !file.includes(".postgres.")
  )
}

function dbFiles(dir: string): string[] {
  return readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory())
        return entry.name === "node_modules" || entry.name === "dist"
          ? []
          : dbFiles(path)
      return isDbFile(entry.name) ? [path] : []
    }
  )
}

interface Exception {
  file: string
  reason: string
  /** Задача плану ПГ-2b, що прибирає тимчасовий виняток. */
  task?: number
}

const EXCEPTIONS: Exception[] = [
  {
    file: "packages/simetra/test/db/pgtap.db.test.ts",
    reason:
      "it.skip names on the supabase stack that `supabase test db` checks its base state: the runner has no suite there",
  },
  {
    file: "packages/simetra/test/db/row-version.db.test.ts",
    reason:
      "skipIf of a reader role the provider has no: the cases move by profile",
    task: 8,
  },
]

interface Hit {
  file: string
  line: number
  text: string
}

interface Binding {
  name: string
  scope: [number, number]
  at: number
  /** Текст, з якого стала бере значення; без нього (параметр) — не відстежується. */
  source?: string
}

// Оголошення файла з джерелом значення: ініціалізатор сталої чи змінної,
// для деструктуризації й `for … of` — увесь вираз, з якого беруться елементи.
// Параметр функції джерела не має: параметр таблиці кейсів (`describe.each`)
// профілю не читає, а що підставить викликач, статично не видно
function bindingsOf(source: ts.SourceFile): Binding[] {
  const found: Binding[] = []
  const scopeOf = (node: ts.Node): [number, number] => {
    let scope: ts.Node = node.parent
    while (
      !ts.isBlock(scope) &&
      !ts.isSourceFile(scope) &&
      !ts.isForOfStatement(scope) &&
      !ts.isForStatement(scope) &&
      !ts.isForInStatement(scope) &&
      !ts.isFunctionLike(scope)
    )
      scope = scope.parent
    return [scope.getStart(), scope.getEnd()]
  }
  const bind = (
    name: ts.BindingName,
    scope: [number, number],
    from?: string
  ): void => {
    if (ts.isIdentifier(name))
      found.push({ name: name.text, scope, at: name.getStart(), source: from })
    else
      for (const element of name.elements)
        if (!ts.isOmittedExpression(element)) bind(element.name, scope, from)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const loop = node.parent.parent
      const from =
        node.initializer?.getText() ??
        (ts.isForOfStatement(loop) || ts.isForInStatement(loop)
          ? loop.expression.getText()
          : undefined)
      bind(node.name, scopeOf(node), from)
    } else if (ts.isParameter(node))
      bind(node.name, [node.parent.getStart(), node.parent.getEnd()])
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * Чи читає текст `text` у позиції `at` те, що ловить `pattern`: прямо чи
 * через сталу файла, значення якої (транзитивно) його читає. Видиме
 * оголошення — найглибше, область якого містить позицію.
 */
function reads(
  bindings: readonly Binding[],
  pattern: RegExp,
  text: string,
  at: number,
  depth = 0
): boolean {
  if (pattern.test(text)) return true
  if (depth >= 8) return false
  for (const name of new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    const visible = bindings
      .filter((b) => b.name === name && b.scope[0] <= at && at < b.scope[1])
      .sort((a, b) => a.scope[1] - a.scope[0] - (b.scope[1] - b.scope[0]))[0]
    if (
      visible?.source !== undefined &&
      reads(bindings, pattern, visible.source, visible.at, depth + 1)
    )
      return true
  }
  return false
}

const RUNNERS = new Set(["it", "test", "describe"])

// Корінь ланцюжка `it.concurrent.skipIf(…)` чи `describe.each(…).skip`
function runnerOf(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node))
    return RUNNERS.has(node.text) ? node.text : undefined
  if (ts.isPropertyAccessExpression(node)) return runnerOf(node.expression)
  if (ts.isCallExpression(node)) return runnerOf(node.expression)
  return undefined
}

const isNull = (node: ts.Expression): boolean =>
  node.kind === ts.SyntaxKind.NullKeyword

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
])

/** Пропуски за профілем у джерелі `text` файла `file`. */
function hitsOf(file: string, text: string): Hit[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const bindings = bindingsOf(source)
  const hits: Hit[] = []
  const hit = (node: ts.Node, what: string): void => {
    hits.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      text: `${what}: ${node.getText().split("\n")[0]!.slice(0, 80)}`,
    })
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      runnerOf(node.expression) !== undefined
    ) {
      const member = node.name.text
      if (member === "skip" || member === "todo") hit(node, member)
      if (
        (member === "skipIf" || member === "runIf") &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node
      ) {
        const condition = node.parent.arguments[0]
        if (
          condition !== undefined &&
          reads(bindings, PROFILE, condition.getText(), condition.getStart())
        )
          hit(node.parent, `${member} on the profile`)
      }
    }
    // Порівняння ролі профілю з `null`: за ним кейс тихо виходить
    if (
      ts.isBinaryExpression(node) &&
      EQUALITY.has(node.operatorToken.kind) &&
      (isNull(node.left) || isNull(node.right))
    ) {
      const other = isNull(node.left) ? node.right : node.left
      if (reads(bindings, ROLE_FOR, other.getText(), other.getStart()))
        hit(node, "testRoleFor compared with null")
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

function check(
  hits: readonly Hit[],
  exceptions: readonly Exception[]
): { violations: string[]; stale: string[] } {
  const used = new Set<Exception>()
  const violations: string[] = []
  for (const hit of hits) {
    const exception = exceptions.find((e) => e.file === hit.file)
    if (exception === undefined)
      violations.push(`${hit.file}:${hit.line}: ${hit.text}`)
    else used.add(exception)
  }
  return {
    violations,
    stale: exceptions
      .filter((e) => !used.has(e))
      .map((e) => `${e.file}: ${e.reason}`),
  }
}

describe("profile skips in db files", () => {
  const files = ROOTS.flatMap(dbFiles).sort()
  const hits = files.flatMap((file) =>
    hitsOf(file, readFileSync(join(REPO, file), "utf8"))
  )

  it("finds the db files", () => {
    expect(files).toContain("packages/simetra/test/db/access.db.test.ts")
    expect(files.some((f) => f.includes(".supabase."))).toBe(false)
  })

  it("skip no case by the profile outside the named places", () => {
    expect(check(hits, EXCEPTIONS).violations).toEqual([])
  })

  it("name no exception without a match in its file", () => {
    expect(check(hits, EXCEPTIONS).stale).toEqual([])
  })
})

describe("the skip checker", () => {
  const sample = (code: string): string[] =>
    hitsOf("sample.db.test.ts", code).map((h) => h.text.split(":")[0]!)

  it.each([
    ["it.skip", `it.skip("x", () => {})`],
    ["it.todo", `it.todo("x")`],
    ["describe.skip", `describe.skip("x", () => {})`],
    ["it.concurrent.skip", `it.concurrent.skip("x", () => {})`],
  ])("rejects %s", (_, code) => {
    expect(sample(code)).toHaveLength(1)
  })

  it.each([
    ["testProvider()", `it.skipIf(testProvider() === "postgres")("x", f)`],
    ["PROVIDER_ data", `test.runIf(PROVIDER_API_ROLES.x.service)("x", f)`],
    [
      "a constant from the profile",
      `const role = testRoleFor("service")\nit.runIf(role !== undefined)("x", f)`,
    ],
    [
      "a loop over profile data",
      `const api = PROVIDER_API_ROLES[provider]\nconst R = [["a", api.user]]\nfor (const [l, role] of R) it.skipIf(role === undefined)(l, f)`,
    ],
  ])("rejects skipIf/runIf reading %s", (_, code) => {
    expect(sample(code)).toEqual([expect.stringMatching(/on the profile/)])
  })

  // Параметр таблиці кейсів профілю не читає
  it("allows runIf on a parameter of the case table", () => {
    expect(
      sample(
        `describe.each(["a", "b"])("%s", (mode) => { it.runIf(mode === "a")("x", f) })`
      )
    ).toEqual([])
  })

  it.each([
    [
      "directly",
      `it("x", async () => { if (testRoleFor("service") === null) return })`,
    ],
    [
      "through a constant",
      `it("x", async () => { const r = testRoleFor("service"); if (r === null) return })`,
    ],
  ])("rejects testRoleFor compared with null %s", (_, code) => {
    expect(sample(code)).toEqual(["testRoleFor compared with null"])
  })
})
