import { dirname, resolve, sep } from "node:path"
import type { FileChange } from "simetra/compiler"
import type { z } from "zod"
import { writeChanges } from "../io/metadata-dir"
import { UsageError } from "../io/usage-error"
import { queueFor } from "./queue"
import {
  DEFAULT_DATABASE_URL_ENV,
  databaseWriteHint,
  noDatabaseHint,
  readOnlyHint,
} from "./hints"
import {
  PLANS_DIR,
  type DatabaseAccess,
  type FilesAccess,
  type InvokeOptions,
  type RefusalReason,
  type Tool,
  type ToolResult,
} from "./types"

/**
 * Вичерпні switch по обох осях: нове значення осі не компілюється, доки не
 * вирішено його дозвіл. `--read-only` вимикає будь-який запис; запис у базу
 * ще й потребує рішення людини при запуску (`allowDatabaseWrite`), а власне
 * тертя (підтвердження з показаним планом) — ознака `destructive`.
 */
export function permits(
  tool: Tool,
  o: { readOnly: boolean; allowDatabaseWrite: boolean }
): boolean {
  const files: FilesAccess = tool.files
  const database: DatabaseAccess = tool.database
  let filesOk: boolean
  switch (files) {
    case "read":
      filesOk = true
      break
    // Артефакт у `plans/` — теж запис на диск: `--read-only` вимикає будь-який
    case "artifact":
    case "write":
      filesOk = !o.readOnly
      break
  }
  let databaseOk: boolean
  switch (database) {
    case "none":
    case "read":
      // Читання бази без дозволу: захисти — read-only сесія цілі й рядок
      // підключення лише із середовища запуску.
      databaseOk = true
      break
    case "write":
      databaseOk = !o.readOnly && o.allowDatabaseWrite
      break
  }
  return filesOk && databaseOk
}

/**
 * Артефакт пишеться лише в `plans/` кореня проєкту (спека designer §3.2);
 * будь-який інший шлях — помилка інструмента, і перевіряється вона до
 * першого запису.
 */
function checkArtifacts(root: string, artifacts: readonly FileChange[]): void {
  const plans = resolve(root, PLANS_DIR) + sep
  for (const a of artifacts) {
    // Артефакти лише додають файли: видалення через них зняло б плани з диска
    if (a.content === null)
      throw new UsageError(`An artifact must never delete a file: ${a.path}`)
    if (!resolve(root, a.path).startsWith(plans))
      throw new UsageError(
        `An artifact must be written under ${PLANS_DIR}/ next to the metadata directory: ${a.path}`
      )
  }
}

function refused<D>(reason: RefusalReason, message: string): ToolResult<D> {
  return {
    ok: false,
    written: false,
    changes: [],
    diagnostics: [],
    refusal: { reason, message },
  }
}

/**
 * Єдине місце рішень про розбір входу, дозволи, підтвердження й запис:
 * адаптери (CLI, MCP) лише переказують результат. Порядок має значення —
 * відмова на кожному кроці гарантує, що далі диск не чіпають.
 */
export async function invoke<D>(
  tool: Tool<z.ZodType, D>,
  input: unknown,
  o: InvokeOptions
): Promise<ToolResult<D>> {
  const parsed = tool.input.safeParse(input)
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) =>
        i.path.length === 0 ? i.message : `${i.path.join(".")}: ${i.message}`
      )
      .join("; ")
    return refused("invalid-input", message)
  }
  // Перегляд є лише в інструмента, що змінює теку метаданих. Канали `dryRun`
  // іншим не дають, але `invoke` на них не покладається: проігнорований
  // прапорець разом із `confirm` застосував би план, хоча просили подивитися
  if (o.dryRun && tool.files !== "write")
    return refused(
      "dry-run-unsupported",
      tool.name === "apply"
        ? "apply has no dry run: it writes the database, not files. To run the plan and roll it back, rehearse it. Nothing changed."
        : `${tool.name} has no dry run: only tools that change the metadata directory preview their changes. Nothing changed.`
    )
  if (!permits(tool, o))
    // Коли заважає лише прапорець запису в базу, підказка називає саме його:
    // `--read-only` вимикає запис у базу завжди, і тоді радити прапорець марно
    return permits(tool, { ...o, allowDatabaseWrite: true })
      ? refused(
          "database-write-disabled",
          databaseWriteHint(o.launchArgs, { tools: tool.name })
        )
      : refused("read-only", readOnlyHint(o.launchArgs))
  if (tool.database !== "none" && o.database === undefined)
    return refused(
      "no-database",
      noDatabaseHint(o.databaseEnv ?? DEFAULT_DATABASE_URL_ENV, o.channel)
    )
  // Dry-run нічого не пише, тож підтвердження там нічого не захищає, а агентові
  // перегляд потрібен саме до `confirm`. Сюди `dryRun` доходить лише в
  // інструмента запису файлів (відмова вище)
  if (tool.destructive && !o.dryRun && !o.confirmed) {
    return refused(
      "unconfirmed",
      `${tool.name} is destructive and needs confirmation. Nothing changed.`
    )
  }
  // Корінь — від абсолютного шляху: для `dir = "."` наївний `dirname` дав
  // би саму теку метаданих, і `plans/` опинився б у ній
  const root = dirname(resolve(o.dir))
  return queueFor(o.dir)(async () => {
    try {
      // Інструмент без осі бази ресурсу не бачить, тож і не відкриє пулу.
      const outcome = await tool.run(
        {
          dir: o.dir,
          root,
          ...(tool.database === "none" ? {} : { database: o.database }),
          ...(o.baseline === undefined ? {} : { baseline: o.baseline }),
        },
        parsed.data
      )
      const artifacts = outcome.artifacts ?? []
      checkArtifacts(root, artifacts)
      // Вичерпно по осі файлів: зміни теки — лише `write` поза переглядом;
      // артефакти — `write` поза переглядом і `artifact` завжди (перегляду
      // в нього немає)
      let write = false
      let writeArtifacts = false
      const files: FilesAccess = tool.files
      switch (files) {
        case "read":
          break
        case "artifact":
          // Інструмент лише артефактів, що змінює теку, — дефект інструмента:
          // його `--read-only` і перегляд вирішено під «нічого в теці»
          if (outcome.changes.length > 0)
            throw new Error(
              `${tool.name} is an artifact tool and must not change the metadata directory`
            )
          writeArtifacts = outcome.ok && artifacts.length > 0
          break
        case "write":
          write = outcome.ok && !o.dryRun && outcome.changes.length > 0
          writeArtifacts = outcome.ok && !o.dryRun && artifacts.length > 0
          break
      }
      // Артефакти — до змін теки: записаний запис промоції без змін теки
      // інертний (план відмовить, повторний `promote` перезапише його), а
      // зміни теки без запису не відновити — `promote` вдруге не запуститься,
      // бо об'єкт уже вид (рішення 1 плану П3-2a).
      if (writeArtifacts) await writeChanges(root, artifacts)
      if (write) await writeChanges(o.dir, outcome.changes)
      return {
        ok: outcome.ok,
        written: write || writeArtifacts,
        changes: outcome.changes.map((c) => ({
          path: c.path,
          deleted: c.content === null,
        })),
        diagnostics: outcome.diagnostics,
        ...(outcome.data === undefined ? {} : { data: outcome.data }),
        ...(outcome.artifacts === undefined
          ? {}
          : { artifacts: outcome.artifacts.map((a) => a.path) }),
        ...(outcome.refusal === undefined
          ? {}
          : { refusal: { reason: "refused", message: outcome.refusal } }),
      } satisfies ToolResult<D>
    } catch (error) {
      // Лише помилки використання; решта — баги й летять далі.
      if (error instanceof UsageError) return refused("refused", error.message)
      throw error
    }
  })
}
