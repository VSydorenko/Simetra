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
 * (4) Перехід запису цілі «політ осів» (`settleFlight`: строк, доказ,
 *     зняття вимоги, правило збоїв — план SK-3, Р-SK3-7) і присвоєння ознак
 *     реєстру, які шов веде (`loaded`, `status`, `error`, `needsRefresh`,
 *     `hasNewRows`) — лише в єдиному `settleTarget` (другий шов, друга копія
 *     правила збоїв чи відновлення `status` — червоні). Законні записи поза швом (гідратація,
 *     старт, межа відкинутих, `Writer.markViews`, замикання запису читача) —
 *     у переліку винятків, точних до функції й поля. Не тримається: що саме
 *     пише такий виняток — перелік судить місце, не значення.
 * (5) `settle(lease, …)` не існує.
 * (6) Кожна точка Р-SK2-1 знайдена й досягає проходу.
 * (7) Запис цілі (план SK-3, Р-SK3-7): значення `TargetState` будує лише
 *     `sync/target-state.ts`. Поза ним червоні об'єктний літерал із
 *     контекстним типом запису, spread значення запису (і без контексту),
 *     виклик `createTargetState` поза ініціалізатором поля нового власника,
 *     аргумент переходу, що не є значенням запису. Поле запису власника
 *     присвоюється лише прямим результатом виклику переходу — функції файлу
 *     запису з першим параметром і результатом-записом. Поля запису —
 *     `readonly`. Не тримається: `Object.assign` чи приведення типу — їх
 *     відкидає `readonly` типу, а не страж.
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

type Kind =
  "accept" | "write" | "sweep" | "seam" | "field" | "record" | "settle-lease"

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
    /**
     * Помічники шва: їхні виклики — лише в шві чи в них самих. Ім'я — функція
     * файлу `file`; пара `[файл, ім'я]` — функція іншого модуля (перехід
     * запису цілі).
     */
    helpers: readonly (string | readonly [string, string])[]
  }
  readonly pass: { file: string; names: readonly string[] }
  /** Запис цілі: файл, що його будує, тип, конструктор і поле власника. */
  readonly record: {
    file: string
    type: string
    create: string
    owner: { file: string; iface: string; field: string }
  }
  /** Точки Р-SK2-1: `[файл, функція]`. */
  readonly points: readonly (readonly [string, string])[]
}

interface Finding {
  readonly place: string
  readonly kind: Kind
  /** Для поля — його ім'я: виняток точний до функції й поля. */
  readonly what?: string
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
  // Якір, що не розв'язався (перейменування, переїзд), не вимикає правило
  // мовчки: він потрапляє в `unresolved`, який реальний тест вимагає порожнім.
  const unresolved: string[] = []
  const anchor = (what: string, symbol: ts.Symbol | undefined) => {
    if (symbol === undefined) unresolved.push(what)
    return symbol
  }
  const named = (
    ...entries: readonly (readonly [string, ts.Symbol | undefined])[]
  ) =>
    entries.flatMap(([what, s]) => {
      const found = anchor(what, s)
      return found === undefined ? [] : [found]
    })

  // ---------------------------------------------------- захищені символи
  // Ключ — оголошення: член `Pick<…>` (контекст читача) дає інший символ з тим самим оголошенням.
  const protectedKind = new Map<ts.Node, Kind>()
  const declOf = (s: ts.Symbol) => s.declarations?.[0]
  for (const m of A.session.members)
    for (const s of named([
      `${A.session.iface}.${m}`,
      memberOf(A.session.file, A.session.iface, m),
    ]))
      protectedKind.set(declOf(s)!, "accept")
  for (const m of A.ops.write)
    for (const s of named([
      `${A.ops.iface}.${m}`,
      memberOf(A.ops.file, A.ops.iface, m),
    ]))
      protectedKind.set(declOf(s)!, "write")
  for (const s of named(
    [
      `${A.writer.iface}.${A.writer.member}`,
      memberOf(A.writer.file, A.writer.iface, A.writer.member),
    ],
    [
      `${A.gated.iface}.${A.gated.member}`,
      memberOf(A.gated.file, A.gated.iface, A.gated.member),
    ],
    ...A.internal.names.map(
      (n) => [n, functionSymbol(A.internal.file, n)] as const
    )
  ))
    protectedKind.set(declOf(s)!, "write")
  for (const s of named([
    `${A.ops.iface}.${A.ops.sweep}`,
    memberOf(A.ops.file, A.ops.iface, A.ops.sweep),
  ]))
    protectedKind.set(declOf(s)!, "sweep")
  const seamSymbol = anchor(
    A.subset.seam,
    functionSymbol(A.subset.file, A.subset.seam)
  )
  const helperSymbols = new Set(
    named(
      ...A.subset.helpers.map((h) =>
        typeof h === "string"
          ? ([h, functionSymbol(A.subset.file, h)] as const)
          : ([h[1], functionSymbol(h[0], h[1])] as const)
      )
    )
  )
  for (const s of helperSymbols) protectedKind.set(declOf(s)!, "seam")
  const fieldDecls = new Set(
    A.subset.fields.flatMap((f) =>
      named([
        `${A.subset.iface}.${f}`,
        memberOf(A.subset.file, A.subset.iface, f),
      ]).map(declOf)
    )
  )
  const passSymbols = new Set(
    named(
      ...A.pass.names.map((n) => [n, functionSymbol(A.pass.file, n)] as const)
    )
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
  const report = (n: ts.Node, kind: Kind, what: string) => {
    const ctx = contextOf(n)
    if (ancestorFns(n).includes(seamSymbol!)) {
      allowedUse(kind)
      return
    }
    findings.push({ place: place(n, ctx), kind, what, line: lineOf(n) })
  }
  const nameOfTarget = (target: ts.Expression): string =>
    ts.isParenthesizedExpression(target)
      ? nameOfTarget(target.expression)
      : ts.isPropertyAccessExpression(target)
        ? target.name.text
        : (target as ts.ElementAccessExpression).argumentExpression.getText()
  for (const file of files) {
    const visit = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) &&
        isAssignOp(n.operatorToken.kind) &&
        fieldOf(n.left) !== undefined
      )
        report(n, "field", nameOfTarget(n.left))
      if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken ||
          n.operator === ts.SyntaxKind.MinusMinusToken) &&
        fieldOf(n.operand) !== undefined
      )
        report(n, "field", nameOfTarget(n.operand))
      ts.forEachChild(n, visit)
    }
    visit(source(file)!)
  }

  // Запис цілі будує лише файл запису (Р-SK3-7): інакше поле свіжості можна
  // змінити копією запису повз перехід, і правило (4) цього не побачить.
  const recordDecl = source(A.record.file)?.statements.find(
    (s): s is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(s) && s.name.text === A.record.type
  )
  const recordSymbol = anchor(
    A.record.type,
    recordDecl === undefined
      ? undefined
      : checker.getSymbolAtLocation(recordDecl.name)
  )
  const createSymbol = anchor(
    A.record.create,
    functionSymbol(A.record.file, A.record.create)
  )
  const ownerField = anchor(
    `${A.record.owner.iface}.${A.record.owner.field}`,
    memberOf(A.record.owner.file, A.record.owner.iface, A.record.owner.field)
  )
  const ownerFieldDecl =
    ownerField === undefined ? undefined : declOf(ownerField)
  const ownerIface = interfaceSymbol(A.record.owner.file, A.record.owner.iface)
  const mutableRecordFields = (recordDecl?.members ?? [])
    .filter(
      (m) =>
        !(
          ts.isPropertySignature(m) &&
          m.modifiers?.some((k) => k.kind === ts.SyntaxKind.ReadonlyKeyword)
        )
    )
    .map((m) => m.name?.getText() ?? "?")
  const isRecord = (t: ts.Type | undefined): boolean => {
    if (t === undefined || recordSymbol === undefined) return false
    if (t.isUnion() || t.isIntersection()) return t.types.some(isRecord)
    return resolve(t.getSymbol() ?? t.aliasSymbol) === recordSymbol
  }
  const calleeOf = (call: ts.CallExpression) =>
    resolve(checker.getSymbolAtLocation(call.expression))
  // Перехід — функція файлу запису `(запис, вхід) → запис`; конструктор
  // `createTargetState` переходом не є (перший параметр — доказ).
  const isTransition = (call: ts.CallExpression): boolean => {
    const decl = calleeOf(call)?.declarations?.[0]
    if (
      decl === undefined ||
      !ts.isFunctionDeclaration(decl) ||
      decl.getSourceFile().fileName !== A.record.file
    )
      return false
    const sig = checker.getSignatureFromDeclaration(decl)
    const first = decl.parameters[0]
    return (
      sig !== undefined &&
      first !== undefined &&
      isRecord(checker.getReturnTypeOfSignature(sig)) &&
      isRecord(checker.getTypeAtLocation(first))
    )
  }
  const unwrap = (e: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e
  const isOwnerField = (target: ts.Expression): boolean => {
    const e = unwrap(target)
    const symbol = ts.isPropertyAccessExpression(e)
      ? checker.getSymbolAtLocation(e.name)
      : ts.isElementAccessExpression(e) &&
          ts.isStringLiteralLike(e.argumentExpression)
        ? checker.getSymbolAtLocation(e.argumentExpression)
        : undefined
    return (
      ownerFieldDecl !== undefined &&
      symbol !== undefined &&
      declOf(resolve(symbol)!) === ownerFieldDecl
    )
  }
  // Будь-яка форма присвоєння (`&&=`, `??=` теж): дозволене лише `=`.
  const isOwnerAssign = (n: ts.Node): n is ts.BinaryExpression =>
    ts.isBinaryExpression(n) &&
    isAssignOp(n.operatorToken.kind) &&
    isOwnerField(n.left)
  // Присвоєння полю власника судить правило «assign»: другої знахідки немає.
  const assignedToOwner = (n: ts.Expression): boolean => {
    let p = n.parent
    while (ts.isParenthesizedExpression(p)) p = p.parent
    return isOwnerAssign(p) && unwrap(p.right) === n
  }
  // Ініціалізатор поля запису в літералі нового власника: запис народжується
  // разом із власником, а не замінює живий.
  const isOwnerInitializer = (call: ts.Node): boolean => {
    const p = call.parent
    if (
      !ts.isPropertyAssignment(p) ||
      p.initializer !== call ||
      !ts.isIdentifier(p.name) ||
      !ts.isObjectLiteralExpression(p.parent)
    )
      return false
    // Літерал — увесь новий власник: його тип — інтерфейс власника чи його
    // нащадок (`Subset extends ReaderTarget`), а не `Partial` чи інший
    // відображений тип, що лише несе поле запису.
    const isOwnerType = (t: ts.Type): boolean =>
      resolve(t.getSymbol()) === ownerIface ||
      (t.isClassOrInterface() && checker.getBaseTypes(t).some(isOwnerType))
    const type = checker.getContextualType(p.parent)
    const decl = type?.getProperty(p.name.text)?.declarations?.[0]
    return (
      type !== undefined &&
      isOwnerType(type) &&
      decl !== undefined &&
      decl === ownerFieldDecl
    )
  }
  const recordFinding = (n: ts.Node, what: string) =>
    findings.push({
      place: place(n, contextOf(n)),
      kind: "record",
      what,
      line: lineOf(n),
    })
  for (const file of files) {
    if (file === A.record.file) continue
    const visit = (n: ts.Node): void => {
      if (
        ts.isObjectLiteralExpression(n) &&
        isRecord(checker.getContextualType(n))
      )
        recordFinding(n, "literal")
      if (
        (ts.isSpreadAssignment(n) || ts.isSpreadElement(n)) &&
        isRecord(checker.getTypeAtLocation(n.expression))
      )
        recordFinding(n, "spread")
      if (ts.isCallExpression(n)) {
        const callee = calleeOf(n)
        if (
          callee !== undefined &&
          callee === createSymbol &&
          !isOwnerInitializer(n) &&
          !assignedToOwner(n)
        )
          recordFinding(n, "create")
        if (isTransition(n)) {
          const arg = n.arguments[0]
          const t =
            arg === undefined ? undefined : checker.getTypeAtLocation(arg)
          if (
            t === undefined ||
            t.isUnion() ||
            resolve(t.getSymbol()) !== recordSymbol
          )
            recordFinding(n, "argument")
        }
        if (callee === createSymbol && isOwnerInitializer(n))
          allowedUse("record")
      }
      if (isOwnerAssign(n)) {
        const right = unwrap(n.right)
        if (
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isCallExpression(right) &&
          isTransition(right)
        )
          allowedUse("record")
        else recordFinding(n, "assign")
      }
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

  if (interfaceSymbol(A.hooks.file, A.hooks.iface) === undefined)
    unresolved.push(A.hooks.iface)
  if (writeType === undefined) unresolved.push(A.writeAlias.name)
  return {
    findings,
    pointProblems,
    seamBodies,
    allowedUses,
    unresolved,
    mutableRecordFields,
    label,
  }
}

/** `<місце> <вид>`, з ` ×N`, коли в місці N входжень одного виду. */
function render(findings: readonly Finding[]): string[] {
  const counts = new Map<string, number>()
  for (const f of findings) {
    const key = `${f.place} ${f.kind}${f.what === undefined ? "" : `:${f.what.replace(/["']/g, "")}`}`
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
    // Строк, доказ і зняття вимоги — у записі цілі (план SK-3, задача 3):
    // їх пише лише перехід `settleFlight`, а його кличе лише шов.
    fields: ["loaded", "status", "error", "needsRefresh", "hasNewRows"],
    seam: "settleTarget",
    helpers: [[at("sync/target-state.ts"), "settleFlight"]],
  },
  pass: {
    file: at("sync/settle-pass.ts"),
    names: ["settlePass", "settleAfter"],
  },
  record: {
    file: at("sync/target-state.ts"),
    type: "TargetState",
    create: "createTargetState",
    owner: {
      file: at("readers.ts"),
      iface: "ReaderTarget",
      field: "targetState",
    },
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
  "core.ts::settleBypassingPass write":
    "самотест: мутація «осідання повз прохід» (`settle-bypasses-pass`, Р-SK2-11) пише відповідь хвоста власним `commit`; що страж бачить саме таку форму обходу, доводить його самотест `inlineProgram` («a bypass of the pass with an own commit»), а не ця мутація",
  // ---- Поля стану вигляду поза швом: записи, що не є осіданням відповіді.
  "subsets.ts::adopt field:loaded":
    "гідратація знімка (`restore`): вигляд стає завантаженим зі знімка, відповіді читання немає",
  "subsets.ts::adopt field:status":
    "гідратація знімка: `ready` зі знімка, без відповіді читання",
  "subsets.ts::start field:loaded":
    "старт вигляду над рядком, уже наявним у сховищі (картка): готовий без читання",
  "subsets.ts::start field:status":
    "старт вигляду над наявним рядком: `ready` без читання",
  "subsets.ts::load field:status":
    "початок завантаження (`loading`/`refreshing`) у `commit` старту, до відповіді",
  "subsets.ts::attempt field:status":
    "межа відкинутих після проходу (Р-SK2-5(в)): `command.unavailable` у власному `commit` після області запису",
  "subsets.ts::attempt field:error":
    "межа відкинутих після проходу (Р-SK2-5(в)): код `EPOCH_UNAVAILABLE`",
  "subsets.ts::hook:discarded field:status":
    "відкинута відповідь за межею (Р-SK2-5(в)): `error` у гачку `discarded` кроку 4",
  "subsets.ts::hook:discarded field:error":
    "відкинута відповідь за межею (Р-SK2-5(в)): `EPOCH_UNAVAILABLE` у гачку `discarded`",
  "writer.ts::hook:discarded field:status":
    "відкинута відповідь системного перечитування за межею (Р-SK2-5(в))",
  "writer.ts::hook:discarded field:error":
    "відкинута відповідь системного перечитування за межею: `EPOCH_UNAVAILABLE`",
  "writer.ts::revalidateViews field:status":
    "межа відкинутих після проходу пачки (Р-SK1-7): `error` у власному `commit` після області запису",
  "writer.ts::revalidateViews field:error":
    "межа відкинутих після проходу пачки: `EPOCH_UNAVAILABLE`",
  "writer.ts::markViews field:needsRefresh":
    "`Writer.markViews` — позначка механізму свіжості від приймача й хвилі, не відповідь читання",
  "writer.ts::markViews field:hasNewRows":
    "`Writer.markViews` — банер нових рядків, позначка приймача",
  "writer.ts::.write field:needsRefresh ×2":
    "замикання запису читача (крок 5): банер зміни складу, клітинка `setsBanners` виду польоту",
  "writer.ts::.write field:hasNewRows ×3":
    "замикання запису читача (крок 5): банер нових рядків, клітинка `setsBanners` виду польоту",
  // ---- Запис цілі поза переходом (Р-SK3-7).
  "subsets.ts::adopt record:assign":
    "гідратація знімка створює запис вигляду ТЧ з нуля (`createTargetState` з доказом знімка: епоха гідратації як `sectionRead` і `readStart`): переходу з попереднього стану немає, бо гідратація відмовляє ядру, що вже тримає вигляди (`hydrate`)",
  // ---- Решта винятків.
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

  it("resolves every anchor of the rules", () => {
    expect(result.unresolved).toEqual([])
  })

  it("has one body of the step-7 seam", () => {
    expect(result.seamBodies).toBe(1)
  })

  it("sees uses of every guarded kind at the allowed places, so the rules are not vacuous", () => {
    for (const kind of [
      "accept",
      "write",
      "sweep",
      "seam",
      "field",
      "record",
    ] as const)
      expect(result.allowedUses[kind] ?? 0, kind).toBeGreaterThan(0)
  })

  it("declares every field of the target record readonly", () => {
    expect(result.mutableRecordFields).toEqual([])
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
  "/v/target-state.ts": `export interface TargetState {
  readonly failures: number
  readonly flight: number | undefined
}
export function createTargetState(): TargetState {
  return { failures: 0, flight: undefined }
}
export function slotChanged(s: TargetState, flight: number): TargetState {
  return { ...s, flight }
}
`,
  "/v/subsets.ts": `import type { SettleHooks } from "./settle-pass.ts"
import { settlePass } from "./settle-pass.ts"
import { createTargetState, slotChanged, type TargetState } from "./target-state.ts"
export interface Subset {
  targetState: TargetState
  refreshedAt: number | undefined
  okReadEpoch: number | undefined
  failures: number
  failedAt: number | undefined
  loaded: boolean
  status: string
  error: unknown
  needsRefresh: boolean
  hasNewRows: boolean
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
  s.targetState = slotChanged(s.targetState, 1)
}
export function acquire(): Subset {
  return {
    targetState: createTargetState(),
    refreshedAt: undefined,
    okReadEpoch: undefined,
    failures: 0,
    failedAt: undefined,
    loaded: false,
    status: "loading",
    error: undefined,
    needsRefresh: false,
    hasNewRows: false,
  }
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
    fields: [
      "refreshedAt",
      "okReadEpoch",
      "failures",
      "failedAt",
      "loaded",
      "status",
      "error",
      "needsRefresh",
      "hasNewRows",
    ],
    seam: "settleTarget",
    helpers: ["settleRequirement", "liftRequirement"],
  },
  pass: { file: "/v/settle-pass.ts", names: ["settlePass", "settleAfter"] },
  record: {
    file: "/v/target-state.ts",
    type: "TargetState",
    create: "createTargetState",
    owner: { file: "/v/subsets.ts", iface: "Subset", field: "targetState" },
  },
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

describe("settle guard self-test: a missing anchor", () => {
  it("is reported instead of silently switching its rule off", () => {
    const files = Object.keys(WORLD)
    const renamed = {
      ...WORLD,
      "/v/subsets.ts": WORLD["/v/subsets.ts"]!.replaceAll(
        "failedAt",
        "failedSince"
      ),
    }
    const r = analyze(inlineProgram(renamed), files, SELF, (f) => f)
    expect(r.unresolved).toEqual(["Subset.failedAt"])
  })
})

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
      "/v/second.ts::settleTarget field:failedAt",
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
      "/v/a.ts::hook:settleTarget field:failedAt",
      "/v/a.ts::hook:settleTarget field:failures",
      "/v/a.ts::hook:settleTarget field:okReadEpoch",
      "/v/a.ts::hook:settleTarget field:refreshedAt",
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
    ).toEqual(["/v/h.ts::reset field:failures"])
  })

  it("a seam helper from another module (the record transition) is called only in the seam", () => {
    // Перехід — у файлі запису, а значення йому дає поле власника: літерал
    // запису поза файлом запису червонить уже правило (7).
    const transition = {
      "/v/target-state.ts": `${WORLD["/v/target-state.ts"]}export function settleFlight(s: TargetState): TargetState { return s }
`,
    }
    const anchors: Anchors = {
      ...SELF,
      subset: {
        ...SELF.subset,
        helpers: [
          ...SELF.subset.helpers,
          ["/v/target-state.ts", "settleFlight"],
        ],
      },
    }
    const run = (extra: Record<string, string>) => {
      const sources = { ...WORLD, ...transition, ...extra }
      return render(
        analyze(inlineProgram(sources), Object.keys(sources), anchors, (f) => f)
          .findings
      )
    }
    expect(run({})).toEqual([])
    expect(
      run({
        "/v/subsets.ts": WORLD["/v/subsets.ts"]!.replace(
          "  settleRequirement(s)\n}",
          "  settleRequirement(s)\n  settleFlight(s.targetState)\n}"
        ).replace(
          'import { settlePass } from "./settle-pass.ts"',
          'import { settlePass } from "./settle-pass.ts"\nimport { settleFlight } from "./target-state.ts"'
        ),
      })
    ).toEqual([])
    expect(
      run({
        "/v/a.ts": `import { settleFlight } from "./target-state.ts"
import type { Subset } from "./subsets.ts"
export const sneak = (s: Subset) => settleFlight(s.targetState)
`,
      })
    ).toEqual(["/v/a.ts::sneak seam"])
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

describe("settle guard self-test: the record is built only by its transitions", () => {
  const pre = `import type { Subset } from "./subsets.ts"
import { createTargetState, slotChanged, type TargetState } from "./target-state.ts"
`
  const bad = (body: string) =>
    flagged({
      "/v/a.ts": `${pre}export function bad(s: Subset) {\n${body}\n}\n`,
    })

  it("a spread of the record assigned to the owner (mutation Р-SK3-14)", () => {
    expect(bad(`  s.targetState = { ...s.targetState, failures: 0 }`)).toEqual([
      "/v/a.ts::bad record:assign",
      "/v/a.ts::bad record:literal",
      "/v/a.ts::bad record:spread",
    ])
  })

  it("a spread of the record without a contextual type, passed to a transition", () => {
    expect(
      bad(
        `  const copy = { ...s.targetState }\n  s.targetState = slotChanged(copy, 1)`
      )
    ).toEqual(["/v/a.ts::bad record:argument", "/v/a.ts::bad record:spread"])
  })

  it("a record literal under a union contextual type and as a return value", () => {
    expect(
      flagged({
        "/v/a.ts": `${pre}export const maybe: TargetState | undefined = { failures: 0, flight: undefined }
export function fresh(): TargetState { return { failures: 0, flight: undefined } }
`,
      })
    ).toEqual(["/v/a.ts:: record:literal", "/v/a.ts::fresh record:literal"])
  })

  it("the owner field assigned with anything but a direct transition result", () => {
    expect(bad(`  s.targetState = createTargetState()`)).toEqual([
      "/v/a.ts::bad record:assign",
    ])
    expect(
      bad(`  const t = slotChanged(s.targetState, 1)\n  s.targetState = t`)
    ).toEqual(["/v/a.ts::bad record:assign"])
    expect(
      bad(
        `  s.targetState = s.loaded ? slotChanged(s.targetState, 1) : s.targetState`
      )
    ).toEqual(["/v/a.ts::bad record:assign"])
    expect(bad(`  s["targetState"] = createTargetState()`)).toEqual([
      "/v/a.ts::bad record:assign",
    ])
    expect(
      bad(`  const saved = s.targetState\n  s.targetState &&= saved`)
    ).toEqual(["/v/a.ts::bad record:assign"])
    expect(
      bad(
        `  const prev = s.targetState\n  s.targetState ??= slotChanged(prev, 1)`
      )
    ).toEqual(["/v/a.ts::bad record:assign"])
  })

  it("the constructor outside the initializer of a new owner", () => {
    expect(
      bad(
        `  const t = createTargetState()\n  s.targetState = slotChanged(t, 1)`
      )
    ).toEqual(["/v/a.ts::bad record:create"])
  })

  it("the constructor in a literal that is not a whole new owner", () => {
    expect(
      bad(
        // Без lib у самотесті `Partial` — власний відображений тип.
        `  type Part<T> = { [K in keyof T]?: T[K] }\n  const p: Part<Subset> = { targetState: createTargetState() }\n  void p`
      )
    ).toEqual(["/v/a.ts::bad record:create"])
  })

  it("passes a transition result assigned to the owner", () => {
    expect(bad(`  s.targetState = (slotChanged(s.targetState, 2))`)).toEqual([])
  })

  it("a missing record anchor is reported", () => {
    const renamed = {
      ...WORLD,
      "/v/target-state.ts": WORLD["/v/target-state.ts"]!.replaceAll(
        "createTargetState",
        "newTargetState"
      ),
      "/v/subsets.ts": WORLD["/v/subsets.ts"]!.replaceAll(
        "createTargetState",
        "newTargetState"
      ),
    }
    const r = analyze(
      inlineProgram(renamed),
      Object.keys(renamed),
      SELF,
      (f) => f
    )
    expect(r.unresolved).toEqual(["createTargetState"])
  })

  it("a mutable field of the record is reported", () => {
    const r = selfTest({
      "/v/target-state.ts": WORLD["/v/target-state.ts"]!.replace(
        "  readonly failures: number",
        "  failures: number"
      ),
    })
    expect(r.mutableRecordFields).toEqual(["failures"])
    expect(selfTest({}).mutableRecordFields).toEqual([])
  })
})
