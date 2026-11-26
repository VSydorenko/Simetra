import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

/*
 * Страж осідання відповіді читання (план SK-2, Р-SK2-10; спека ядра синхронізації
 * §3, рядок SK-2). Кожна точка, що пише відповідь читання, кличе прохід
 * осідання `settlePass`, а його кроки — єдині місця своїх дій. Правила — за
 * символами type checker-а, не за іменами: псевдонім, деструктуризація, передача
 * функції значенням і помічник в іншому модулі не обходять їх.
 *
 * Крок гачка — властивість об'єкта, чий контекстний тип є `SettleHooks`
 * (також через `Pick` у `settleView`); його номер — за іменем властивості.
 *
 * (1) Брама епох відповіді (`acceptEpoch(s)`) — лише гачок кроку 4.
 * (2) Записи відповіді (`StoreOps.put/remove/putSection`, `Writer.apply`,
 *     `patchRows`, `removeKeys`, виклик замикання `Write`) — лише гачок кроку 5
 *     і помічники та замикання, досяжні тільки з нього.
 * (3) `sweep` — лише гачок кроку 8.
 * (4) `settleRequirement`, `liftRequirement`, `confirm` і присвоєння
 *     `refreshedAt`, `okReadEpoch`, `failures`, `failedAt` — лише в єдиному
 *     `settleTarget` (другий шов — червоний).
 * (5) `settle(lease, …)` не існує.
 * (6) Кожна точка Р-SK2-1 знайдена й досягає проходу.
 */

const DATA = join(import.meta.dirname, "..", "..")
const STORE = join(DATA, "store")

const BASE_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
}

/** Крок «поза проходом»: виклик з місця, яке не є гачком чи замиканням запису. */
const OUTSIDE = "outside"

/** Номер кроку проходу за іменем гачка (`SettleHooks`). */
const STEP_OF_HOOK: Readonly<Record<string, string>> = {
  quiet: "0",
  invalid: "1",
  lost: "1",
  barrier: "2",
  refused: "3",
  failureDetail: "3",
  readFailed: "3",
  beforeGate: "3",
  gate: "4",
  // Власна мітка: брама епох у гачку відкинутої відповіді — не крок 4.
  discarded: "4d",
  apply: "5",
  // Журнал збою застосування й перевірка скинутої сторінки не пишуть відповідь.
  applyFailed: "5x",
  dropped: "5x",
  marks: "6",
  settleTarget: "7",
  evidence: "7",
  sweep: "8",
  finish: "9",
  settled: "9",
}

type Kind = "accept" | "write" | "sweep" | "seam" | "field" | "settle-lease"

/** Дозволені кроки за видом; `seam`, `field` — лише єдина функція шва. */
const ALLOWED_STEPS: Readonly<Record<string, readonly string[]>> = {
  accept: ["4"],
  write: ["5"],
  sweep: ["8"],
}

interface Anchors {
  readonly hooks: { file: string; iface: string }
  readonly session: { file: string; iface: string; members: readonly string[] }
  readonly ops: {
    file: string
    iface: string
    write: readonly string[]
    sweep: string
  }
  readonly writer: { file: string; iface: string; member: string }
  readonly gated: { file: string; iface: string; member: string }
  /** Псевдонім типу замикання запису відповіді. */
  readonly writeAlias: { file: string; name: string }
  readonly internal: { file: string; names: readonly string[] }
  readonly subset: {
    file: string
    iface: string
    fields: readonly string[]
    seam: string
    /** Помічники шва: їхні виклики — лише в шві чи в них самих. */
    helpers: readonly string[]
  }
  readonly pass: { file: string; names: readonly string[] }
  /** Точки Р-SK2-1: `[файл, функція]`. */
  readonly points: readonly (readonly [string, string])[]
}

interface Finding {
  readonly place: string
  readonly kind: Kind
  readonly line: number
}

const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n)

function analyze(
  program: ts.Program,
  files: readonly string[],
  A: Anchors,
  label: (file: string) => string
) {
  const checker = program.getTypeChecker()
  const resolve = (s: ts.Symbol | undefined): ts.Symbol | undefined =>
    s !== undefined && s.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(s)
      : s

  const source = (file: string) => program.getSourceFile(file)
  const interfaceSymbol = (file: string, name: string) => {
    const decl = source(file)?.statements.find(
      (s): s is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(s) && s.name.text === name
    )
    return decl === undefined
      ? undefined
      : checker.getSymbolAtLocation(decl.name)
  }
  const memberOf = (file: string, iface: string, member: string) =>
    interfaceSymbol(file, iface)?.members?.get(member as ts.__String)
  const functionSymbol = (file: string, name: string) => {
    const decl = source(file)?.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === name
    )
    return decl?.name === undefined
      ? undefined
      : checker.getSymbolAtLocation(decl.name)
  }
  const named = (...symbols: (ts.Symbol | undefined)[]) =>
    symbols.filter((s): s is ts.Symbol => s !== undefined)

  // ---------------------------------------------------- захищені символи
  // Ключ — оголошення: член `Pick<…>` (контекст читача) дає інший символ з тим самим оголошенням.
  const protectedKind = new Map<ts.Node, Kind>()
  const declOf = (s: ts.Symbol) => s.declarations?.[0]
  for (const m of A.session.members)
    for (const s of named(memberOf(A.session.file, A.session.iface, m)))
      protectedKind.set(declOf(s)!, "accept")
  for (const m of A.ops.write)
    for (const s of named(memberOf(A.ops.file, A.ops.iface, m)))
      protectedKind.set(declOf(s)!, "write")
  for (const s of named(
    memberOf(A.writer.file, A.writer.iface, A.writer.member),
    memberOf(A.gated.file, A.gated.iface, A.gated.member),
    ...A.internal.names.map((n) => functionSymbol(A.internal.file, n))
  ))
    protectedKind.set(declOf(s)!, "write")
  for (const s of named(memberOf(A.ops.file, A.ops.iface, A.ops.sweep)))
    protectedKind.set(declOf(s)!, "sweep")
  const seamSymbol = functionSymbol(A.subset.file, A.subset.seam)
  const helperSymbols = new Set(
    named(...A.subset.helpers.map((n) => functionSymbol(A.subset.file, n)))
  )
  for (const s of helperSymbols) protectedKind.set(declOf(s)!, "seam")
  const fieldDecls = new Set(
    A.subset.fields.flatMap((f) =>
      named(memberOf(A.subset.file, A.subset.iface, f)).map(declOf)
    )
  )
  const passSymbols = new Set(
    named(...A.pass.names.map((n) => functionSymbol(A.pass.file, n)))
  )

  // ------------------------------------------------------- крок гачка
  const stepOfProperty = (p: ts.Node): string | undefined => {
    if (
      !(
        ts.isPropertyAssignment(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isShorthandPropertyAssignment(p)
      ) ||
      !ts.isObjectLiteralExpression(p.parent) ||
      !ts.isIdentifier(p.name)
    )
      return undefined
    const type = checker.getContextualType(p.parent)
    const decl = type?.getProperty(p.name.text)?.declarations?.[0]
    if (
      decl === undefined ||
      !ts.isInterfaceDeclaration(decl.parent) ||
      decl.parent.name.text !== A.hooks.iface ||
      decl.getSourceFile().fileName !== A.hooks.file
    )
      return undefined
    return STEP_OF_HOOK[p.name.text] ?? "?"
  }

  const isWriteClosure = (fn: ts.Node) => {
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
    const isWrite = (t: ts.Type | undefined) =>
      t?.aliasSymbol?.name === A.writeAlias.name &&
      t.aliasSymbol.declarations?.[0]?.getSourceFile().fileName ===
        A.writeAlias.file
    const type = checker.getContextualType(fn)
    const parts = type === undefined ? [] : type.isUnion() ? type.types : [type]
    if (parts.some(isWrite)) return true
    // `return (scope) => …` в async-функції з `Promise<Write>`: контекстний тип
    // втрачає псевдонім, тож беремо оголошений тип результату.
    const owner = ts.isReturnStatement(fn.parent)
      ? fn.parent.parent.parent
      : fn.parent
    if (!isFn(owner) || owner.type === undefined) return false
    const declared =
      ts.isTypeReferenceNode(owner.type) &&
      owner.type.typeName.getText() === "Promise" &&
      owner.type.typeArguments?.[0] !== undefined
        ? owner.type.typeArguments[0]
        : owner.type
    return isWrite(checker.getTypeFromTypeNode(declared))
  }

  /** Ключ функції: символ, за яким її кличуть. Безіменна — без ключа. */
  const keyOf = (fn: ts.Node): ts.Symbol | undefined => {
    if (ts.isFunctionDeclaration(fn))
      return fn.name === undefined
        ? undefined
        : checker.getSymbolAtLocation(fn.name)
    if (
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      ts.isVariableDeclaration(fn.parent) &&
      ts.isIdentifier(fn.parent.name)
    )
      return checker.getSymbolAtLocation(fn.parent.name)
    const prop = ts.isMethodDeclaration(fn)
      ? fn
      : ts.isPropertyAssignment(fn.parent) && fn.parent.initializer === fn
        ? fn.parent
        : undefined
    if (prop !== undefined && ts.isIdentifier(prop.name)) {
      if (ts.isObjectLiteralExpression(prop.parent)) {
        const contextual = checker
          .getContextualType(prop.parent)
          ?.getProperty(prop.name.text)
        if (contextual !== undefined) return contextual
      }
      return checker.getSymbolAtLocation(prop.name)
    }
    return undefined
  }

  // ---------------------------------------------- посилання на символи
  interface Ref {
    readonly node: ts.Node
    readonly symbol: ts.Symbol
  }
  const refs: Ref[] = []
  const refsOf = new Map<ts.Symbol, Ref[]>()
  const isDeclName = (n: ts.Identifier) => {
    const p = n.parent
    return (
      ((ts.isFunctionDeclaration(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isPropertySignature(p) ||
        ts.isMethodSignature(p) ||
        ts.isInterfaceDeclaration(p) ||
        ts.isVariableDeclaration(p) ||
        ts.isParameter(p) ||
        ts.isPropertyAssignment(p) ||
        ts.isPropertyDeclaration(p) ||
        ts.isImportSpecifier(p) ||
        ts.isTypeAliasDeclaration(p)) &&
        p.name === n) ||
      (ts.isBindingElement(p) && (p.name === n || p.propertyName === n))
    )
  }
  const addRef = (node: ts.Node, symbol: ts.Symbol | undefined) => {
    const resolved = resolve(symbol)
    if (resolved === undefined) return
    const ref = { node, symbol: resolved }
    refs.push(ref)
    const list = refsOf.get(resolved) ?? []
    list.push(ref)
    refsOf.set(resolved, list)
  }
  for (const file of files) {
    const sf = source(file)!
    const visit = (n: ts.Node): void => {
      if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
        // Деструктуризація члена: використання — у самому шаблоні.
        const name = (n.propertyName ?? n.name) as ts.Identifier
        if (ts.isIdentifier(name))
          addRef(
            n,
            checker.getTypeAtLocation(n.parent).getProperty(name.text) ??
              checker.getSymbolAtLocation(name)
          )
      } else if (ts.isIdentifier(n) && !isDeclName(n)) {
        addRef(
          n,
          ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n
            ? checker.getShorthandAssignmentValueSymbol(n.parent)
            : checker.getSymbolAtLocation(n)
        )
      }
      if (
        ts.isElementAccessExpression(n) &&
        ts.isStringLiteralLike(n.argumentExpression)
      )
        addRef(n, checker.getSymbolAtLocation(n.argumentExpression))
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }

  // ------------------------------------------------------ контекст місця
  interface Context {
    /** Гачок кроку, замикання `Write` чи ключ функції; порожній — верхній рівень. */
    readonly step?: string
    readonly fn?: ts.Symbol
    /** Найближча іменована функція (для переліку виняток). */
    readonly name: string
  }
  const nameOfFn = (fn: ts.Node): string | undefined => {
    if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn))
      return fn.name === undefined ? undefined : (fn.name as ts.Identifier).text
    if (
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      ts.isVariableDeclaration(fn.parent) &&
      ts.isIdentifier(fn.parent.name)
    )
      return fn.parent.name.text
    if (ts.isPropertyAssignment(fn.parent) && ts.isIdentifier(fn.parent.name))
      return fn.parent.name.text
    return undefined
  }
  const contextOf = (node: ts.Node): Context => {
    let nearest: string | undefined
    for (let p: ts.Node | undefined = node; p; p = p.parent) {
      const step = stepOfProperty(p)
      if (step !== undefined)
        return {
          step,
          name:
            (nearest === undefined ? "" : `${nearest}.`) +
            `hook:${(p as ts.MethodDeclaration).name.getText()}`,
        }
      if (isFn(p) && p !== node) {
        // Значення властивості-гачка: контекст дає сама властивість вище.
        if (stepOfProperty(p.parent) !== undefined) continue
        nearest ??= nameOfFn(p)
        if (isWriteClosure(p))
          return { step: "5", name: `${nearest ?? ""}.write` }
        const fn = keyOf(p)
        if (fn !== undefined) return { fn, name: nearest ?? "" }
      }
    }
    return { name: nearest ?? "" }
  }
  const stepsMemo = new Map<ts.Symbol, ReadonlySet<string>>()
  const stepsOfFn = (
    fn: ts.Symbol,
    visiting: Set<ts.Symbol>
  ): ReadonlySet<string> => {
    const known = stepsMemo.get(fn)
    if (known !== undefined) return known
    if (visiting.has(fn)) return new Set()
    visiting.add(fn)
    const out = new Set<string>()
    // Функція без жодного посилання недосяжна з жодного кроку.
    if ((refsOf.get(fn) ?? []).length === 0) out.add(OUTSIDE)
    for (const r of refsOf.get(fn) ?? []) {
      for (const s of stepsOf(contextOf(r.node), visiting)) out.add(s)
    }
    visiting.delete(fn)
    // Результат у циклі неповний, тож його не кешуємо (лише верхній виклик).
    if (visiting.size === 0) stepsMemo.set(fn, out)
    return out
  }
  const stepsOf = (
    ctx: Context,
    visiting: Set<ts.Symbol> = new Set()
  ): ReadonlySet<string> =>
    ctx.step !== undefined
      ? new Set([ctx.step])
      : ctx.fn !== undefined
        ? stepsOfFn(ctx.fn, visiting)
        : // Верхній рівень модуля чи безіменна функція поза гачком: не крок.
          new Set([OUTSIDE])

  // ---------------------------------------------------------- знахідки
  const findings: Finding[] = []
  const allowedUses: Record<string, number> = {}
  const allowedUse = (kind: Kind) => {
    allowedUses[kind] = (allowedUses[kind] ?? 0) + 1
  }
  const lineOf = (n: ts.Node) =>
    n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1
  const place = (n: ts.Node, ctx: Context) =>
    `${label(n.getSourceFile().fileName)}::${ctx.name}`
  const ancestorFns = (node: ts.Node): ts.Symbol[] => {
    const out: ts.Symbol[] = []
    for (let p: ts.Node | undefined = node; p; p = p.parent)
      if (isFn(p) && p !== node) {
        const key = keyOf(p)
        if (key !== undefined) out.push(key)
      }
    return out
  }

  for (const r of refs) {
    const kind = protectedKind.get(declOf(r.symbol)!)
    if (kind === undefined) continue
    const ctx = contextOf(r.node)
    if (kind === "seam") {
      // Помічник шва: лише в самому шві чи в помічнику.
      const inside = ancestorFns(r.node)
      const ok = inside.some((s) => s === seamSymbol || helperSymbols.has(s))
      if (!ok)
        findings.push({ place: place(r.node, ctx), kind, line: lineOf(r.node) })
      else allowedUse(kind)
      continue
    }
    const steps = stepsOf(ctx)
    const allowed = ALLOWED_STEPS[kind]!
    // Порожня множина лише в циклі без входу: його вхід судить інший виклик.
    if (steps.size > 0 && [...steps].some((s) => !allowed.includes(s)))
      findings.push({ place: place(r.node, ctx), kind, line: lineOf(r.node) })
    else allowedUse(kind)
  }

  // Виклик значення типу `Write` — той самий запис відповіді, хоч би його
  // дістали не з `GatedRead.write`.
  const writeType = (() => {
    const decl = source(A.writeAlias.file)?.statements.find(
      (s): s is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(s) && s.name.text === A.writeAlias.name
    )
    return decl === undefined
      ? undefined
      : checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(decl.name)!)
  })()
  const isWriteValue = (e: ts.Expression) => {
    const type = checker.getTypeAtLocation(e)
    return type === writeType || type.aliasSymbol?.name === A.writeAlias.name
  }
  const isProtectedMember = (e: ts.Expression) => {
    const sym = ts.isPropertyAccessExpression(e)
      ? checker.getSymbolAtLocation(e.name)
      : undefined
    const decl = sym === undefined ? undefined : declOf(resolve(sym)!)
    return decl !== undefined && protectedKind.has(decl)
  }
  for (const file of files) {
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        n.arguments.some(isWriteValue) &&
        !(contextOf(n).step === "5" || stepsOf(contextOf(n)).size === 0)
      ) {
        // Значення `Write`, передане аргументом (`commit(w)`), — те саме
        // виконання запису, лише чужим викликом.
        const steps = stepsOf(contextOf(n))
        if ([...steps].some((s) => s !== "5"))
          findings.push({
            place: place(n, contextOf(n)),
            kind: "write",
            line: lineOf(n),
          })
      }
      if (
        ts.isCallExpression(n) &&
        isWriteValue(n.expression) &&
        !isProtectedMember(n.expression)
      ) {
        const ctx = contextOf(n)
        const steps = stepsOf(ctx)
        if (steps.size > 0 && [...steps].some((s) => s !== "5"))
          findings.push({
            place: place(n, ctx),
            kind: "write",
            line: lineOf(n),
          })
        else allowedUse("write")
      }
      ts.forEachChild(n, visit)
    }
    visit(source(file)!)
  }

  // Присвоєння полів стану вигляду — лише в єдиному `settleTarget`.
  const isAssignOp = (k: ts.SyntaxKind) =>
    k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment
  const fieldOf = (target: ts.Expression): ts.Symbol | undefined => {
    let symbol: ts.Symbol | undefined
    if (ts.isPropertyAccessExpression(target))
      symbol = checker.getSymbolAtLocation(target.name)
    else if (
      ts.isElementAccessExpression(target) &&
      ts.isStringLiteralLike(target.argumentExpression)
    )
      symbol = checker.getSymbolAtLocation(target.argumentExpression)
    else if (ts.isParenthesizedExpression(target))
      return fieldOf(target.expression)
    return symbol !== undefined && fieldDecls.has(declOf(symbol))
      ? symbol
      : undefined
  }
  const report = (n: ts.Node, kind: Kind) => {
    const ctx = contextOf(n)
    if (ancestorFns(n).includes(seamSymbol!)) {
      allowedUse(kind)
      return
    }
    findings.push({ place: place(n, ctx), kind, line: lineOf(n) })
  }
  for (const file of files) {
    const visit = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) &&
        isAssignOp(n.operatorToken.kind) &&
        fieldOf(n.left) !== undefined
      )
        report(n, "field")
      if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken ||
          n.operator === ts.SyntaxKind.MinusMinusToken) &&
        fieldOf(n.operand) !== undefined
      )
        report(n, "field")
      ts.forEachChild(n, visit)
    }
    visit(source(file)!)
  }

  // `settle(lease, …)` не існує: ні члена, ні функції з таким підписом.
  for (const file of files) {
    const visit = (n: ts.Node): void => {
      if (
        (ts.isMethodSignature(n) ||
          ts.isMethodDeclaration(n) ||
          ts.isFunctionDeclaration(n)) &&
        n.name !== undefined &&
        ts.isIdentifier(n.name) &&
        n.name.text === "settle" &&
        ts.isIdentifier(n.parameters[0]?.name ?? n) &&
        (n.parameters[0]?.name as ts.Identifier | undefined)?.text === "lease"
      )
        findings.push({
          place: `${label(file)}::settle`,
          kind: "settle-lease",
          line: lineOf(n),
        })
      ts.forEachChild(n, visit)
    }
    visit(source(file)!)
  }

  // ------------------------------------------------------ точки й прохід
  const functionNodes = (file: string, name: string) => {
    const out: ts.Node[] = []
    const visit = (n: ts.Node): void => {
      if (isFn(n) && nameOfFn(n) === name) out.push(n)
      ts.forEachChild(n, visit)
    }
    visit(source(file)!)
    return out
  }
  /** Символи, на які посилається функція (разом з вкладеними). */
  const callees = new Map<ts.Symbol, Set<ts.Symbol>>()
  for (const r of refs) {
    for (const fn of ancestorFns(r.node)) {
      const set = callees.get(fn) ?? new Set<ts.Symbol>()
      set.add(r.symbol)
      callees.set(fn, set)
    }
  }
  const reachesPass = (fn: ts.Symbol): boolean => {
    const seen = new Set<ts.Symbol>()
    const stack = [fn]
    while (stack.length > 0) {
      const at = stack.pop()!
      if (seen.has(at)) continue
      seen.add(at)
      for (const next of callees.get(at) ?? []) {
        if (passSymbols.has(next)) return true
        stack.push(next)
      }
    }
    return false
  }
  const pointProblems: string[] = []
  for (const [file, name] of A.points) {
    const nodes = functionNodes(file, name)
    if (nodes.length === 0) pointProblems.push(`${file}::${name} not found`)
    else if (
      !nodes.some((n) => {
        const key = keyOf(n)
        return key !== undefined && reachesPass(key)
      })
    )
      pointProblems.push(`${file}::${name} does not reach the pass`)
  }
  const seamBodies = functionNodes(A.subset.file, A.subset.seam).filter(
    ts.isFunctionDeclaration
  ).length

  return { findings, pointProblems, seamBodies, allowedUses, label }
}

/** `<місце> <вид>`, з ` ×N`, коли в місці N входжень одного виду. */
function render(findings: readonly Finding[]): string[] {
  const counts = new Map<string, number>()
  for (const f of findings) {
    const key = `${f.place} ${f.kind}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].map(([key, n]) => (n === 1 ? key : `${key} ×${n}`)).sort()
}

// ------------------------------------------------------------ реальний код

const at = (file: string) => join(STORE, file)
const REAL: Anchors = {
  hooks: { file: at("sync/settle-pass.ts"), iface: "SettleHooks" },
  session: {
    file: at("session.ts"),
    iface: "Session",
    members: ["acceptEpoch", "acceptEpochs"],
  },
  ops: {
    file: at("readers.ts"),
    iface: "StoreOps",
    write: ["put", "remove", "putSection"],
    sweep: "sweep",
  },
  writer: { file: at("types.ts"), iface: "Writer", member: "apply" },
  gated: { file: at("readers.ts"), iface: "GatedRead", member: "write" },
  writeAlias: { file: at("readers.ts"), name: "Write" },
  internal: { file: at("writer.ts"), names: ["patchRows", "removeKeys"] },
  subset: {
    file: at("subsets.ts"),
    iface: "Subset",
    fields: ["refreshedAt", "okReadEpoch", "failures", "failedAt"],
    seam: "settleTarget",
    helpers: ["settleRequirement", "liftRequirement"],
  },
  pass: {
    file: at("sync/settle-pass.ts"),
    names: ["settlePass", "settleAfter"],
  },
  points: [
    ["subsets.ts", "load"],
    ["subsets.ts", "loadMore"],
    ["writer.ts", "revalidateViews"],
    ["writer.ts", "rereadKey"],
    ["core.ts", "runTail"],
    ["receiver.ts", "land"],
  ].map(([f, n]) => [at(f!), n!] as const),
}

/**
 * Винятки з причиною: `<файл>::<функція> <вид>` (+ ` ×N`). Кожен названий
 * один раз; зайвий чи відсутній — червоний.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  "core.ts::applyVersion sweep":
    "відповідь `version` — рівень пакета, не відповідь читання виду (спека §5.5): її осідання не крок проходу",
  "core.ts::commit sweep":
    "запис власної мутації (`core.commit`) прибирає рядки без власника сам; це не осідання читання",
  "core.ts::hydrate sweep":
    "гідратація знімка `ssr.ts` — знімок, не відповідь читання (Р-SK2-1)",
  "core.ts::replaceRights sweep":
    "заміна знімка прав — не відповідь читання виду",
  "core.ts::staleClient sweep":
    "перехід об'єкта в `stale-client` — стан об'єкта, не відповідь читання",
  "ssr.ts::applySnapshot accept":
    "гідратація: знімок судить власну епоху одним `acceptEpoch`, проходу в нього немає (Р-SK2-1)",
  "writer.ts::apply accept":
    "внутрішня брама `Writer.apply`, яку лишає §3 (SK-5 дає єдину форму брами): приймач гейтить двічі",
}

function realProgram() {
  const files = readdirSync(DATA, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => !f.includes("/__tests__/"))
  const program = ts.createProgram(files, {
    ...BASE_OPTIONS,
    lib: ["lib.es2022.d.ts"],
  })
  return analyze(program, files, REAL, (f) => relative(STORE, f))
}

describe("settle guard on the store", () => {
  const result = realProgram()

  it("finds every settlement point and each reaches the pass", () => {
    expect(result.pointProblems).toEqual([])
  })

  it("has one body of the step-7 seam", () => {
    expect(result.seamBodies).toBe(1)
  })

  it("sees uses of every guarded kind at the allowed places, so the rules are not vacuous", () => {
    for (const kind of ["accept", "write", "sweep", "seam", "field"] as const)
      expect(result.allowedUses[kind] ?? 0, kind).toBeGreaterThan(0)
  })

  it("flags only the listed exceptions, each with a reason", () => {
    const found = render(result.findings)
    expect(found.filter((f) => !(f in EXCEPTIONS))).toEqual([])
    expect(Object.keys(EXCEPTIONS).filter((k) => !found.includes(k))).toEqual(
      []
    )
    for (const reason of Object.values(EXCEPTIONS))
      expect(reason.length).toBeGreaterThan(10)
  }, 60_000)
})

// ----------------------------------------------------------- самотести

const WORLD: Record<string, string> = {
  "/v/session.ts": `export interface Scope { scope: true }
export interface Session {
  acceptEpoch(epoch: string | null, start: number): "apply" | "discard"
  acceptEpochs(epochs: ReadonlySet<string | null>, start: number): "apply" | "discard"
}
`,
  "/v/readers.ts": `import type { Scope } from "./session.ts"
export type Write = (scope: Scope) => void
export interface GatedRead { readonly write: Write }
export interface StoreOps {
  put(scope: Scope, key: string): void
  remove(scope: Scope, key: string): void
  putSection(scope: Scope, key: string): void
  sweep(scope: Scope): void
}
`,
  "/v/types.ts": `export interface Writer { apply(rows: string[]): void }
`,
  "/v/writer.ts": `import type { Scope } from "./session.ts"
export function patchRows(_s: Scope) {}
export function removeKeys(_s: Scope) {}
`,
  "/v/settle-pass.ts": `import type { Scope } from "./session.ts"
export interface SettleHooks {
  gate?(entry: unknown, scope: Scope): "apply" | "discard"
  apply?(entry: unknown, scope: Scope): void
  settleTarget?(flight: unknown, outcome: string): void
  discarded?(entry: unknown, scope: Scope): void
  sweep?(scope: Scope): void
  settled?(entry: unknown): void
}
export function settlePass(_s: unknown, _e: unknown[], _h: SettleHooks) {}
export function settleAfter(_s: unknown, _e: unknown[], _h: SettleHooks) {}
`,
  "/v/subsets.ts": `import type { SettleHooks } from "./settle-pass.ts"
import { settlePass } from "./settle-pass.ts"
export interface Subset {
  refreshedAt: number | undefined
  okReadEpoch: number | undefined
  failures: number
  failedAt: number | undefined
  status: string
}
export function liftRequirement(_s: Subset) {}
export function settleRequirement(s: Subset) { liftRequirement(s); return false }
export function settleTarget(s: Subset): void {
  s.refreshedAt = 1
  s.failures++
  settleRequirement(s)
}
export const hooks = (): SettleHooks => ({})
export function load(s: Subset) {
  settlePass(0, [], { settleTarget: () => settleTarget(s) })
}
`,
}
const SELF: Anchors = {
  hooks: { file: "/v/settle-pass.ts", iface: "SettleHooks" },
  session: {
    file: "/v/session.ts",
    iface: "Session",
    members: ["acceptEpoch", "acceptEpochs"],
  },
  ops: {
    file: "/v/readers.ts",
    iface: "StoreOps",
    write: ["put", "remove", "putSection"],
    sweep: "sweep",
  },
  writer: { file: "/v/types.ts", iface: "Writer", member: "apply" },
  gated: { file: "/v/readers.ts", iface: "GatedRead", member: "write" },
  writeAlias: { file: "/v/readers.ts", name: "Write" },
  internal: { file: "/v/writer.ts", names: ["patchRows", "removeKeys"] },
  subset: {
    file: "/v/subsets.ts",
    iface: "Subset",
    fields: ["refreshedAt", "okReadEpoch", "failures", "failedAt"],
    seam: "settleTarget",
    helpers: ["settleRequirement", "liftRequirement"],
  },
  pass: { file: "/v/settle-pass.ts", names: ["settlePass", "settleAfter"] },
  points: [["/v/subsets.ts", "load"]],
}

function inlineProgram(sources: Record<string, string>) {
  const options = { ...BASE_OPTIONS, noLib: true }
  const host = ts.createCompilerHost(options, true)
  const files = new Map(
    Object.entries(sources).map(([name, text]) => [
      name,
      ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true),
    ])
  )
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (file, ...rest) =>
    files.get(file) ?? original(file, ...rest)
  host.fileExists = (file) => files.has(file)
  host.readFile = (file) => sources[file]
  host.directoryExists = (dir) => dir === "/v" || dir === "/"
  host.realpath = (path) => path
  return ts.createProgram([...files.keys()], options, host)
}

function selfTest(extra: Record<string, string>) {
  const sources = { ...WORLD, ...extra }
  const files = Object.keys(sources)
  return analyze(inlineProgram(sources), files, SELF, (f) => f)
}
const flagged = (extra: Record<string, string>) =>
  render(selfTest(extra).findings)

describe("settle guard self-test: the world is clean", () => {
  it("passes the fixture as it is", () => {
    const r = selfTest({})
    expect(render(r.findings)).toEqual([])
    expect(r.pointProblems).toEqual([])
    expect(r.seamBodies).toBe(1)
  })

  it("passes the right step for each action", () => {
    expect(
      flagged({
        "/v/ok.ts": `import type { Session, Scope } from "./session.ts"
import type { StoreOps } from "./readers.ts"
import { settlePass } from "./settle-pass.ts"
declare const session: Session
declare const ops: StoreOps
export function point() {
  settlePass(0, [], {
    gate: () => session.acceptEpochs(new Set(), 0),
    apply: (_e: unknown, scope: Scope) => ops.put(scope, "k"),
    sweep: (scope: Scope) => ops.sweep(scope),
  })
}
`,
      })
    ).toEqual([])
  })
})

describe("settle guard self-test: each form of the bypass", () => {
  const pre = `import type { Session, Scope } from "./session.ts"
import type { StoreOps, GatedRead } from "./readers.ts"
import type { Writer } from "./types.ts"
import { patchRows } from "./writer.ts"
import { settlePass } from "./settle-pass.ts"
declare const session: Session
declare const ops: StoreOps
declare const w: Writer
declare const gated: GatedRead
`

  it("a batch gate outside step 4, also through an alias", () => {
    expect(
      flagged({
        "/v/a.ts": `${pre}const g = session.acceptEpochs
export function bad() { g(new Set(), 0) }
`,
      })
    ).toEqual(["/v/a.ts:: accept"])
  })

  it("a response write outside step 5, through an alias", () => {
    expect(
      flagged({
        "/v/a.ts": `${pre}export function bad(scope: Scope) {
  const p = ops.put
  p(scope, "k")
}
`,
      })
    ).toEqual(["/v/a.ts::bad write"])
  })

  it("a response write through destructuring", () => {
    expect(
      flagged({
        "/v/a.ts": `${pre}export function bad(scope: Scope) {
  const { remove } = ops
  remove(scope, "k")
}
`,
      })
    ).toEqual(["/v/a.ts::bad write"])
  })

  it("a write in a helper of another module reached from a step other than 5", () => {
    expect(
      flagged({
        "/v/helper.ts": `import type { Scope } from "./session.ts"
import type { StoreOps } from "./readers.ts"
declare const ops: StoreOps
export function helper(scope: Scope) { ops.putSection(scope, "k") }
`,
        "/v/a.ts": `${pre}import { helper } from "./helper.ts"
export function point() {
  settlePass(0, [], { settleTarget: (_f: unknown, _o: string) => helper({ scope: true }) })
}
`,
      })
    ).toEqual(["/v/helper.ts::helper write"])
  })

  it("passes the same helper when only step 5 reaches it", () => {
    expect(
      flagged({
        "/v/helper.ts": `import type { Scope } from "./session.ts"
import type { StoreOps } from "./readers.ts"
declare const ops: StoreOps
export function helper(scope: Scope) { ops.putSection(scope, "k") }
`,
        "/v/a.ts": `${pre}import { helper } from "./helper.ts"
export function point() {
  settlePass(0, [], { apply: (_e: unknown, scope: Scope) => helper(scope) })
}
`,
      })
    ).toEqual([])
  })

  it("a step-5 write inside a step-7 hook", () => {
    expect(
      flagged({
        "/v/a.ts": `${pre}export function point() {
  settlePass(0, [], {
    settleTarget: () => { patchRows({ scope: true }) },
    apply: (_e: unknown, scope: Scope) => w.apply(["k"]) ,
  })
}
`,
      })
    ).toEqual(["/v/a.ts::hook:settleTarget write"])
  })

  it("a bypass of the pass with an own commit", () => {
    expect(
      flagged({
        "/v/a.ts": `${pre}declare function commit(fn: (scope: Scope) => void): void
export function runTail() {
  commit((scope) => { ops.put(scope, "k"); ops.sweep(scope) })
}
`,
      })
    ).toEqual(["/v/a.ts::runTail sweep", "/v/a.ts::runTail write"])
  })

  it("a call of the write closure of a read outside step 5", () => {
    expect(
      flagged({
        "/v/a.ts": `${pre}export function bad(scope: Scope) { gated.write(scope) }
`,
      })
    ).toEqual(["/v/a.ts::bad write"])
  })

  it("a write closure of a reader is a step-5 context", () => {
    expect(
      flagged({
        "/v/reader.ts": `import type { Scope } from "./session.ts"
import type { StoreOps, Write } from "./readers.ts"
declare const ops: StoreOps
export async function read(): Promise<Write> {
  return (scope: Scope) => { ops.put(scope, "k") }
}
`,
      })
    ).toEqual([])
  })

  it("a helper reached from step 5 and also from a plain commit is red", () => {
    expect(
      flagged({
        "/v/helper.ts": `import type { Scope } from "./session.ts"
import type { StoreOps } from "./readers.ts"
declare const ops: StoreOps
export function helper(scope: Scope) { ops.put(scope, "k") }
`,
        "/v/a.ts": `${pre}import { helper } from "./helper.ts"
declare function commit(fn: (scope: Scope) => void): void
export function point() {
  settlePass(0, [], { apply: (_e: unknown, scope: Scope) => helper(scope) })
}
export function runTail() { commit((scope) => helper(scope)) }
`,
      })
    ).toEqual(["/v/helper.ts::helper write"])
  })

  it("a write helper nobody calls is red", () => {
    expect(
      flagged({
        "/v/helper.ts": `import type { Scope } from "./session.ts"
import type { StoreOps } from "./readers.ts"
declare const ops: StoreOps
export function orphan(scope: Scope) { ops.put(scope, "k") }
`,
      })
    ).toEqual(["/v/helper.ts::orphan write"])
  })

  it("a direct call of a Write value outside step 5 is red", () => {
    expect(
      flagged({
        "/v/a.ts": `${pre}import type { Write } from "./readers.ts"
declare const wr: Write
declare function commit(fn: (scope: Scope) => void): void
export function runTail() { commit((scope) => wr(scope)) }
`,
      })
    ).toEqual(["/v/a.ts::runTail write"])
  })

  it("a Write value passed to a call outside step 5 is red", () => {
    expect(
      flagged({
        "/v/a.ts": `${pre}import type { Write } from "./readers.ts"
declare const wr: Write
declare function commit(fn: (scope: Scope) => void): void
export function runTail() { commit(wr) }
`,
      })
    ).toEqual(["/v/a.ts::runTail write"])
  })

  it("a Write value called in the apply hook passes", () => {
    expect(
      flagged({
        "/v/a.ts": `${pre}import type { Write } from "./readers.ts"
declare const wr: Write
export function point() {
  settlePass(0, [], { apply: (_e: unknown, scope: Scope) => wr(scope) })
}
`,
      })
    ).toEqual([])
  })

  it("the gate in the discarded hook is not step 4", () => {
    expect(
      flagged({
        "/v/a.ts": `${pre}export function point() {
  settlePass(0, [], { discarded: () => session.acceptEpochs(new Set(), 0) })
}
`,
      })
    ).toEqual(["/v/a.ts::hook:discarded accept"])
  })

  it("a sweep outside step 8", () => {
    expect(
      flagged({
        "/v/a.ts": `${pre}export function point() {
  settlePass(0, [], { apply: (_e: unknown, scope: Scope) => ops.sweep(scope) })
}
`,
      })
    ).toEqual(["/v/a.ts::hook:apply sweep"])
  })

  it("a sweep passed as the value of its hook is step 8", () => {
    expect(
      flagged({
        "/v/a.ts": `${pre}export function point() { settlePass(0, [], { sweep: ops.sweep }) }
`,
      })
    ).toEqual([])
  })
})

describe("settle guard self-test: the seam is single", () => {
  const pre = `import type { Subset } from "./subsets.ts"
import { settleRequirement, liftRequirement } from "./subsets.ts"
`
  it("a second body of the seam with the same name is red", () => {
    const r = selfTest({
      "/v/second.ts": `${pre}export function settleTarget(s: Subset): void {
  s.failedAt = 2
  settleRequirement(s)
}
`,
    })
    expect(render(r.findings)).toEqual([
      "/v/second.ts::settleTarget field",
      "/v/second.ts::settleTarget seam",
    ])
  })

  it("a hook that settles the target on its own is red, in every assignment form", () => {
    expect(
      flagged({
        "/v/a.ts": `${pre}import { settlePass } from "./settle-pass.ts"
export function point(s: Subset) {
  settlePass(0, [], {
    settleTarget: () => {
      s.okReadEpoch = 3
      s["failedAt"] = 4
      s.failures += 1
      s.refreshedAt = undefined
      liftRequirement(s)
    },
  })
}
`,
      })
    ).toEqual([
      "/v/a.ts::hook:settleTarget field ×4",
      "/v/a.ts::hook:settleTarget seam",
    ])
  })

  it("a field written outside the seam through a helper in another module", () => {
    expect(
      flagged({
        "/v/h.ts": `import type { Subset } from "./subsets.ts"
export const reset = (s: Subset) => { s.failures = 0 }
`,
      })
    ).toEqual(["/v/h.ts::reset field"])
  })

  it("settle(lease, …) is red wherever it is declared", () => {
    expect(
      flagged({
        "/v/source.ts": `export interface Source { settle(lease: unknown, x: number): void }
`,
      })
    ).toEqual(["/v/source.ts::settle settle-lease"])
  })

  it("a point that does not reach the pass is reported, and so is a missing one", () => {
    const r = analyze(
      inlineProgram({
        ...WORLD,
        "/v/p.ts": `export function other() {}\nexport function lonely() { other() }\n`,
      }),
      Object.keys(WORLD).concat("/v/p.ts"),
      {
        ...SELF,
        points: [
          ["/v/p.ts", "lonely"],
          ["/v/p.ts", "absent"],
        ],
      },
      (f) => f
    )
    expect(r.pointProblems).toEqual([
      "/v/p.ts::lonely does not reach the pass",
      "/v/p.ts::absent not found",
    ])
  })
})
