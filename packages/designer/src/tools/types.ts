import type { Diagnostic, FileChange } from "simetra/compiler"
import type { DatabaseProvider, SessionClaims } from "simetra/model"
import type { DbConnection } from "simetra/schema"
import type { CommandDatabase } from "simetra/server"
import type { z } from "zod"

/** Імена окремо від записів каталогу: `main.ts` реєструє лінощі підкоманди, не тягнучи компілятор. */
export const TOOL_NAMES = [
  "compile",
  "explain",
  "fix",
  "create",
  "add",
  "declare-function",
  "rename",
  "delete",
  "promote",
  "introspect",
  "diff",
  "plan",
  "apply",
  "roles",
  "rights-maintenance",
  "signals-config",
  "data-read",
  "data-command",
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/**
 * Каталог артефактів плану в корені проєкту, поруч із текою метаданих:
 * єдиний виняток із межі теки для запису (спека designer §3.2).
 */
export const PLANS_DIR = "plans"

/**
 * Дві осі замість одного ефекту: запис файлів (у git, лише після чистої
 * компіляції) і дія над базою (поза git) відрізняються незворотністю, тож
 * дозвіл і тертя для них різні. Масиви — для тестів повного добутку осей.
 *
 * Вісь файлів: `read` нічого не пише; `artifact` пише лише власні артефакти
 * в `plans/`, без перегляду `dryRun` і без зміни теки метаданих (`plan`,
 * `apply`): перегляду нема чого захищати, а в `apply` `dryRun` обійшов би
 * підтвердження; `write` змінює теку метаданих і має перегляд `dryRun`.
 * `--read-only` забороняє і `artifact`, і `write` (спека designer §3.2).
 */
export const FILES_ACCESS = ["read", "artifact", "write"] as const
export type FilesAccess = (typeof FILES_ACCESS)[number]
export const DATABASE_ACCESS = ["none", "read", "write"] as const
export type DatabaseAccess = (typeof DATABASE_ACCESS)[number]
/**
 * Третя вісь — дані застосунку в базі розробника через рантайм T3, окремо
 * від схеми (`database`): запис схеми й запис даних вирішують різні
 * прапорці запуску, бо агентові, що засіває тестові дані, не треба
 * змінювати схему, і навпаки (спека П4 §6.14).
 */
export const DATA_ACCESS = ["none", "read", "write"] as const
export type DataAccess = (typeof DATA_ACCESS)[number]

/** Відкрите підключення одного виклику: ціль і, за потреби, база для тіні. */
export interface DatabaseContext {
  target: DbConnection
  shadowBase?: DbConnection
  /** `host:port/db` без користувача й пароля — єдине, що можна показати. */
  describe: string
}

/**
 * Підключення — ресурс запуску, а не вхід інструмента: агент не може
 * спрямувати виклик на іншу базу. Лінивий — `connect` лише на виклик, тож
 * запуск без бази й інструменти без бази пулів не відкривають.
 */
export interface DatabaseResource {
  /** `host:port/db` без користувача й пароля. */
  describe: string
  connect(): Promise<DatabaseContext>
}

/** Відкрита сесія даних одного виклику: порт рантайму й claims користувача `--as`. */
export interface DataSession {
  database: CommandDatabase
  session: SessionClaims
  close(): Promise<void>
}

/**
 * Дані — теж ресурс запуску: рядок підключення й користувач `--as`
 * фіксуються при старті, тож агент не може ні змінити базу, ні діяти від
 * чужого імені. Лінивий, як `DatabaseResource`: з'єднання — лише на виклик.
 * Типи — лише `import type`: `main.ts` імпортує `TOOL_NAMES` звідси на
 * старті й не повинен тягнути ярус сервера.
 */
export interface DataResource {
  /** `host:port/db` без користувача й пароля. */
  describe: string
  /** UUID користувача, від імені якого діють інструменти даних. */
  as: string
  /** UUID агента для claim `act` (RFC 8693); прав не дає. */
  agent?: string
  open(provider: DatabaseProvider): Promise<DataSession>
}

/** Ресурс бази отримує лише інструмент, що оголосив вісь `database`. */
export interface ToolContext {
  dir: string
  /**
   * Корінь проєкту — батько теки метаданих (`dirname(resolve(dir))`): там
   * лежить `plans/`, і відносно нього `apply` читає артефакт.
   */
  root: string
  database?: DatabaseResource
  /** Лише інструменту з віссю `data`. */
  data?: DataResource
  /** Лише інструменту з `data: "write"`: дозвіл писати довідники прав. */
  allowRightsWrite?: boolean
  /** Вміст теки в `HEAD`: лише CLI його дає, MCP змін поза `fix` не перевіряє. */
  baseline?: ReadonlyMap<string, string>
}

/**
 * Зміни теки метаданих за віссю файлів: інструмент осі `artifact` (`plan`,
 * `apply`) їх мати не може — тип, а не перевірка після `run`, бо в `apply`
 * база вже змінена, коли `invoke` побачив би дефект.
 */
export type ChangesFor<F extends FilesAccess> = F extends "artifact"
  ? readonly []
  : FileChange[]

/** `run` лише читає теку й викликає операцію; запис робить `invoke`. */
export interface RunOutcome<D, F extends FilesAccess = FilesAccess> {
  ok: boolean
  /**
   * Мутація режиму `repair` прийняла результат з помилками лише класу
   * ремонту (`OperationResult.written`): `ok` лишається `false`, а `invoke`
   * пише `changes`.
   */
  written?: true
  changes: ChangesFor<F>
  diagnostics: Diagnostic[]
  data?: D
  refusal?: string
  /**
   * Відмова, яку вирішує `run` (їй потрібна модель), а текст будує `invoke`:
   * лише він знає `launchArgs` і канал, з яких складається підказка.
   */
  refusalReason?: "rights-write-disabled"
  /**
   * Файли поза текою метаданих — лише артефакти в `plans/` кореня проєкту
   * (план, запис промоції, звіт репетиції; спека designer §3.2). Пише їх
   * `invoke`, як і `changes`.
   */
  artifacts?: FileChange[]
}

/** Що бачить текстова частина подання: канал і вже відформатований звіт діагностики. */
export interface PresentationView {
  channel: "cli" | "mcp"
  ok: boolean
  written: boolean
  diagnostics: Diagnostic[]
  /** Діагностика текстом у мові й вигляді каналу. */
  report: string
}

/**
 * Як канали показують результат інструмента. Ознака живе в записі
 * інструмента, а не в гілці адаптера за іменем: новий інструмент додає поле,
 * CLI і MCP читають його однаково (спека designer §3.1: адаптери тонкі).
 * Без `present` інструмент показується загальним видом: зміни, діагностика,
 * `data` не показується.
 */
export interface Presentation<D = never> {
  /**
   * Результат у `--format json` — лише масив діагностики (`compile`);
   * текст — звіт. MCP цієї ознаки не читає.
   */
  diagnosticsOnly?: true
  /**
   * `data` — і є весь результат (`explain`), без обгортки `ok`/діагностики; лише
   * коли `ok`, інакше — загальний вид з діагностикою.
   */
  bare?: true
  /**
   * Поля `data` у структурованому результаті (JSON CLI, `structuredContent`
   * MCP). Типово — самі поля `data`; `promote` кладе запис під `record`.
   */
  structure?(data: D): Record<string, unknown>
  /**
   * Текст результату замість загальних рядків; `undefined` — загальний вид.
   * Викликається і без `data`: `plan` і `apply` показують відмову текстом.
   */
  text?(data: D | undefined, view: PresentationView): string | undefined
  /** Додаток після загальних рядків і звіту (`promote`: запис промоції). */
  appendix?(data: D, view: PresentationView): string
}

export interface Tool<
  I extends z.ZodType = z.ZodType,
  D = unknown,
  F extends FilesAccess = FilesAccess,
> {
  name: ToolName
  /** Англійською: MCP і `--help` беруть опис звідси. */
  description: string
  input: I
  files: F
  database: DatabaseAccess
  data: DataAccess
  destructive: boolean
  /**
   * Лише командний рядок: інший канал отримує відмову `cli-only`, а новий
   * канал не успадковує доступ до інструмента.
   */
  cliOnly?: true
  /** Подання `data` каналами; без поля `data` каналам не показується. */
  present?: Presentation<NoInfer<D>>
  run(ctx: ToolContext, input: z.infer<I>): Promise<RunOutcome<D, F>>
}

export type RefusalReason =
  | "invalid-input"
  | "read-only"
  | "database-write-disabled"
  | "no-database"
  | "unconfirmed"
  | "dry-run-unsupported"
  | "cli-only"
  | "data-write-disabled"
  | "rights-write-disabled"
  | "no-data"
  | "data-guard"
  | "refused"

export interface ToolResult<D = unknown> {
  ok: boolean
  written: boolean
  /**
   * Перегляд (`dryRun`) результату, який запуск без перегляду записав би:
   * при `ok: false` — прийнятий режимом `repair` (спека декларацій функцій
   * §5.1). Поза переглядом відсутній — там відповідає `written`.
   */
  wouldWrite?: true
  changes: { path: string; deleted: boolean }[]
  diagnostics: Diagnostic[]
  data?: D
  /** `detail` — стабільна причина відмови `data-guard`, щоб агент не розбирав текст. */
  refusal?: { reason: RefusalReason; message: string; detail?: string }
  /** Шляхи артефактів відносно кореня проєкту: записані чи (dry-run) ні. */
  artifacts?: string[]
}

export interface InvokeOptions {
  dir: string
  readOnly: boolean
  /**
   * Запис у базу (`database: "write"`): CLI вмикає його завжди — людина, що
   * запускає `apply`, і є рішенням, — а MCP лише з прапорцем запуску
   * `--allow-database-write`.
   */
  allowDatabaseWrite: boolean
  /**
   * Запис даних (`data: "write"`): як і запис у базу, CLI вмикає його
   * завжди, а MCP — лише з `--allow-data-write`. Необов'язковий, `undefined`
   * ≡ `false`: інструменти без осі даних прапорця не потребують.
   */
  allowDataWrite?: boolean
  /** Запис довідників прав інструментом даних; `undefined` ≡ `false`. */
  allowRightsWrite?: boolean
  dryRun: boolean
  confirmed: boolean
  /** Хто викликає: від цього залежить, як підказка радить дати підключення. */
  channel: "cli" | "mcp"
  database?: DatabaseResource
  /** Базовий стан для полів, призначених раз (див. `ToolContext.baseline`). */
  baseline?: ReadonlyMap<string, string>
  /**
   * Ім'я змінної середовища з рядком підключення, зафіксоване при запуску:
   * відмова без підключення має назвати саме її. Типово `SIMETRA_DATABASE_URL`.
   */
  databaseEnv?: string
  data?: DataResource
  /** Ім'я змінної даних, зафіксоване при запуску: його називає відмова `no-data`. */
  dataEnv?: string
  /** Argv запуску сервера: з нього будуються підказки про прапорці запуску. */
  launchArgs?: readonly string[]
}

/** Виводить типи входу й даних з аргументів, щоб записи не писали generics. */
export function defineTool<
  I extends z.ZodType,
  D = undefined,
  F extends FilesAccess = FilesAccess,
>(tool: Tool<I, D, F>): Tool<I, D, F> {
  return tool
}
