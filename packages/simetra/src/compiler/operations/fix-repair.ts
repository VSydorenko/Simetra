import {
  PROVIDER_API_ROLES,
  PROVIDER_OWNER_ROLES,
  formatSqlFunctionsFile,
  quoteIdent,
  sqlFunctionsFileSchema,
  type DatabaseProvider,
} from "simetra/model"
import { verbatimUnits } from "../compile"
import { metadataRights, readFiles } from "../pipeline"
import type { Diagnostic } from "../diagnostics"
import {
  PROVIDER_DEFAULT_PRIVILEGE_SCHEMAS,
  checkedContract,
} from "../sql/declarations"
import { guardFunctionOf, guardInsertionPoint } from "../sql/guard-of"
import { qualifiedName } from "../sql/identity"
import { loadSqlParser } from "../sql/parse"
import { loadPlpgsqlParser } from "../sql/plpgsql"
import { applyEdits, type TextEdit } from "../sql/rewrite/renames"
import { FUNCTION_CLASSES } from "../sql/units"
import { sqlLiteral } from "../stages/model"
import { cut, mergeDeletions } from "./text-edits"

/**
 * Кроки (а), (в), (д) `fix` у режимі ремонту (спека декларацій функцій §5.6).
 * Кожен лише дописує те, що доводить `guardOf` чи вирізає позначену
 * діагностикою інструкцію; підсумок судить компіляція.
 */

/** (а) `id` усім записам `.functions.json`, що його не мають. */
export function withFunctionIds(
  files: ReadonlyMap<string, string>,
  newId: () => string
): Map<string, string> {
  const result = new Map(files)
  for (const path of [...files.keys()].sort()) {
    if (!path.endsWith(".functions.json")) continue
    let json: unknown
    try {
      json = JSON.parse(files.get(path)!)
    } catch {
      continue
    }
    // Файл не тієї форми лишається як є: причину назве компіляція.
    const parsed = sqlFunctionsFileSchema.safeParse(json)
    if (!parsed.success || parsed.data.functions.every((f) => f.id)) continue
    result.set(
      path,
      formatSqlFunctionsFile({
        ...parsed.data,
        functions: parsed.data.functions.map((f) => ({
          ...f,
          id: f.id ?? newId(),
        })),
      })
    )
  }
  return result
}

/**
 * Відступ вставки: той самий рядок — пробіл, інакше новий рядок з відступом
 * наступного рядка тіла.
 */
function insertionText(
  sql: string,
  at: number,
  statement: string,
  eol: string
): string {
  const rest = sql.slice(at)
  const lineEnd = rest.search(/\r?\n/)
  if (lineEnd < 0 || rest.slice(0, lineEnd).trim() !== "") {
    return ` ${statement}`
  }
  const next = rest.slice(lineEnd).replace(/^\r?\n/, "")
  const indent = /^[ \t]*/.exec(next)![0]
  return `${eol}${indent}${statement}`
}

/**
 * Місце одиниці в тексті файлу. `unit.sql` має кінці рядків `\n` (читач
 * ділить файл за `\r?\n`) і лічить рядки маскованого тексту, тож зсуви
 * `statementPositions` на файлі з CRLF чи з блоками рухів до оригіналу не
 * підходять: початок шукається за рядком одиниці, кінець — проходом із
 * пропуском `\r` перед `\n`. `at` — зсув у `unit.sql`, який треба перенести.
 * Копія першого рядка одиниці в коментарі чи рядковому літералі того ж рядка
 * (до справжнього початку) не підміняє місця: кандидат береться лише коли
 * увесь текст одиниці збігся від нього, а коли таких кілька — відмова, бо
 * правка не в тому місці гірша за відсутню.
 */
export function locateUnit(
  text: string,
  unit: { line: number; sql: string },
  at = 0
): { start: number; end: number; at: number } | undefined {
  let lineStart = 0
  for (let n = 1; n < unit.line; n++) {
    const newline = text.indexOf("\n", lineStart)
    if (newline < 0) return undefined
    lineStart = newline + 1
  }
  const lineEnd = text.indexOf("\n", lineStart)
  const first = unit.sql.split("\n")[0]!
  const found: { start: number; end: number; at: number }[] = []
  for (
    let from = text.indexOf(first, lineStart);
    from >= 0 && (lineEnd < 0 || from < lineEnd);
    from = text.indexOf(first, from + 1)
  ) {
    const place = matchUnit(text, from, unit.sql, at)
    if (place !== undefined) found.push(place)
  }
  return found.length === 1 ? found[0] : undefined
}

/** Прохід `sql` по тексту від `start` із пропуском `\r` перед `\n`. */
function matchUnit(
  text: string,
  start: number,
  sql: string,
  at: number
): { start: number; end: number; at: number } | undefined {
  let i = start
  let mapped = start
  for (let j = 0; j < sql.length; j++) {
    if (j === at) mapped = i
    if (text[i] === "\r" && text[i + 1] === "\n" && sql[j] === "\n") {
      i++
    }
    if (text[i] !== sql[j]) return undefined
    i++
  }
  if (at >= sql.length) mapped = i
  return { start, end: i, at: mapped }
}

/**
 * Оператор запобіжника: дія й мітка — літерали (мітка може містити апостроф),
 * ціль — ім'я параметра чи `NULL`.
 */
export function guardStatement(
  guard: { schema: string; name: string },
  action: string,
  kindLabel: string,
  target: string | undefined
): string {
  const call = `${quoteIdent(guard.schema)}.${quoteIdent(guard.name)}`
  const last = target === undefined ? "NULL" : quoteIdent(target)
  return `PERFORM ${call}(${sqlLiteral(action)}, ${sqlLiteral(kindLabel)}, ${last});`
}

/**
 * (в) Вставляє `PERFORM simetra.rights_require[_scope](<дія>, <мітка>, <ціль>)`
 * першим оператором зовнішнього блоку функцій, чий `check-not-applied` має
 * причину `firstStatement` і чиє тіло безпечно доповнюється
 * (`guardInsertionPoint`). Аргументи — лише з `check` і контракту прав.
 */
export async function insertGuards(
  files: Map<string, string>,
  flagged: readonly Diagnostic[]
): Promise<Map<string, string>> {
  const targets = flagged.filter(
    (d) =>
      d.code === "sql.declaration-check-not-applied" &&
      d.params?.reason === "firstStatement"
  )
  if (targets.length === 0) return files
  const { project, objects, functionsFiles } = readFiles(files)
  const rights = metadataRights(files)?.rights
  if (project === undefined || rights === undefined) return files
  const [units, parse, plpgsql] = await Promise.all([
    verbatimUnits(files),
    loadSqlParser(),
    loadPlpgsqlParser(),
  ])
  const declarations = functionsFiles.flatMap((f) => f.functions)
  const edits = new Map<string, TextEdit[]>()
  for (const d of targets) {
    const key = qualifiedName(String(d.params?.schema), String(d.params?.name))
    const unit = units.find(
      (u) =>
        u.file === d.file &&
        FUNCTION_CLASSES.has(u.class) &&
        qualifiedName(u.schema ?? "", u.name ?? "") === key
    )
    const check = declarations.find(
      (x) =>
        qualifiedName(
          x.function.schema ?? project.defaultSchema,
          x.function.name
        ) === key
    )?.check
    if (unit === undefined || check === undefined) continue
    const contract = checkedContract(check, objects, rights)
    const action = contract?.actions.find((a) => a.name === check.action)
    if (contract === undefined || action === undefined) continue
    const at = guardInsertionPoint(unit, check, units, plpgsql, parse)
    const text = files.get(unit.file)
    if (at === undefined || text === undefined) continue
    const place = locateUnit(text, unit, at)
    if (place === undefined) continue
    const guard = guardFunctionOf(check)
    const target = check.row ?? check.scope
    const statement = guardStatement(
      guard,
      action.action,
      contract.kindLabel,
      target
    )
    edits.set(unit.file, [
      ...(edits.get(unit.file) ?? []),
      {
        start: place.at,
        end: place.at,
        text: insertionText(
          unit.sql,
          at,
          statement,
          text.includes("\r\n") ? "\r\n" : "\n"
        ),
      },
    ])
  }
  const result = new Map(files)
  for (const [file, list] of edits) {
    result.set(file, applyEdits(files.get(file)!, list))
  }
  return result
}

interface AdpTree {
  options?: {
    DefElem?: { defname?: string; arg?: { List?: { items?: AdpItem[] } } }
  }[]
  action?: {
    grantees?: { RoleSpec?: { roletype?: string; rolename?: string } }[]
  }
}
interface AdpItem {
  String?: { sval?: string }
  RoleSpec?: { roletype?: string; rolename?: string }
}

/**
 * (д) Вирізає цілу інструкцію `ALTER DEFAULT PRIVILEGES … ON FUNCTIONS`,
 * яку позначив `sql.default-privileges-execute` (Р7). Лишає: інструкцію
 * власника провайдера в керованій схемі з пресетом серед отримувачів (її
 * вирізання зняло б і пресет) та глобальну, що має отримувача поза `PUBLIC` і
 * ролями API: плану її не відкликати, тож вирізання лишило б право в базі.
 */
export async function cutDefaultPrivileges(
  files: Map<string, string>,
  flagged: readonly Diagnostic[],
  provider: DatabaseProvider
): Promise<Map<string, string>> {
  const targets = flagged.filter(
    (d) => d.code === "sql.default-privileges-execute"
  )
  if (targets.length === 0) return files
  const units = await verbatimUnits(files)
  const owner = PROVIDER_OWNER_ROLES[provider]
  const api = new Set(
    Object.values(PROVIDER_API_ROLES[provider]).filter(
      (r): r is string => typeof r === "string"
    )
  )
  const managed = PROVIDER_DEFAULT_PRIVILEGE_SCHEMAS[provider]
  const edits = new Map<string, TextEdit[]>()
  for (const d of targets) {
    const unit = units.find(
      (u) =>
        u.file === d.file &&
        u.line === d.params?.line &&
        u.identity === d.params?.name
    )
    const text = files.get(d.file)
    if (unit === undefined || text === undefined) continue
    const stmt = (unit.tree as { AlterDefaultPrivilegesStmt?: AdpTree })
      .AlterDefaultPrivilegesStmt
    if (stmt === undefined) continue
    const items = (name: string) =>
      (stmt.options ?? []).flatMap(({ DefElem: e }) =>
        e?.defname === name ? (e.arg?.List?.items ?? []) : []
      )
    const schemas = items("schemas").map((i) => i.String?.sval ?? "")
    const roles = items("roles").map((i) =>
      i.RoleSpec?.roletype === "ROLESPEC_CSTRING"
        ? (i.RoleSpec.rolename ?? "")
        : ""
    )
    const grantees = stmt.action?.grantees ?? []
    const isPreset = (spec: { roletype?: string; rolename?: string }) =>
      spec.roletype === "ROLESPEC_CSTRING" &&
      (spec.rolename === owner || api.has(spec.rolename ?? ""))
    if (
      schemas.length > 0 &&
      schemas.some((s) => managed.includes(s)) &&
      roles.every((r) => r === owner) &&
      grantees.some(
        ({ RoleSpec: spec }) => spec !== undefined && isPreset(spec)
      )
    ) {
      continue
    }
    if (
      schemas.length === 0 &&
      !grantees.every(
        ({ RoleSpec: spec }) =>
          spec !== undefined &&
          (spec.roletype === "ROLESPEC_PUBLIC" ||
            (spec.roletype === "ROLESPEC_CSTRING" &&
              api.has(spec.rolename ?? "")))
      )
    ) {
      continue
    }
    const place = locateUnit(text, unit)
    if (place === undefined) continue
    edits.set(d.file, [
      ...(edits.get(d.file) ?? []),
      cut(text, place.start, place.end),
    ])
  }
  const result = new Map(files)
  for (const [file, list] of edits) {
    const text = files.get(file)!
    const after = applyEdits(text, mergeDeletions(text, list))
    if (after.trim() === "") result.delete(file)
    else result.set(file, after)
  }
  return result
}
