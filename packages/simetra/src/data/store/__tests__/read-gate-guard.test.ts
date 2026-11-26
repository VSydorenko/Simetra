import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

/*
 * Страж шлюзу читань (план SK-1, Р-SK1-10). Рішення «читати» ухвалює шлюз
 * (`store/sync/`); шлях лише питає його. Чотири правила, за символами type
 * checker-а, а не за іменами: псевдонім, деструктуризація й передача функції
 * не обходять їх.
 *
 * (1) Бренд польоту не згадується поза `sync/`.
 * (2) Сирий стан умов читають лише шлюз, власник стану й тіла зворотних
 *     викликів, переданих у `session.commit` чи `settle`; решта — перелік з
 *     причиною.
 * (3) Запити умов шлюзу — лише в місцях переліку, кожне з причиною.
 * (4) Функції інвентаря (Додаток Б, колонка «Файл :: функція») і помічники
 *     сховища, яких вони кличуть транзитивно, не мають читань з (2) і (3),
 *     крім винятків переліку з рішенням, на якому кожен стоїть.
 */

const DATA = join(import.meta.dirname, "..", "..")

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

const GATE_QUERIES = [
  "closed",
  "staleObject",
  "discardBound",
  "settledPastBound",
  "tabHidden",
  "refusal",
  "timersRead",
] as const
type GateQuery = (typeof GATE_QUERIES)[number]

/**
 * Вид читання. Сирий стан (2): геттер `valid` токена сесії (`child-token` —
 * токен, створений `session.childToken`), `versions.unavailable`, змінна
 * `visible` ядра, `isClosed`, множина `staleObjects`. Запит шлюзу (3):
 * `gate.<запит>`.
 */
type Kind =
  | "token"
  | "child-token"
  | "unavailable"
  | "visible"
  | "isClosed"
  | "staleObjects"
  | `gate.${GateQuery}`

type Member = readonly [file: string, owner: string, member: string]
type Named = readonly [file: string, name: string]

/** Де в програмі живе те, що стереже страж: шлях файлу й ім'я. */
interface Anchors {
  /** Каталог шлюзу (з кінцевою `/`): його читання — рішення шлюзу. */
  readonly sync: string
  /** Файли власника стану (сесія): реалізація токена й межі відкинутих. */
  readonly owners: readonly string[]
  /** Файли, які страж розбирає (сховище без тестів). */
  readonly scope: (file: string) => boolean
  readonly token: Member
  readonly childToken: Member
  readonly commit: Member
  readonly unavailable: Member
  readonly settle: Named
  readonly visible: Named
  readonly staleObjects: Named
  readonly isClosed: Named
  readonly gate: Named
  readonly gateState: Named
  readonly brand: Named
  readonly flight: Named
  /** Реєстрації, чий зворотний виклик — функція інвентаря (`onFlush`). */
  readonly callbacks: readonly Member[]
}

interface Read {
  readonly kind: Kind
  /** Усередині зворотного виклику `commit` чи `settle` (осідання). */
  readonly settled: boolean
  readonly line: number
  /** Позиція в файлі: одне входження — одна знахідка. */
  readonly pos: number
}

interface Edge<T> {
  readonly to: T
  readonly settled: boolean
  readonly line: number
  readonly pos: number
}

/** Функція (чи функціональне значення) сховища: одиниця аналізу. */
interface Unit {
  readonly key: string
  readonly name: string
  readonly file: string
  readonly node: ts.Node
  /**
   * Носій: властивість літерала з контекстним типом, чиє значення — посилання
   * чи стрілка-вираз. Він передає функцію в чужий модуль, тож його читання
   * звітують на місці виклику члена (`via`).
   */
  carrier: boolean
  /** Реалізує член `GateState`: стан шлюзу, який читає лише шлюз. */
  gateState: boolean
  readonly reads: Read[]
  readonly children: Edge<Unit>[]
  readonly refs: Edge<ts.Node>[]
  readonly members: Edge<ts.Node>[]
}

interface Finding {
  readonly key: string
  readonly kind: Kind
  /** Член інтерфейсу, через який читання передано (`Owner.member`). */
  readonly via?: string
  /** Рядок файлу: лише для повідомлень, не для переліку. */
  readonly line?: number
  /** Позиція входження (місце виклику для `via`): рахує входження. */
  readonly pos?: number
  /** Шлях від функції інвентаря (правило 4): лише для повідомлень. */
  readonly path?: readonly string[]
}

const render = (f: Finding) =>
  `${f.key} ${f.kind}${f.via === undefined ? "" : ` via ${f.via}`}`

const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) ||
  ts.isAsExpression(e) ||
  ts.isSatisfiesExpression(e) ||
  ts.isNonNullExpression(e)
    ? unwrap(e.expression)
    : e

const isFn = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n)

const textOf = (name: ts.Node | undefined): string | undefined =>
  name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))
    ? name.text
    : undefined

function findMember(program: ts.Program, [file, owner, member]: Member) {
  const sf = program.getSourceFile(file)
  const decl = sf?.statements.find(
    (s): s is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(s) && s.name.text === owner
  )
  const found = decl?.members.find((m) => textOf(m.name) === member)
  if (found === undefined) throw new Error(`no ${owner}.${member} in ${file}`)
  return found
}

function findNamed(program: ts.Program, [file, name]: Named): ts.Node {
  const sf = program.getSourceFile(file)
  if (sf === undefined) throw new Error(`no file ${file}`)
  const out: ts.Node[] = []
  const visit = (n: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isInterfaceDeclaration(n) ||
        ts.isTypeAliasDeclaration(n)) &&
      textOf(n.name) === name
    )
      out.push(n)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  // Ім'я неоднозначне чи зникло — страж мовчки нічого б не стеріг.
  if (out.length !== 1)
    throw new Error(`${name} in ${file}: ${out.length} declarations`)
  return out[0]!
}

function declsOf(checker: ts.TypeChecker, n: ts.Node): readonly ts.Node[] {
  let symbol =
    ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n
      ? checker.getShorthandAssignmentValueSymbol(n.parent)
      : checker.getSymbolAtLocation(n)
  if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias)
    symbol = checker.getAliasedSymbol(symbol)
  return symbol?.declarations ?? []
}

function calleeDecls(checker: ts.TypeChecker, call: ts.CallExpression) {
  const callee = unwrap(call.expression)
  return declsOf(
    checker,
    ts.isPropertyAccessExpression(callee) ? callee.name : callee
  )
}

/**
 * Ім'я члена для `via`: `Owner.member`; власник — найближче іменоване
 * оголошення (інтерфейс, тип чи функція, чий параметр має тип-літерал).
 */
function memberLabel(decl: ts.Node): string {
  const member = textOf(ts.getNameOfDeclaration(decl as ts.Declaration)) ?? "?"
  let owner: string | undefined
  for (
    let n = decl.parent;
    owner === undefined && n !== undefined;
    n = n.parent
  )
    if (
      ts.isInterfaceDeclaration(n) ||
      ts.isTypeAliasDeclaration(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isClassDeclaration(n)
    )
      owner = n.name?.text
  return `${owner ?? "?"}.${member}`
}

const isMemberDecl = (d: ts.Node) =>
  ts.isPropertySignature(d) ||
  ts.isMethodSignature(d) ||
  ts.isPropertyDeclaration(d)

interface Analysis {
  /** Правило (1): згадки бренду польоту й твердження `as Flight` поза `sync/`. */
  readonly brand: readonly string[]
  /** Правила (2), (3): кожне читання сховища поза шлюзом і власником. */
  readonly sites: readonly Finding[]
  /**
   * Правило (4): читання функцій від `roots` транзитивно; `roots` — ключі
   * знайдених коренів.
   */
  closure(
    roots: readonly Root[],
    options?: { readonly throughSettlement?: boolean }
  ): {
    readonly findings: readonly Finding[]
    readonly roots: readonly string[]
  }
}

/**
 * Корінь замикання: функція файлу за іменем; третій елемент — ім'я функції,
 * яку корінь кличе сам (розрізняє безіменні колбеки одного члена, `onFlush`).
 */
type Root =
  | readonly [file: string, name: string]
  | readonly [file: string, name: string, calls: string]

function analyze(
  program: ts.Program,
  files: readonly string[],
  anchors: Anchors,
  label: (file: string) => string
): Analysis {
  const checker = program.getTypeChecker()
  const tokenValid = findMember(program, anchors.token)
  const childToken = findMember(program, anchors.childToken)
  const commit = findMember(program, anchors.commit)
  const unavailable = findMember(program, anchors.unavailable)
  const settle = findNamed(program, anchors.settle)
  const visible = findNamed(program, anchors.visible)
  const staleObjects = findNamed(program, anchors.staleObjects)
  const isClosed = findNamed(program, anchors.isClosed)
  const brand = findNamed(program, anchors.brand)
  const flight = findNamed(program, anchors.flight)
  const gateQuery = new Map<ts.Node, GateQuery>(
    GATE_QUERIES.map((q) => [
      findMember(program, [anchors.gate[0], anchors.gate[1], q]),
      q,
    ])
  )
  const gateDecl = findNamed(program, anchors.gate) as ts.InterfaceDeclaration
  const gateStateDecl = findNamed(
    program,
    anchors.gateState
  ) as ts.InterfaceDeclaration
  const callbacks = anchors.callbacks.map((m) => findMember(program, m))

  const exempt = (file: string) =>
    file.startsWith(anchors.sync) || anchors.owners.includes(file)

  const units = new Map<ts.Node, Unit>()
  const all: Unit[] = []
  const bound = new Map<ts.Node, Unit[]>()
  const brandHits: string[] = []

  const nameOfUnit = (n: ts.Node): string | undefined => {
    if (ts.isFunctionDeclaration(n)) return n.name?.text
    if (
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n)
    )
      return textOf(n.name)
    if (ts.isVariableDeclaration(n))
      return n.initializer !== undefined && isFn(unwrap(n.initializer))
        ? textOf(n.name)
        : undefined
    if (ts.isPropertyAssignment(n)) {
      const value = unwrap(n.initializer)
      return isFn(value) ||
        ts.isIdentifier(value) ||
        ts.isPropertyAccessExpression(value)
        ? textOf(n.name)
        : undefined
    }
    if (ts.isShorthandPropertyAssignment(n)) return n.name.text
    // Зворотний виклик реєстрації (`session.onFlush(() => …)`) — функція
    // інвентаря без власного імені: її називає член реєстрації.
    if (
      isFn(n) &&
      ts.isCallExpression(n.parent) &&
      n.parent.arguments.includes(n as ts.Expression)
    ) {
      const callee = calleeDecls(checker, n.parent)
      const hit = callbacks.find((d) => callee.includes(d))
      if (hit !== undefined) return textOf((hit as ts.TypeElement).name)
    }
    return undefined
  }

  // Носій — тонке значення: посилання чи стрілка з виразом замість тіла.
  const thin = (n: ts.Node) => {
    if (ts.isShorthandPropertyAssignment(n)) return true
    if (!ts.isPropertyAssignment(n)) return false
    const value = unwrap(n.initializer)
    return (
      ts.isIdentifier(value) ||
      ts.isPropertyAccessExpression(value) ||
      (ts.isArrowFunction(value) && !ts.isBlock(value.body))
    )
  }

  const settles = (n: ts.Node) => {
    if (!isFn(n) || !ts.isCallExpression(n.parent)) return false
    if (!n.parent.arguments.includes(n as ts.Expression)) return false
    const callee = calleeDecls(checker, n.parent)
    return callee.includes(commit) || callee.includes(settle)
  }

  // `getNameOfDeclaration` бачить і доступ `a.b` (JS-експандо): його ім'я —
  // використання, а не оголошення.
  const isDeclName = (n: ts.Node) =>
    !ts.isPropertyAccessExpression(n.parent) &&
    !ts.isBinaryExpression(n.parent) &&
    !ts.isShorthandPropertyAssignment(n.parent) &&
    ts.getNameOfDeclaration(n.parent as ts.Declaration) === n

  const tokenKind = (n: ts.Identifier): Kind => {
    const access = n.parent
    if (!ts.isPropertyAccessExpression(access)) return "token"
    const receiver = unwrap(access.expression)
    if (!ts.isIdentifier(receiver)) return "token"
    const made = declsOf(checker, receiver).some(
      (d) =>
        ts.isVariableDeclaration(d) &&
        d.initializer !== undefined &&
        ts.isCallExpression(unwrap(d.initializer)) &&
        calleeDecls(
          checker,
          unwrap(d.initializer) as ts.CallExpression
        ).includes(childToken)
    )
    return made ? "child-token" : "token"
  }

  const kindOf = (
    decls: readonly ts.Node[],
    n: ts.Identifier
  ): Kind | undefined => {
    if (decls.includes(tokenValid)) return tokenKind(n)
    if (decls.includes(unavailable)) return "unavailable"
    for (const d of decls) {
      const q = gateQuery.get(d)
      if (q !== undefined) return `gate.${q}`
    }
    const p = n.parent
    if (decls.includes(visible)) {
      const written =
        ts.isBinaryExpression(p) &&
        p.left === n &&
        p.operatorToken.kind === ts.SyntaxKind.EqualsToken
      return written ? undefined : "visible"
    }
    if (decls.includes(staleObjects)) {
      // Записувачі множини (`add`, `delete`, `clear`) не читають її.
      const mutated =
        ts.isPropertyAccessExpression(p) &&
        p.expression === n &&
        ["add", "delete", "clear"].includes(p.name.text) &&
        ts.isCallExpression(p.parent) &&
        p.parent.expression === p
      return mutated ? undefined : "staleObjects"
    }
    if (decls.includes(isClosed)) return "isClosed"
    return undefined
  }

  const bindingKind = (be: ts.BindingElement): Kind | undefined => {
    if (!ts.isObjectBindingPattern(be.parent)) return undefined
    const name = textOf(be.propertyName ?? be.name)
    if (name === undefined) return undefined
    const prop = checker.getTypeAtLocation(be.parent).getProperty(name)
    const decls = prop?.declarations ?? []
    if (decls.includes(tokenValid)) return "token"
    if (decls.includes(unavailable)) return "unavailable"
    for (const d of decls) {
      const q = gateQuery.get(d)
      if (q !== undefined) return `gate.${q}`
    }
    return undefined
  }

  for (const file of files) {
    if (!anchors.scope(file)) continue
    const sf = program.getSourceFile(file)!
    const module: Unit = {
      key: `${label(file)}::<module>`,
      name: "<module>",
      file,
      node: sf,
      carrier: false,
      gateState: false,
      reads: [],
      children: [],
      refs: [],
      members: [],
    }
    all.push(module)
    const at = (n: ts.Node) => ({
      line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
      pos: n.getStart(),
    })
    const visit = (
      n: ts.Node,
      unit: Unit,
      chain: readonly string[],
      settled: boolean
    ): void => {
      let here = unit
      let names = chain
      const name = nameOfUnit(n)
      if (name !== undefined) {
        names = [...chain, name]
        here = {
          key: `${label(file)}::${names.join(".")}`,
          name,
          file,
          node: n,
          carrier: false,
          gateState: false,
          reads: [],
          children: [],
          refs: [],
          members: [],
        }
        units.set(n, here)
        all.push(here)
        unit.children.push({ to: here, settled, ...at(n) })
        const literal = n.parent
        if (
          (ts.isPropertyAssignment(n) ||
            ts.isShorthandPropertyAssignment(n) ||
            ts.isMethodDeclaration(n)) &&
          ts.isObjectLiteralExpression(literal)
        ) {
          const context = checker.getContextualType(literal)
          const types =
            context === undefined
              ? []
              : context.isUnion() || context.isIntersection()
                ? context.types
                : [context]
          for (const t of types)
            for (const d of t.getProperty(name)?.declarations ?? [])
              if (d !== n) {
                here.carrier = thin(n)
                if (gateStateDecl.members.includes(d as ts.TypeElement))
                  here.gateState = true
                bound.set(d, [...(bound.get(d) ?? []), here])
              }
        }
      } else if (ts.isVariableDeclaration(n) && textOf(n.name) !== undefined)
        names = [...chain, textOf(n.name)!]
      const inner = settled || settles(n)

      if (ts.isIdentifier(n) && !isDeclName(n)) {
        const decls = declsOf(checker, n)
        if (decls.includes(brand) && !file.startsWith(anchors.sync)) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
          brandHits.push(`${label(file)}:${line} ${n.text}`)
        }
        const kind = kindOf(decls, n)
        if (kind !== undefined)
          here.reads.push({ kind, settled: inner, ...at(n) })
        for (const d of decls) {
          if (isMemberDecl(d))
            here.members.push({ to: d, settled: inner, ...at(n) })
          else here.refs.push({ to: d, settled: inner, ...at(n) })
        }
      }
      if (ts.isBindingElement(n)) {
        const kind = bindingKind(n)
        if (kind !== undefined)
          here.reads.push({ kind, settled: inner, ...at(n) })
      }
      if (
        (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) &&
        !file.startsWith(anchors.sync) &&
        ts.isTypeReferenceNode(n.type) &&
        declsOf(checker, n.type.typeName).includes(flight)
      ) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
        brandHits.push(`${label(file)}:${line} as ${n.type.typeName.getText()}`)
      }
      ts.forEachChild(n, (c) => visit(c, here, names, inner))
    }
    visit(sf, module, [], false)
  }

  // Члени, які страж знає й так: запит шлюзу — сам по собі вид читання, а
  // стан шлюзу (`GateState`) читає лише шлюз.
  const known = new Set<ts.Node>([
    ...gateDecl.members,
    ...gateStateDecl.members,
  ])
  /** Читання носіїв члена, і носіїв, яких носій сам передає далі. */
  const carried = (member: ts.Node, seen = new Set<ts.Node>()): Read[] => {
    if (known.has(member) || seen.has(member)) return []
    seen.add(member)
    return (bound.get(member) ?? [])
      .filter((b) => b.carrier && !exempt(b.file))
      .flatMap((b) => [
        ...b.reads.filter((r) => !r.settled),
        ...b.members.flatMap((e) => (e.settled ? [] : carried(e.to, seen))),
      ])
  }
  /** Читання, передані функцією через член інтерфейсу: на місці виклику. */
  const viaOf = (unit: Unit, throughSettlement: boolean): Finding[] =>
    unit.members.flatMap((edge) =>
      edge.settled && !throughSettlement
        ? []
        : carried(edge.to).map((r) => ({
            key: unit.key,
            kind: r.kind,
            via: memberLabel(edge.to),
            line: edge.line,
            pos: edge.pos,
          }))
    )
  const own = (unit: Unit): Finding[] =>
    unit.reads
      .filter((r) => !r.settled)
      .map((r) => ({ key: unit.key, kind: r.kind, line: r.line, pos: r.pos }))

  const unique = (findings: readonly Finding[]) => [
    ...new Map(findings.map((f) => [`${render(f)} @${f.pos}`, f])).values(),
  ]

  // Носій — місце, де читання лежить лексично (його власні читання); що він
  // передає далі, звітує місце виклику.
  const sites = unique(
    all
      .filter((u) => !exempt(u.file) && !u.gateState)
      .flatMap((u) => [...own(u), ...(u.carrier ? [] : viaOf(u, false))])
  )

  return {
    brand: brandHits,
    sites,
    closure(roots, options = {}) {
      const through = options.throughSettlement === true
      const queue: Unit[] = []
      for (const [file, name, calls] of roots) {
        const named = all.filter(
          (u) =>
            u.file === file &&
            (u.key.endsWith(`::${name}`) || u.key.endsWith(`.${name}`)) &&
            (calls === undefined ||
              u.refs.some(
                (e) =>
                  textOf(ts.getNameOfDeclaration(e.to as ts.Declaration)) ===
                  calls
              ))
        )
        // Носій (`{ load }`, `revalidate: (…) => revalidate(…)`) — корінь,
        // лише коли самої функції під цим іменем немає.
        const own = named.filter((u) => !u.carrier)
        const found = own.length > 0 ? own : named
        // Корінь, що зник чи збігся з іншою функцією, тихо змінив би
        // замикання.
        if (found.length !== 1)
          throw new Error(
            `${found.length} units ${name} in ${file}: ${found.map((u) => u.key).join(", ")}`
          )
        queue.push(...found)
      }
      const rootKeys = queue.map((u) => u.key)
      const from = new Map<Unit, Unit | undefined>(
        queue.map((u) => [u, undefined])
      )
      const add = (u: Unit | undefined, parent: Unit) => {
        if (u === undefined || from.has(u) || exempt(u.file)) return
        if (!anchors.scope(u.file)) return
        from.set(u, parent)
        queue.push(u)
      }
      while (queue.length > 0) {
        const u = queue.shift()!
        for (const e of u.children) if (through || !e.settled) add(e.to, u)
        for (const e of u.refs)
          if (through || !e.settled) add(units.get(e.to), u)
        for (const e of u.members)
          if (through || !e.settled)
            for (const b of bound.get(e.to) ?? []) add(b, u)
      }
      const pathOf = (u: Unit): string[] => {
        const out: string[] = []
        for (let at: Unit | undefined = u; at !== undefined; at = from.get(at))
          out.unshift(at.key)
        return out
      }
      // Носій звітує на місці виклику (`via`), а не в собі: інакше одне
      // читання — двічі.
      const findings = unique(
        [...from.keys()].flatMap((u) =>
          (u.carrier && !rootKeys.includes(u.key)
            ? []
            : [...own(u), ...viaOf(u, through)]
          ).map((f) => ({
            ...f,
            path: pathOf(u),
          }))
        )
      )
      return { findings, roots: rootKeys }
    },
  }
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
  host.directoryExists = (dir) => ["/", "/v", "/v/sync"].includes(dir)
  host.realpath = (path) => path
  return ts.createProgram([...files.keys()], options, host)
}

// ------------------------------------------------------------ реальний код

const STORE = join(DATA, "store")
const at = (file: string) => join(STORE, file)

const REAL: Anchors = {
  sync: at("sync") + "/",
  owners: [at("session.ts")],
  scope: (file) =>
    file.startsWith(STORE + "/") &&
    !file.includes("/__tests__/") &&
    !file.includes("/testing/"),
  token: [at("types.ts"), "GenerationToken", "valid"],
  childToken: [at("session.ts"), "Session", "childToken"],
  commit: [at("session.ts"), "Session", "commit"],
  unavailable: [at("session.ts"), "VersionEpochs", "unavailable"],
  settle: [at("source.ts"), "settle"],
  visible: [at("core.ts"), "visible"],
  staleObjects: [at("core.ts"), "staleObjects"],
  isClosed: [at("subsets.ts"), "isClosed"],
  gate: [at("sync/flight.ts"), "Gate"],
  gateState: [at("sync/flight.ts"), "GateState"],
  brand: [at("sync/flight.ts"), "FLIGHT"],
  flight: [at("sync/flight.ts"), "Flight"],
  callbacks: [
    [at("session.ts"), "Session", "onFlush"],
    [at("session.ts"), "Session", "onClose"],
    [at("session.ts"), "Session", "onSwitch"],
  ],
}

/**
 * Функції колонки «Файл :: функція» Додатка Б (поза дужками тригерів), з
 * кодами рядків. `onFlush` — лише колбек R10 (той, що кличе
 * `revalidateHolders`): інші колбеки `session.onFlush` кореня не мають.
 */
const INVENTORY: readonly Root[] = [
  [at("subsets.ts"), "start"], // M1, M2, M3
  [at("subsets.ts"), "load"], // M1, M2, M4, M5, M6, M7, M8
  [at("subsets.ts"), "preload"], // M2
  [at("subsets.ts"), "check"], // M3, M4
  [at("subsets.ts"), "queueCheck"], // M4
  [at("subsets.ts"), "makeHandle.refresh"], // M5
  [at("subsets.ts"), "makeHandle.showNew"], // M5
  [at("subsets.ts"), "loadMore"], // P1, P2, P3
  [at("core.ts"), "runDue"], // R1, R3
  [at("core.ts"), "reconcile"], // R2, R5, R6
  [at("writer.ts"), "revalidate"], // R2, R4, R8
  [at("core.ts"), "revalidate"], // R7
  [at("core.ts"), "fireWave"], // R4
  [at("core.ts"), "endHydration"], // R5
  [at("core.ts"), "resume"], // R6
  [at("receiver.ts"), "run"], // R8, R9, K1, K2
  [at("writer.ts"), "singleFlight"], // R9, R12, R13
  [at("core.ts"), "onFlush", "revalidateHolders"], // R10
  [at("writer.ts"), "revalidateHolders"], // R10
  [at("core.ts"), "narrow"], // R11
  [at("writer.ts"), "revalidateNarrowed"], // R11
  [at("writer.ts"), "invalidateLoads"], // R11
  [at("core.ts"), "rereadBarred"], // R12
  [at("core.ts"), "readRequirement"], // R13
  [at("core.ts"), "readHydrated"], // R14
  [at("writer.ts"), "revalidateHydrated"], // R14
  [at("writer.ts"), "tailPass"], // R15
  [at("writer.ts"), "revalidateViews"], // R16, R17, R18
  [at("receiver.ts"), "startJob"], // K1
  [at("source.ts"), "readKeys"], // K1
  [at("receiver.ts"), "scheduleRetry"], // K2
  [at("receiver.ts"), "enqueue"], // K2
  [at("core.ts"), "runTail"], // K3
  [at("writer.ts"), "rereadKey"], // K4
  [at("core.ts"), "startVersion"], // S1
  [at("core.ts"), "requestRights"], // S2
  [at("core.ts"), "dispatch"], // S3
]

/**
 * Перелік дозволених місць: одна група — клас причини і названі місця
 * (`<файл>::<функція> <вид>[ via <член>]`). `inventory: true` — виняток
 * правила (4): місце лежить у замиканні функцій Додатка Б і стоїть на
 * рішенні, яке група називає. `inventory: false` — місце правил (2), (3) поза
 * замиканням: функцій Додатка Б і їхніх помічників там бути не може.
 */
interface Group {
  readonly inventory: boolean
  /**
   * Запит шлюзу може стояти в самій функції Додатка Б: правило (4) дозволяє
   * наслідок осідання (Р-SK1-7) й іменовані перевірки (Р-SK1-8), а
   * перелік Р-SK1-9 (таймери, діагностика, пізня відмова, ознаки) — ні.
   */
  readonly atInventory?: true
  readonly reason: string
  readonly sites: readonly string[]
}

const PLACES: readonly Group[] = [
  // ---------------------------------------------- поза замиканням (2), (3)
  {
    inventory: false,
    reason:
      "Носій: властивість контексту передає запит шлюзу чи стан у модуль, що його кличе; місце виклику звітує саме (`via`). `scheduler.closed` — запит умови `closed` для таймера (Р-SK1-9)",
    sites: [
      "core.ts::createCore.batcher.staleObject gate.staleObject",
      "core.ts::createCore.registry.isStale staleObjects",
      "core.ts::createCore.registry.tabHidden gate.tabHidden",
      "core.ts::createCore.writerContext.isStale staleObjects",
      "core.ts::createCore.overlay.isStale staleObjects",
      "core.ts::createCore.tabHidden gate.tabHidden",
      "core.ts::createCore.scheduler.visible gate.tabHidden",
      "core.ts::createCore.scheduler.closed gate.closed",
      "core.ts::createCore.source.settledPastBound gate.settledPastBound",
    ],
  },
  {
    inventory: false,
    reason:
      "Запит умови шлюзу для таймера (Р-SK1-9): строк хвилі приєднання, строк R1 `freshness.requestReread` і перемикання епохи не ставиться закритій сесії й несумісному об'єкту; читання судить `admit` у такті",
    sites: [
      "core.ts::createCore.joinWave gate.closed",
      "core.ts::createCore.joinWave gate.staleObject",
      "core.ts::createCore.core.requestReread gate.closed",
      "core.ts::createCore.onSwitch gate.staleObject",
    ],
  },
  {
    inventory: false,
    reason:
      "Діагностика `sync()` (Р-SK1-9, Р-SK1-12): відмова, відкладення й строки, які показує інспекція, беруться зі шлюзу — тим самим предикатом, що судить `admit`",
    sites: [
      "core.ts::createCore.syncState gate.tabHidden",
      "core.ts::createCore.syncState gate.refusal ×4",
      "core.ts::createCore.syncState gate.timersRead",
      "core.ts::createCore.syncState.conditionOf gate.tabHidden ×2",
      "core.ts::createCore.timerDue gate.timersRead",
      "core.ts::createCore.versionEpochs unavailable",
    ],
  },
  {
    inventory: false,
    reason:
      "Публічні ознаки й публічне API (Р-SK1-9, PR #433): `core.visible`, прапор знімка, відмова мутації `stale-client` журналу, відмова виклику закритого ядра (`view`, `subscribe`, `hydrate`, `dehydrate`) і токен журналу мутацій — не рішення читати",
    sites: [
      "core.ts::createCore.core.visible gate.tabHidden",
      "subsets.ts::createRegistry.idleSnapshot staleObjects via RegistryContext.isStale",
      "overlay.ts::createOverlay.send staleObjects via createOverlay.isStale",
      "overlay.ts::createOverlay.retry token",
      "overlay.ts::createOverlay.update token",
      "subsets.ts::createRegistry.view isClosed",
      "subsets.ts::createRegistry.makeHandle.subscribe isClosed ×2",
      "core.ts::createCore.core.hydrate token",
      "core.ts::createCore.core.dehydrate token",
    ],
  },
  {
    inventory: false,
    reason:
      "Запит умови `closed` поза `admit` для відмови мутації `stale-client` (публічна ознака, Р-SK1-9): закрита сесія не ставить позначку `commit`-ом і не просить версію (запит версії S1 далі судить `admit`)",
    sites: ["core.ts::createCore.core.staleClient gate.closed"],
  },
  {
    inventory: false,
    reason:
      "Іменована перевірка над `gate.tabHidden()` у `loadMore` → `confirm` (Р-SK1-8): мить зняття позначки сторінки до сповіщення, наслідок осідання; кличе її колбек `commit`",
    sites: [
      "subsets.ts::createRegistry.confirm gate.tabHidden via RegistryContext.tabHidden",
    ],
  },
  {
    inventory: false,
    reason:
      "Записувач стану: `markStale` ставить позначку лише раз (`has` перед `add`)",
    sites: ["core.ts::createCore.markStale staleObjects"],
  },
  // --------------------------------------------- винятки правила (4)
  {
    inventory: true,
    reason:
      "Пізня відмова Р-SK1-6: частини вже допущеного польоту — `dispatch` до збирача, збирач на скиданні — той самий предикат шлюзу",
    sites: [
      "core.ts::createCore.dispatch.isLive gate.staleObject",
      "core.ts::createCore.dispatch.withLiveInclude gate.staleObject",
      "batcher.ts::createBatcher.isRefused gate.staleObject via createBatcher.staleObject",
    ],
  },
  {
    inventory: true,
    atInventory: true,
    reason:
      "Наслідок осідання за межею Р-SK1-7 (`settledPastBound`): вибір «`EPOCH_UNAVAILABLE` чи повтор» після запису, строки R1/R3/R4 і зупинка збору сигналів приймача",
    sites: [
      "core.ts::createCore.dropDeferredWhenUnavailable gate.settledPastBound",
      "receiver.ts::createReceiver.halted gate.settledPastBound via StoreSource.settledPastBound",
      "subsets.ts::createRegistry.load.attempt gate.settledPastBound via StoreSource.settledPastBound",
      "writer.ts::revalidateViews gate.settledPastBound via StoreSource.settledPastBound",
    ],
  },
  {
    inventory: true,
    atInventory: true,
    reason:
      "Іменовані перевірки (рішення архітекторки 25.11, PR #433): `fireWave` — ефекти хвилі поза читанням (варіант (в)); `onFlush` — схований об'єкт не-цілі (R10); `receiver.run` — не-читальні ефекти пачки на прихованій вкладці й несумісного об'єкта (Р-SK1-8)",
    sites: [
      "core.ts::createCore.fireWave token",
      "core.ts::createCore.fireWave staleObjects",
      "core.ts::createCore.onFlush staleObjects",
      "receiver.ts::createReceiver.run gate.tabHidden via ReceiverContext.tabHidden",
      "receiver.ts::createReceiver.run staleObjects via ReaderContextBase.isStale",
    ],
  },
  {
    inventory: true,
    reason:
      "Дочірній токен цілі (`session.childToken`, M7, M8, P2, P3) — токен витіснення цілі §5.4, який SK-2 переносить у політ; `closed` у цих шляхах судить `admit` (Р-SK1-10)",
    sites: [
      "subsets.ts::createRegistry.load.attempt child-token ×3",
      "subsets.ts::createRegistry.loadMore.attempt child-token ×3",
    ],
  },
  {
    inventory: true,
    reason:
      "(i) Токен продовження польоту: параметр читання (сторінки, `include`, повтори), токен покоління вигляду §5.4, який SK-2 переносить у політ; продовження причину й ціль бере з рядка, що його почав (§5.3)",
    sites: [
      "readers.ts::fetchFull token",
      "readers.ts::fetchFullAgain token",
      "readers.ts::readFull token",
      "readers.ts::readWindowIncluded token",
      "window.ts::fetchPage token",
      "window.ts::rereadPages token",
    ],
  },
  {
    inventory: true,
    reason:
      "(ii) Токен охороняє не-читальні ефекти після закриття: журнал (`rights-failed`, `listener-failed`), застосування версії й знімка прав, `core.close`, `commit` після таймауту K4, підсумок спроби `closed` (`watchAttempts`), підписки приймача; читання судить `admit`",
    sites: [
      "core.ts::createCore.dispatch token",
      "core.ts::createCore.batcher.onVersion token",
      "core.ts::createCore.acceptRights token",
      "core.ts::createCore.rightsSessionChanged token",
      "core.ts::createCore.connectionRefused token",
      "core.ts::createCore.startVersion token",
      "writer.ts::rereadKey token",
      "subsets.ts::createRegistry.load.attempt.lost token",
      "subsets.ts::createRegistry.loadMore.attempt.lost token",
      "receiver.ts::createReceiver.sync token",
    ],
  },
  {
    inventory: true,
    reason:
      "(iii) Публічні ознаки й відмова запису: `ops.put`/`putSection` відмовляють запису рядка несумісного об'єкта, `applyIncluded` — цілі `include`; знімок вигляду (`isStale`, `needsRefresh`) після `commit` (Р-SK1-9)",
    sites: [
      "core.ts::createCore.ops.put staleObjects",
      "core.ts::createCore.ops.putSection staleObjects",
      "readers.ts::applyIncluded staleObjects via ReaderContextBase.isStale",
      "subsets.ts::createRegistry.computeSnapshot gate.tabHidden via RegistryContext.tabHidden",
      "subsets.ts::createRegistry.computeSnapshot staleObjects via RegistryContext.isStale",
    ],
  },
  {
    inventory: true,
    reason:
      "(iv) Таймерні запити шлюзу (Р-SK1-9), до яких шлях доходить, ставлячи строк (`schedule`, `scheduler.request`): строк і такт планувальника, строк знімка прав; читання такту судить `admit`",
    sites: [
      "core.ts::createCore.schedule gate.staleObject",
      "core.ts::createCore.scheduler.tick gate.discardBound",
      "core.ts::createCore.scheduler.tick gate.staleObject",
      "core.ts::createCore.schedulerDue gate.discardBound",
      "core.ts::createCore.schedulerDue gate.staleObject",
      "core.ts::createCore.rightsDueAt gate.tabHidden",
      "scheduler.ts::createScheduler.fire gate.tabHidden via SchedulerContext.visible",
      "scheduler.ts::createScheduler.fire gate.closed via SchedulerContext.closed",
      "scheduler.ts::createScheduler.plan gate.tabHidden via SchedulerContext.visible",
      "scheduler.ts::createScheduler.plan gate.closed via SchedulerContext.closed",
    ],
  },
  {
    inventory: true,
    reason:
      "(v) Публічне API входу: `preload` закритого ядра відмовляє виклику до польоту — без утримання й без читання (публічний знімок закриття, Р-SK1-5)",
    sites: ["subsets.ts::createRegistry.preload isClosed"],
  },
]

const isQuery = (site: string) => / gate\.\w+( |$)/.test(site)

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

/**
 * Місце переліку: `<ключ> <вид>[ via <член>]`, з ` ×N`, коли в функції N
 * входжень. Кожне входження — окрема знахідка: друге читання того ж виду в
 * тій самій функції не ховається за першим, дозволеним.
 */
const parsePlace = (place: string): readonly [string, number] => {
  const m = / ×(\d+)$/.exec(place)
  return m === null ? [place, 1] : [place.slice(0, m.index), Number(m[1])]
}

const countOf = (findings: readonly Finding[]) => {
  const out = new Map<string, Finding[]>()
  for (const f of findings)
    out.set(render(f), [...(out.get(render(f)) ?? []), f])
  return out
}

/** Розбіжності «знайдено ≠ дозволено»: `<місце>: N≠M @рядки`. */
function mismatches(
  found: ReadonlyMap<string, readonly Finding[]>,
  allowed: ReadonlyMap<string, number>,
  trace = false
): string[] {
  const out: string[] = []
  for (const site of new Set([...found.keys(), ...allowed.keys()])) {
    const hits = found.get(site) ?? []
    const want = allowed.get(site) ?? 0
    if (hits.length === want) continue
    const where = hits
      .map(
        (f) => `@${f.line}` + (trace ? ` <= ${(f.path ?? []).join(" > ")}` : "")
      )
      .join(", ")
    out.push(`${site}: found ${hits.length}, listed ${want} ${where}`.trim())
  }
  return out.sort()
}

describe("read gate guard on the store", () => {
  const analysis = realProgram()
  const inventory = analysis.closure(INVENTORY)
  const places = (inv?: boolean) =>
    new Map(
      PLACES.filter((g) => inv === undefined || g.inventory === inv)
        .flatMap((g) => g.sites)
        .map(parsePlace)
    )
  const sites = countOf(analysis.sites)
  const closure = countOf(inventory.findings)

  it("(1) the flight brand is not mentioned outside sync/", () => {
    expect(analysis.brand).toEqual([])
  })

  it("(2), (3) raw condition state and gate queries are read only at listed places, as many times as listed", () => {
    expect(mismatches(sites, places())).toEqual([])
  })

  it("(4) the inventory functions and their helpers read only through listed exceptions, as many times as listed", () => {
    expect(mismatches(closure, places(true), true)).toEqual([])
  })

  it("places outside the inventory are not reached from it", () => {
    expect([...places(false).keys()].filter((s) => closure.has(s))).toEqual([])
  })

  it("gate queries of the Р-SK1-9 list are not at an inventory function itself", () => {
    const atRoot = PLACES.filter((g) => g.atInventory !== true)
      .flatMap((g) => g.sites)
      .map((site) => parsePlace(site)[0])
      .filter(
        (site) => isQuery(site) && inventory.roots.includes(site.split(" ")[0]!)
      )
    expect(atRoot).toEqual([])
  })

  it("every listed place is named once, with a reason", () => {
    const named = PLACES.flatMap((g) => g.sites).map((s) => parsePlace(s)[0])
    expect(new Set(named).size).toBe(named.length)
    for (const g of PLACES) {
      expect(g.reason.length).toBeGreaterThan(0)
      expect(g.sites.length).toBeGreaterThan(0)
    }
  })

  it("every inventory function is found", () => {
    // `closure` кидає на корені, якого немає чи який неоднозначний.
    expect(inventory.roots).toHaveLength(INVENTORY.length)
  })
})

// ------------------------------------------------------------ самотест

const V: Anchors = {
  sync: "/v/sync/",
  owners: ["/v/session.ts"],
  scope: (file) => file.startsWith("/v/"),
  token: ["/v/types.ts", "GenerationToken", "valid"],
  childToken: ["/v/session.ts", "Session", "childToken"],
  commit: ["/v/session.ts", "Session", "commit"],
  unavailable: ["/v/session.ts", "VersionEpochs", "unavailable"],
  settle: ["/v/source.ts", "settle"],
  visible: ["/v/core.ts", "visible"],
  staleObjects: ["/v/core.ts", "staleObjects"],
  isClosed: ["/v/subsets.ts", "isClosed"],
  gate: ["/v/sync/flight.ts", "Gate"],
  gateState: ["/v/sync/flight.ts", "GateState"],
  brand: ["/v/sync/flight.ts", "FLIGHT"],
  flight: ["/v/sync/flight.ts", "Flight"],
  callbacks: [["/v/session.ts", "Session", "onFlush"]],
}

const FIXTURE = {
  "/v/types.ts": `export interface GenerationToken { readonly valid: boolean }\n`,
  "/v/session.ts": `import type { GenerationToken } from "./types.ts"
export interface VersionEpochs { unavailable(): boolean }
export interface Session {
  readonly versions: VersionEpochs
  token(): GenerationToken
  childToken(isValid: () => boolean): GenerationToken
  commit(fn: () => void, token: GenerationToken): boolean
  onFlush(fn: () => void): void
}
`,
  "/v/source.ts": `export function settle(apply: () => void): void { apply() }\n`,
  "/v/sync/flight.ts": `import type { GenerationToken } from "../types.ts"
declare const FLIGHT: unique symbol
export type Flight = { readonly site: string } & { readonly [FLIGHT]: true }
export interface GateState {
  readonly token: () => GenerationToken
  readonly staleObject?: (object: string) => boolean
}
export interface Gate {
  closed(): boolean
  staleObject(object: string): boolean
  discardBound(): boolean
  settledPastBound(): boolean
  tabHidden(): boolean
  refusal(object?: string): string | undefined
  timersRead(object: string): boolean
}
export declare function createGate(state: GateState): Gate
`,
  "/v/ctx.ts": `export interface Ctx {
  isStale(object: string): boolean
  hidden(): boolean
}
`,
  "/v/subsets.ts": `export function createRegistry() {
  const isClosed = () => false
  return { view: () => isClosed() }
}
`,
}

/** Ядро самотесту: стан умов, шлюз над ним і `body` у тілі `createCore`. */
const core = (body: string) => `import type { Session } from "./session.ts"
import type { Ctx } from "./ctx.ts"
import type { Flight } from "./sync/flight.ts"
import { createGate } from "./sync/flight.ts"
import { settle } from "./source.ts"
import { gone, quiet, use } from "./helper.ts"
export function createCore(session: Session) {
  const staleObjects = { has: (o: string) => o === "", add: (o: string) => {} }
  let visible = true
  const gate = createGate({
    token: () => session.token(),
    staleObject: (o) => staleObjects.has(o),
  })
${body}
}
`

function selfTest(body: string, extra: Record<string, string> = {}) {
  const sources: Record<string, string> = {
    ...FIXTURE,
    "/v/helper.ts": `import type { Session } from "./session.ts"
import type { Ctx } from "./ctx.ts"
export function gone(session: Session) { return !session.token().valid }
export function quiet() { return 0 }
export function use(ctx: Ctx) { return ctx.isStale("a") || ctx.hidden() }
`,
    "/v/core.ts": core(body),
    ...extra,
  }
  const analysis = analyze(
    inlineProgram(sources),
    Object.keys(sources),
    V,
    (f) => f.slice("/v/".length)
  )
  return {
    analysis,
    sites: analysis.sites.map(render).sort(),
    closure: (roots: readonly Root[], through = false) =>
      analysis
        .closure(roots, { throughSettlement: through })
        .findings.map(render)
        .sort(),
  }
}

const LOAD: Root = ["/v/core.ts", "load"]

describe("read gate guard self-test: each form", () => {
  it("an alias of the session token", () => {
    const t = selfTest(`  function load() {
    const token = session.token()
    const again = token
    return again.valid
  }`)
    expect(t.sites).toContain("core.ts::createCore.load token")
    expect(t.closure([LOAD])).toEqual(["core.ts::createCore.load token"])
  })

  it("destructuring of the token, the versions and the gate", () => {
    const t = selfTest(`  function load() {
    const { valid } = session.token()
    const { unavailable } = session.versions
    const { tabHidden } = gate
    return valid || unavailable() || tabHidden()
  }`)
    expect(t.closure([LOAD])).toEqual([
      "core.ts::createCore.load gate.tabHidden",
      "core.ts::createCore.load token",
      "core.ts::createCore.load unavailable",
    ])
  })

  it("a helper in another module, called transitively", () => {
    const t = selfTest(`  function step() { return gone(session) }
  function load() { return step() }`)
    expect(t.closure([LOAD])).toEqual(["helper.ts::gone token"])
    expect(t.analysis.closure([LOAD]).findings[0]!.path).toEqual([
      "core.ts::createCore.load",
      "core.ts::createCore.step",
      "helper.ts::gone",
    ])
  })

  it("a function passed through a context member is read at its call", () => {
    const t = selfTest(
      `  const ctx: Ctx = {
    isStale: (o) => staleObjects.has(o),
    hidden: gate.tabHidden,
  }
  const load = () => use(ctx)`
    )
    expect(t.sites).toEqual(
      expect.arrayContaining([
        "core.ts::createCore.ctx.isStale staleObjects",
        "core.ts::createCore.ctx.hidden gate.tabHidden",
        "helper.ts::use gate.tabHidden via Ctx.hidden",
        "helper.ts::use staleObjects via Ctx.isStale",
      ])
    )
    expect(t.closure([LOAD])).toEqual([
      "helper.ts::use gate.tabHidden via Ctx.hidden",
      "helper.ts::use staleObjects via Ctx.isStale",
    ])
  })
})

describe("read gate guard self-test: each occurrence counts", () => {
  // Перелік дозволяє одне читання токена в `startVersion` і в `dispatch`
  // (журнал після закриття); друге того ж виду — нова копія рішення
  // `closed` у функції інвентаря, і вона червоніє.
  const listed = new Map(
    [
      "core.ts::createCore.startVersion token",
      "core.ts::createCore.dispatch token",
    ].map(parsePlace)
  )
  const check = (startVersion: string, dispatch: string) =>
    mismatches(
      countOf(
        selfTest(`  function startVersion() {
${startVersion}
    return Promise.resolve().then(() => { if (token.valid) quiet() })
  }
  function dispatch() {
${dispatch}
    return Promise.resolve().catch(() => { if (session.token().valid) quiet() })
  }
  const token = session.token()`).analysis.closure([
          ["/v/core.ts", "startVersion"],
          ["/v/core.ts", "dispatch"],
        ]).findings
      ),
      listed
    )

  it("one listed read per function is green", () => {
    expect(check("", "")).toEqual([])
  })

  it("a second read of the same kind in startVersion is red", () => {
    expect(
      check("    if (!session.token().valid) return undefined", "")
    ).toEqual([
      "core.ts::createCore.startVersion token: found 2, listed 1 @15, @16",
    ])
  })

  it("a second read of the same kind in dispatch is red", () => {
    expect(
      check("", '    if (!session.token().valid) throw new Error("closed")')
    ).toEqual([
      "core.ts::createCore.dispatch token: found 2, listed 1 @19, @20",
    ])
  })

  it("a listed count above the reads is red too", () => {
    const t = selfTest(
      `  function startVersion() { return session.token().valid }`
    )
    expect(
      mismatches(
        countOf(t.analysis.closure([["/v/core.ts", "startVersion"]]).findings),
        new Map([parsePlace("core.ts::createCore.startVersion token ×2")])
      )
    ).toEqual(["core.ts::createCore.startVersion token: found 1, listed 2 @14"])
  })
})

describe("read gate guard self-test: what it passes", () => {
  it("the gate state, the writers, the commit and settle callbacks", () => {
    const t = selfTest(`  function load() {
    visible = false
    staleObjects.add("a")
    session.commit(() => {
      if (session.versions.unavailable()) gone(session)
    }, session.token())
    settle(() => staleObjects.has("a"))
    return gate.settledPastBound()
  }`)
    expect(t.sites.filter((s) => s.startsWith("core.ts"))).toEqual([
      "core.ts::createCore.load gate.settledPastBound",
    ])
    expect(t.closure([LOAD])).toEqual([
      "core.ts::createCore.load gate.settledPastBound",
    ])
    // Із заходом у колбеки осідання замикання бачить і їхніх викликаних.
    expect(t.closure([LOAD], true)).toEqual([
      "core.ts::createCore.load gate.settledPastBound",
      "helper.ts::gone token",
    ])
  })

  it("tells a child token, a read of visible and of isClosed", () => {
    const t = selfTest(`  function load() {
    const child = session.childToken(() => true)
    return child.valid && visible
  }`)
    expect(t.sites).toEqual([
      "core.ts::createCore.load child-token",
      "core.ts::createCore.load visible",
      "helper.ts::gone token",
      "subsets.ts::createRegistry.view isClosed",
    ])
  })

  it("flags the brand and a cast to Flight outside sync/", () => {
    const t = selfTest(`  const forged = { site: "K3" } as Flight`)
    expect(t.analysis.brand).toEqual(["core.ts:14 as Flight"])
  })

  it("a callback root is picked by what it calls, not by its name", () => {
    const t = selfTest(`  session.onFlush(() => { quiet() })
  session.onFlush(() => { gone(session) })`)
    expect(t.closure([["/v/core.ts", "onFlush", "gone"]])).toEqual([
      "helper.ts::gone token",
    ])
    expect(t.closure([["/v/core.ts", "onFlush", "quiet"]])).toEqual([])
    expect(() => t.closure([["/v/core.ts", "onFlush"]])).toThrow(/2 units/)
  })
})
