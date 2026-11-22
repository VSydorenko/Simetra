import {
  FUNCTIONS_FILE_SUFFIX,
  formatSqlFunctionsFile,
  sqlFunctionsFileSchema,
  type SqlFunctionDeclaration,
} from "simetra/model"
import { verbatimUnits } from "../compile"
import { diagnostic, type Diagnostic } from "../diagnostics"
import { FUNCTIONS_SCHEMA_FILE } from "../json-schema"
import { readFiles } from "../pipeline"
import { platformFormFunctions } from "../sql/declarations"
import { guardInsertionPoint } from "../sql/guard-of"
import { qualifiedName } from "../sql/identity"
import { loadSqlParser } from "../sql/parse"
import { loadPlpgsqlParser } from "../sql/plpgsql"
import { FUNCTION_CLASSES } from "../sql/units"
import {
  completeAndCompile,
  narrowDebt,
  withoutGeneratedGrants,
  type CompletionOptions,
} from "./fix"
import type { DeclareFunctionInput } from "./inputs"
import { toPlatformFormsAfter } from "./platform-forms"
import { compileInput, refused } from "./refuse"
import type { OperationResult } from "./types"

const SQL_SUFFIX = ".sql"

/**
 * Створює чи замінює запис декларації однієї функції в `<основа>.functions.json`
 * поруч із `.sql`, що її створює (спека декларацій функцій §5.6, Р1): повна
 * заміна `callers` і `check`, `id` наявного зберігається, новому його
 * видає операція. Режим `repair`, як у `addElement`: тека з помилками класу
 * ремонту приймається, а хвіст не дає додати нову — крім самої цілі, яка може
 * перейти в `check-not-applied` з причиною `firstStatement`, коли `fix`
 * гарантовано вставить запобіжник (`guardInsertionPoint`): інакше ланцюжок
 * `declare-function` → `fix` неможливий, бо недекларована функція, ставши
 * задекларованою, дістає новий ключ помилки.
 */
export async function declareFunction(
  files: ReadonlyMap<string, string>,
  input: DeclareFunctionInput,
  o: CompletionOptions
): Promise<OperationResult> {
  const clean = await compileInput(files, { repair: true })
  if (!clean.ok) return clean.result

  // Чиста компіляція (з режимом ремонту) гарантує проєкт.
  const { project, objects } = readFiles(files)
  const schema = input.function.schema ?? project!.defaultSchema
  const { name } = input.function
  const key = qualifiedName(schema, name)
  const at = (
    code: Parameters<typeof diagnostic>[0],
    file: string,
    extra: Record<string, string | number> = {}
  ): Diagnostic =>
    diagnostic(code, file, "", {
      schema,
      name,
      function: `${schema}.${name}`,
      ...extra,
    })

  // Функцію називає лише її `.sql`: ті самі правила резолву, що в компілятора
  // (`checkDeclarations`), але діагностики без файлу `.functions.json` — запису
  // ще немає, а місце для нього залежить від цього резолву.
  const units = await verbatimUnits(files)
  const named = units.filter(
    (u) =>
      FUNCTION_CLASSES.has(u.class) && u.schema === schema && u.name === name
  )
  if (named.length > 1) {
    return refused(files, [
      at("sql.declaration-overload", "", { count: named.length }),
    ])
  }
  const unit = named[0]
  if (unit === undefined || unit.class !== "function") {
    return refused(files, [
      at("sql.declaration-target-missing", "", { sqlFile: unit?.file ?? "" }),
    ])
  }
  const path = `${unit.file.slice(0, -SQL_SUFFIX.length)}${FUNCTIONS_FILE_SUFFIX}`

  // Форму платформи задають метадані, а запис її функції `toPlatformForms`
  // видалив би мовчки: запит автора зник би без сліду, тож відмова.
  const form = platformFormFunctions(objects, project).get(key)
  if (form !== undefined) {
    return refused(files, [
      at("sql.declaration-platform-form", path, { form: form.form }),
    ])
  }

  const text = files.get(path)
  const raw =
    text === undefined
      ? { $schema: o.schemaPath(path, FUNCTIONS_SCHEMA_FILE), functions: [] }
      : sqlFunctionsFileSchema.parse(JSON.parse(text))
  const same = (declaration: SqlFunctionDeclaration) =>
    qualifiedName(
      declaration.function.schema ?? project!.defaultSchema,
      declaration.function.name
    ) === key
  const previous = raw.functions.find(same)
  const record: SqlFunctionDeclaration = {
    id: previous?.id ?? o.newId(),
    ...input,
  }
  const changed = new Map(files)
  changed.set(
    path,
    formatSqlFunctionsFile({
      ...raw,
      functions: [...raw.functions.filter((d) => !same(d)), record],
    })
  )

  // Розширення права видно в результаті, а не лише в diff (Б4).
  const roles = input.callers.filter(
    (caller) => !(previous?.callers ?? []).includes(caller)
  )
  const notes: Diagnostic[] =
    roles.length === 0
      ? []
      : [
          at("sql.declaration-execute-widened", path, {
            roles: roles.join(", "),
          }),
        ]

  // Інші записи, що вже стали формами платформи, переходять тим самим
  // правилом, що в (г) `fix`: запис, перехід якого розширив би `EXECUTE`,
  // лишається — це рішення людини, а не побічний наслідок чужої декларації.
  // Ціль формою бути не може (відмова вище).
  const after = toPlatformFormsAfter(files, changed)

  // Виняток цілі: чи вставить `fix` запобіжник у це тіло.
  const [parse, plpgsql] = await Promise.all([
    loadSqlParser(),
    loadPlpgsqlParser(),
  ])
  const insertable =
    input.check !== undefined &&
    guardInsertionPoint(unit, input.check, units, plpgsql, parse) !== undefined
  const allow = (d: Diagnostic) =>
    insertable &&
    d.code === "sql.declaration-check-not-applied" &&
    d.params?.schema === schema &&
    d.params?.name === name &&
    d.params?.reason === "firstStatement"

  // Декларація віддає ACL функції платформі: дослівні гранти цілі стають
  // `sql.generated-grant`, тож їх вирізано тим самим кроком, що в `fix`
  // (лише цілі оператори, чужий грант у спільному операторі лишається).
  const narrowed = await narrowDebt(after.files, o.schemaPath)
  const withoutGrants = await withoutGeneratedGrants(narrowed)
  const prepared =
    withoutGrants === narrowed
      ? after.files
      : await narrowDebt(withoutGrants, o.schemaPath)

  return completeAndCompile(
    files,
    prepared,
    o,
    new Set([path]),
    clean.accepted,
    [...after.diagnostics, ...notes],
    allow
  )
}
